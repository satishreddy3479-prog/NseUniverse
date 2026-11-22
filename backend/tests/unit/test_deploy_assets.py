# ruff: noqa: E501
"""The built files a release keeps from the one before it (deploy/update.sh: keep_assets, dedupe_assets).

Found on 22 Nov 2026: each release held a full COPY of every kept file, 3 releases x 139 MB, and the files were kept 14 days, so the server's releases grew from 33 MB to 449 MB in 15 days.
They are hard links now (one copy however many releases hold a file) and are kept 7 days.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

UPDATE = Path(__file__).resolve().parents[3] / "deploy" / "update.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="bash is needed to run the deploy script")


def run(snippet: str) -> subprocess.CompletedProcess[str]:
    # the script is loaded for its functions only (NSE_UPDATE_LIB=1), as the tests of the other deploy scripts load theirs
    script = f'set -Eeuo pipefail; NSE_UPDATE_LIB=1 source "{UPDATE.as_posix()}"; {snippet}'
    return subprocess.run([BASH or "bash", "-c", script], capture_output=True, text=True, check=False)  # noqa: S603


def release(root: Path, name: str, files: dict[str, str]) -> Path:
    assets = root / "releases" / name / "frontend" / "dist" / "assets"
    assets.mkdir(parents=True)
    for f, body in files.items():
        (assets / f).write_text(body)
    return root / "releases" / name


def same_file(a: Path, b: Path) -> bool:
    return a.exists() and b.exists() and os.path.samefile(a, b)


def test_a_new_release_keeps_the_old_files_as_links_not_copies(tmp_path: Path) -> None:
    old = release(tmp_path, "old", {"Page-aaa.js": "old page", "shared-bbb.js": "shared"})
    new = release(tmp_path, "new", {"Page-ccc.js": "new page", "shared-bbb.js": "shared"})
    out = run(f'keep_assets "{old.as_posix()}" "{new.as_posix()}" 7')
    assert out.returncode == 0, out.stderr
    n_assets, o_assets = new / "frontend/dist/assets", old / "frontend/dist/assets"
    assert (n_assets / "Page-aaa.js").read_text() == "old page" and (n_assets / "Page-ccc.js").read_text() == "new page"  # a tab from before the deploy can still load its page
    assert same_file(n_assets / "Page-aaa.js", o_assets / "Page-aaa.js")  # one copy on disk, two names
    assert os.stat(o_assets / "Page-aaa.js").st_nlink == 2


def test_a_file_of_the_new_build_is_never_replaced_by_an_old_one(tmp_path: Path) -> None:
    old = release(tmp_path, "old", {"same-name.js": "OLD"})
    new = release(tmp_path, "new", {"same-name.js": "NEW"})
    assert run(f'keep_assets "{old.as_posix()}" "{new.as_posix()}" 7').returncode == 0
    assert (new / "frontend/dist/assets/same-name.js").read_text() == "NEW"
    assert not same_file(new / "frontend/dist/assets/same-name.js", old / "frontend/dist/assets/same-name.js")


def test_files_older_than_the_limit_go_from_the_new_release_only(tmp_path: Path) -> None:
    old = release(tmp_path, "old", {"ancient-aaa.js": "x", "recent-bbb.js": "y"})
    nine_days = time.time() - 9 * 86400
    os.utime(old / "frontend/dist/assets/ancient-aaa.js", (nine_days, nine_days))
    new = release(tmp_path, "new", {"Page-ccc.js": "new"})
    assert run(f'keep_assets "{old.as_posix()}" "{new.as_posix()}" 7').returncode == 0
    assert not (new / "frontend/dist/assets/ancient-aaa.js").exists() and (new / "frontend/dist/assets/recent-bbb.js").exists()
    assert (old / "frontend/dist/assets/ancient-aaa.js").exists()  # the running release is not touched
    assert (new / "frontend/dist/assets/Page-ccc.js").exists()  # the new build's own files are never dropped


def test_a_missing_old_release_is_not_an_error(tmp_path: Path) -> None:
    new = release(tmp_path, "new", {"Page-ccc.js": "new"})
    assert run(f'keep_assets "{tmp_path.as_posix()}/nothing" "{new.as_posix()}" 7').returncode == 0
    assert (new / "frontend/dist/assets/Page-ccc.js").exists()


def test_releases_that_hold_separate_copies_come_to_share_one(tmp_path: Path) -> None:
    a = release(tmp_path, "a", {"EChart-1.js": "big chunk", "Page-a.js": "a", "differs.js": "A version"})
    b = release(tmp_path, "b", {"EChart-1.js": "big chunk", "Page-b.js": "b", "differs.js": "B version"})
    newest = release(tmp_path, "c", {"EChart-1.js": "big chunk", "Page-c.js": "c", "differs.js": "C version"})
    out = run(f'dedupe_assets "{tmp_path.as_posix()}" "{newest.as_posix()}"')
    assert out.returncode == 0, out.stderr
    n = newest / "frontend/dist/assets"
    assert same_file(a / "frontend/dist/assets/EChart-1.js", n / "EChart-1.js") and same_file(b / "frontend/dist/assets/EChart-1.js", n / "EChart-1.js")
    assert (a / "frontend/dist/assets/differs.js").read_text() == "A version" and not same_file(a / "frontend/dist/assets/differs.js", n / "differs.js")  # different bytes: left alone
    assert (a / "frontend/dist/assets/Page-a.js").read_text() == "a" and os.stat(a / "frontend/dist/assets/Page-a.js").st_nlink == 1  # a file only the old release has stays its own
    assert run(f'dedupe_assets "{tmp_path.as_posix()}" "{newest.as_posix()}"').returncode == 0  # safe to run again


@pytest.mark.skipif(shutil.which("flock") is None, reason="flock (Linux) is needed to run the script itself")
def test_the_script_still_runs_as_a_script_when_the_library_switch_is_not_set(tmp_path: Path) -> None:
    # with no GitHub reachable and an empty root the script must reach its first check and stop quietly, not trip over the helper section
    env = {"NSE_ROOT": str(tmp_path / "root"), "NSE_REPO_URL": str(tmp_path / "no-such-repo"), "NSE_TEST_MODE": "1", "PATH": os.environ.get("PATH", "")}
    out = subprocess.run([BASH or "bash", str(UPDATE)], capture_output=True, text=True, env=env, check=False)  # noqa: S603
    assert out.returncode == 0 and "GitHub not reachable" in out.stdout
