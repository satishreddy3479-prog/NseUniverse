"""The deploy guard keeps a new commit from restarting the live stream while the market trades (deploy/deploy-guard.sh).

A deploy restarts the backend: about a minute of lost option-chain samples and one-second candles. On 19 Nov 2026 two deploys went out in market hours on the owner's instruction;
the rule ("push after 15:40") used to rest on discipline alone.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

GUARD = Path(__file__).resolve().parents[3] / "deploy" / "deploy-guard.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="bash is needed to run the deploy script")


def verdict(now: str, tmp_path: Path, holidays: str = "", allow: bool = False, **env: str) -> str:
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    if allow:
        (state / "allow-market-hours-deploy").write_text("")
    e = {"NSE_STATE": str(state), "NSE_NOW_IST": now, "NSE_HOLIDAYS": holidays, "PATH": "/usr/bin:/bin"} | env
    out = subprocess.run([BASH or "bash", str(GUARD)], capture_output=True, text=True, env=e, check=False)  # noqa: S603
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


@pytest.mark.parametrize("now", ["2026-11-19 4 0855", "2026-11-19 4 0914", "2026-11-19 4 1130", "2026-11-19 4 1540", "2026-11-19 4 1549"])
def test_a_weekday_deploy_waits_while_the_market_trades(now: str, tmp_path: Path) -> None:
    out = verdict(now, tmp_path)
    assert out.startswith("hold") and "allow-market-hours-deploy" in out  # the way to let one through is in the message


@pytest.mark.parametrize("now", ["2026-11-19 4 0854", "2026-11-19 4 1550", "2026-11-19 4 1805", "2026-11-19 4 0030", "2026-11-21 6 1130", "2026-11-22 7 1000"])
def test_before_the_pre_open_after_the_close_and_on_weekends_it_goes(now: str, tmp_path: Path) -> None:
    assert verdict(now, tmp_path).startswith("go")  # 15:50 is the first minute after the held window; Saturday and Sunday are never held


def test_an_exchange_holiday_is_not_held(tmp_path: Path) -> None:
    assert verdict("2026-11-19 4 1130", tmp_path, holidays="2026-11-19 2026-12-25").startswith("go (exchange holiday")
    assert verdict("2026-11-20 5 1130", tmp_path, holidays="2026-11-19 2026-12-25").startswith("hold")  # the next day is a trading day


def test_the_owner_can_let_one_deploy_through_and_the_guard_can_be_switched_off(tmp_path: Path) -> None:
    assert "owner allowed" in verdict("2026-11-19 4 1130", tmp_path, allow=True)
    assert verdict("2026-11-19 4 1130", tmp_path / "other", NSE_DEPLOY_GUARD="0").startswith("go (guard switched off")
    assert verdict("2026-11-19 4 1130", tmp_path / "third", NSE_HOLD_TO="1200").startswith("hold")  # the window is configurable


def test_the_update_script_asks_the_guard_and_consumes_the_override() -> None:
    text = (GUARD.parent / "update.sh").read_text(encoding="utf-8")
    assert "nse-universe-deploy-guard" in text and 'hold*)' in text and "rm -f \"$STATE/allow-market-hours-deploy\"" in text
    # the guard is asked after the cheap 'nothing new' check and before anything is built or restarted
    assert text.index("deploy-guard") < text.index("log \"deploying $remote") and text.index('[ "$remote" = "$deployed" ] && exit 0') < text.index("GUARD_BIN=")
    boot = (GUARD.parent / "bootstrap.sh").read_text(encoding="utf-8")
    assert "deploy-guard.sh" in boot and "deploy-guard:nse-universe-deploy-guard" in text  # installed at bootstrap and refreshed after every healthy deploy
