"""NIFTY current-month future through a session: price against the index (basis), open interest, volume.

Built only from what was recorded: the minute "fut" samples of the market service (price, cumulative volume,
open interest, the index level at the same moment, the contract and its expiry). A value that was not recorded
stays missing (never zero). Older samples without the index level join the nearest stored option-chain snapshot
within 90 seconds and say so.

Basis (the gap), as institutions quote it:
  basis        = future - index                          (points)
  basis %      = basis / index
  carry p.a.   = ln(future / index) / T                  the annualised cost of carry the market is paying, T in years
                                                          of 365 days to the expiry close (same convention as the option model)
  fair basis   = index x (e^(r T) - 1)                   what financing alone would justify at an assumed rate r (no dividends)
  vs fair      = basis - fair basis                      positive: the future is rich to financing, negative: cheap
OI change is OI now minus the previous session's last OI of the same contract (the open if that is not recorded);
OI per minute is the change since the previous recorded OI value.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import session_close
from app.market.store import MarketStore
from app.storage.observations import ObservationStore, to_ms

IST = ZoneInfo("Asia/Kolkata")
YEAR_DAYS = 365.0
OI_JUMP = 0.01  # a one-minute OI move above 1 % is flagged

DEFINITIONS = {
    "basis": "Future minus the index, in points, at the same moment.",
    "basis_pct": "Basis as a percentage of the index.",
    "carry_pct": "Annualised cost of carry implied by the basis: ln(future / index) / T, T in years to the expiry close.",
    "fair_basis": "Index x (e^(rT) - 1) for the assumed rate r, with no dividends: what financing alone would justify.",
    "vs_fair": "Basis minus fair basis. Positive: the future is rich to financing; negative: cheap (dividends also push it down).",
    "oi_change": "Open interest now minus the previous session's last recorded open interest of the same contract (the session's first value when that is not recorded).",
    "oi_per_min": "Open interest added (+) or removed (-) since the previous recorded value, in units.",
    "volume": "Contracts traded in the future today (cumulative since the open, units).",
}


def _years(expiry: date, at: datetime) -> float:
    end = datetime.combine(expiry, session_close(), IST)
    return (end - at.astimezone(IST)).total_seconds() / (YEAR_DAYS * 86400)


def futures_series(
    market: MarketStore, obs: ObservationStore, underlying: str, *, rate: float, day: date | None = None,
    since: datetime | None = None,
) -> dict[str, Any]:
    horizon = (datetime.now(UTC) - timedelta(days=12)).isoformat()
    rows = [(datetime.fromisoformat(a), p) for a, p in market.samples_since("fut", horizon)]
    by_day: dict[date, list[tuple[datetime, dict[str, Any]]]] = {}
    for t, p in rows:
        by_day.setdefault(t.astimezone(IST).date(), []).append((t, p))
    out: dict[str, Any] = {
        "day": None, "contract": None, "expiry": None, "rate_assumed": rate, "times": [], "future": [], "spot": [], "spot_source": [],
        "basis": [], "basis_pct": [], "carry_pct": [], "fair_basis": [], "vs_fair": [], "oi": [], "oi_change": [], "oi_per_min": [], "volume": [], "volume_per_min": [],
        "oi_baseline": None, "latest": None, "warnings": [], "definitions": DEFINITIONS,
    }
    days = sorted(d for d in by_day if day is None or d <= day)
    if not days:
        out["warnings"].append("No futures samples are stored yet. They are recorded once a minute during the session while the stream is live.")
        return out
    d0 = days[-1]
    today = by_day[d0]
    out["day"] = d0.isoformat()
    last = today[-1][1]
    out["contract"], out["expiry"] = last.get("sym"), last.get("exp")

    # baseline for OI change: the last OI recorded for this contract on an earlier day, else the first of this day
    base_kind, base_val, base_day = "session open", None, None
    first_oi = next((p["oi"] for _, p in today if p.get("oi")), None)
    for d in reversed([x for x in days if x < d0]):
        prev = [p for _, p in by_day[d] if p.get("oi") and p.get("exp") == last.get("exp")]
        if prev:
            base_kind, base_val, base_day = "previous session close", prev[-1]["oi"], d.isoformat()
            break
    if base_val is None:
        base_val = first_oi
    sessions_ago = None
    if base_day is not None:
        # weekdays after the baseline day up to this day (Friday -> Monday is 1): more than 1 means whole sessions are missing
        b = date.fromisoformat(base_day)
        sessions_ago = sum(1 for i in range(1, (d0 - b).days + 1) if (b + timedelta(days=i)).weekday() < 5)
    out["oi_baseline"] = None if base_val is None else {"kind": base_kind, "value": base_val, "day": base_day, "sessions_ago": sessions_ago}
    if sessions_ago is not None and sessions_ago > 1:
        out["warnings"].append(
            f"The OI baseline is the last recorded OI of {base_day}, {sessions_ago} weekdays before this day: "
            "OI change spans several sessions (the sessions in between have no stored OI for this contract)."
        )
    now_utc = datetime.now(UTC)
    if d0 > now_utc.astimezone(IST).date() or today[-1][0] > now_utc + timedelta(minutes=5):
        out["warnings"].append(
            f"These samples are stamped {today[-1][0].astimezone(IST):%d %b %Y %H:%M} IST, which is later than this computer's clock: "
            "check the server's clock, because every stored time and the previous-session logic depend on it."
        )

    prev_v: int | None = None
    prev_oi: float | None = None
    jumps = 0
    joined = 0
    for t, p in today:
        if since is not None and t < since:
            prev_v = p.get("v") if p.get("v") is not None else prev_v
            continue
        fut = p.get("ltp")
        spot, src = p.get("spot"), "live tick"
        if spot is None and fut is not None:
            near = obs.spot_near(underlying, to_ms(t))
            spot, src = (near[0], "snapshot within 90 s") if near else (None, "none")
            joined += 1 if near else 0
        exp = date.fromisoformat(p["exp"]) if p.get("exp") else None
        T = _years(exp, t) if exp else None
        basis = pct = carry = fair = vs = None
        if fut and spot and fut > 0 and spot > 0:
            basis = fut - spot
            pct = basis / spot * 100
            if T and T > 0:
                carry = math.log(fut / spot) / T * 100
                fair = spot * (math.exp(rate * T) - 1)
                vs = basis - fair
        oi = p.get("oi")
        v = p.get("v")
        out["times"].append(t.isoformat())
        out["future"].append(fut)
        out["spot"].append(spot)
        out["spot_source"].append(src if spot is not None else None)
        out["basis"].append(None if basis is None else round(basis, 2))
        out["basis_pct"].append(None if pct is None else round(pct, 4))
        out["carry_pct"].append(None if carry is None else round(carry, 3))
        out["fair_basis"].append(None if fair is None else round(fair, 2))
        out["vs_fair"].append(None if vs is None else round(vs, 2))
        out["oi"].append(oi)
        out["oi_change"].append(None if oi is None or base_val is None else oi - base_val)
        per_min = None if oi is None or prev_oi is None else oi - prev_oi
        out["oi_per_min"].append(per_min)
        if per_min is not None and prev_oi and abs(per_min) / prev_oi > OI_JUMP:
            jumps += 1
        if oi is not None:
            prev_oi = oi
        out["volume"].append(v)
        out["volume_per_min"].append(None if v is None or prev_v is None or v < prev_v else v - prev_v)
        if v is not None:
            prev_v = v
    if jumps:
        out["warnings"].append(
            f"{jumps} one-minute OI move(s) larger than {OI_JUMP:.0%} of the open interest. Real futures OI rarely moves that fast, "
            "so treat them as a possible feed artefact until compared with the exchange's end-of-day figure."
        )
    if joined:
        out["warnings"].append(f"{joined} points had no live index level recorded; the nearest stored snapshot (within 90 s) was used for the basis there.")
    if out["times"] and all(o is None for o in out["oi"]):
        out["warnings"].append("Open interest was not supplied by the feed for the future in these samples, so the OI charts are empty.")
    i = max((k for k, b in enumerate(out["basis"]) if b is not None), default=None)
    if i is not None:
        out["latest"] = {k: out[k][i] for k in ("times", "future", "spot", "basis", "basis_pct", "carry_pct", "fair_basis", "vs_fair")}
    return out
