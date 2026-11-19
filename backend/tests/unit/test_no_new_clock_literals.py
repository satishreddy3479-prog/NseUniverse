"""No new closing-time literals in the backend: the schedule lives in ``app/domain/session.py``.

The session close and the closing auction moved on 3 Aug 2026 and move again on 7 Dec 2026 (15:15 to 15:30, F&O 15:40 to 15:45). Fifteen places carried their own 15:xx clock time and each
had to be found by hand. This ratchet counts the literals per file: a new one fails the test, so the next change of the schedule is made in one place. A file may keep a literal that is
not the session schedule (the paper trader's 15:20 exit, a foreign exchange's hours); lower its number when one goes, and raise it only with a reason in the commit.
"""

from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
PATTERN = re.compile(r"""\btime\(\s*15\s*,\s*(?:15|20|25|30|31|35|40|45|50|55)\b|\(\s*15\s*,\s*(?:15|20|25|30|31|35|40|45)\s*\)|["']15:(?:15|20|25|30|31|35|40|45|50|55)(?::\d\d)?["']""")

# literals that exist today; domain/session.py is the schedule itself
BASELINE: dict[str, int] = {
    "api/routes.py": 2,  # the default exit time of a replayed or modelled straddle (a parameter of the experiment, not the session schedule): the Entry Lab and the decay-probability routes
    "domain/session.py": 15,
    "domain/spot_check.py": 1,  # EXPIRY_CLOSE: the expiring index contracts stop at 15:30 in both schedules
    "forward/service.py": 1,  # the paper trader's 15:20 exit
    "intelligence/entry_lab.py": 1,  # the default exit time of a replayed rule (a parameter of the experiment, not the session schedule)
    "intelligence/context_signals.py": 1,  # the previous NIFTY close (15:30) the overnight move is measured from
    "intelligence/decay_calibration.py": 2,  # the default exit time of the replay and of the structure study (a parameter of the experiment, not the session schedule)
    "intelligence/straddle_service.py": 1,  # the default exit time of the decay-probability question (a parameter, not the session schedule)
    "globalmkts/service.py": 1,  # polling cadence window
    "globalmkts/symbols.py": 3,  # other exchanges' hours (GIFT Nifty, Nikkei, KOSPI)
    "intraday/price_structure.py": 1,  # opening-range minutes (15, 30), not a clock time
    "lifecycle/eod.py": 1,  # the end-of-day run time
    "lifecycle/session_close.py": 1,  # the window in which the feed's "closed" message is read
    "prediction/sources/yahoo.py": 2,  # daily-bar completeness times
    "strategy/automation.py": 5,  # the default auto-close time and the rule's own bounds
    "swing/live_rules.py": 1,
    "swing/minute_shadow.py": 1,
}


def count(path: Path) -> int:
    return sum(len(PATTERN.findall(line.split("#")[0])) for line in path.read_text(encoding="utf-8").splitlines())


def test_the_closing_schedule_is_not_copied_into_new_places() -> None:
    found = {p.relative_to(APP).as_posix(): count(p) for p in sorted(APP.rglob("*.py"))}
    found = {k: v for k, v in found.items() if v}
    grew = {k: (v, BASELINE.get(k, 0)) for k, v in found.items() if v > BASELINE.get(k, 0)}
    assert not grew, (
        f"new 15:xx clock literals (file: found, allowed): {grew}. The session close and the closing auction come from app.domain.session "
        "(session_close(), closing_schedule(day)); if this is a different clock, add it to BASELINE with the reason."
    )


def test_the_baseline_does_not_keep_literals_that_are_gone() -> None:
    found = {p.relative_to(APP).as_posix(): count(p) for p in sorted(APP.rglob("*.py"))}
    stale = {k: (BASELINE[k], found.get(k, 0)) for k in BASELINE if found.get(k, 0) < BASELINE[k]}
    assert not stale, f"literals went away: lower these numbers in BASELINE (file: allowed, found): {stale}"
