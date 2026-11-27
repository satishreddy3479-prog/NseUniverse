"""Open files of this process, so a leak shows up as a number before it takes the server down (27 Nov 2026: connections left open filled the 1,024-file limit and every database call failed)."""

from __future__ import annotations

import os


def open_files() -> dict[str, int | None]:
    """The count of open files and the limit; both None where the platform has no /proc (the Windows development machine)."""
    try:
        used: int | None = len(os.listdir("/proc/self/fd"))
    except OSError:
        return {"open_files": None, "open_files_limit": None}
    try:
        import resource

        limit: int | None = resource.getrlimit(resource.RLIMIT_NOFILE)[0]  # type: ignore[attr-defined,unused-ignore]
    except (ImportError, ValueError, OSError):
        limit = None
    return {"open_files": used, "open_files_limit": limit}
