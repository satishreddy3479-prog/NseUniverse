"""Open-interest intelligence over stored observations.

Everything here is descriptive arithmetic on observed values; nothing infers intent.
"OI increased" does not mean writing or buying, and a high-OI strike is not support or resistance.

Units: OI and volume are in units (multiples of the lot size). Prices are rupees.
Missing values stay None; a missing baseline gives "Insufficient data", never a zero change.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from app.storage.observations import CALL, PUT, Contract, ObservationStore, Sample

IST = ZoneInfo("Asia/Kolkata")

BaselineKind = Literal["previous", "at", "session_open", "prev_session", "broker_prev_day"]
Side = Literal["CE", "PE"]
Direction = Literal["up", "down", "flat"]

BASELINE_LABELS: dict[str, str] = {
    "previous": "Previous distinct observation",
    "at": "Selected time",
    "session_open": "First observation of the session",
    "prev_session": "Last observation of the previous session (our own stored data)",
    "broker_prev_day": "Broker's previous-day OI field (meaning unverified)",
}

LABEL_UP, LABEL_DOWN, LABEL_FLAT, LABEL_NONE = (
    "OI increased",
    "OI decreased",
    "OI unchanged",
    "Insufficient data",
)


class Baseline(BaseModel):
    kind: BaselineKind
    label: str
    at: datetime | None
    note: str = ""


class OiRow(BaseModel):
    strike: float
    side: Side
    oi: int | None
    baseline_oi: int | None
    change: int | None
    change_pct: float | None
    label: str
    ltp: float | None
    baseline_ltp: float | None
    price_change: float | None
    price_change_pct: float | None
    #: neutral description of the two signs, e.g. "OI up, premium down"; None if either is unknown
    relation: str | None


class Totals(BaseModel):
    ce_oi: int | None
    pe_oi: int | None
    ce_change: int | None
    pe_change: int | None


class ConcentrationRow(BaseModel):
    strike: float
    side: Side
    oi: int
    share_pct: float
    baseline_share_pct: float | None
    share_change_pts: float | None


class OiChange(BaseModel):
    underlying: str
    expiry: str
    baseline: Baseline
    current_at: datetime | None
    spot: float | None
    baseline_spot: float | None
    underlying_change: float | None
    atm_strike: float | None
    strikes_each_side: int | None
    rows: list[OiRow]
    totals: Totals
    concentration: list[ConcentrationRow]
    observations_available: int
    warnings: list[str] = []
    definitions: dict[str, str]


DEFINITIONS = {
    "change": "Current OI minus baseline OI, in units (multiples of the lot size).",
    "change_pct": "Change divided by baseline OI; shown only when baseline OI is above zero.",
    "relation": (
        "Direction of OI and of the option premium (LTP) between the same two observations. "
        "It describes what was observed; it does not say who bought or sold or what happens next."
    ),
    "concentration": (
        "Share of the side's total OI in the chosen strike universe. A large share is not "
        "support or resistance."
    ),
    "unchanged_observations": (
        "A fetch identical to the one before is stored as 'unchanged'; its values are the "
        "earlier ones, observed again at the later time."
    ),
}


def _direction(delta: float | None) -> Direction | None:
    if delta is None:
        return None
    return "up" if delta > 0 else "down" if delta < 0 else "flat"


def _label(change: int | None) -> str:
    d = _direction(change)
    return LABEL_NONE if d is None else {"up": LABEL_UP, "down": LABEL_DOWN, "flat": LABEL_FLAT}[d]


def _ist_date(dt: datetime) -> str:
    return dt.astimezone(IST).date().isoformat()


def _pick_baseline(
    samples: list[Sample], kind: BaselineKind, at: datetime | None
) -> tuple[Sample | None, str]:
    """Returns (baseline sample, note). Never extrapolates: no earlier data means no baseline."""
    cur = samples[-1]
    earlier = samples[:-1]
    if kind == "previous":
        for s in reversed(earlier):
            if s.fp != cur.fp:
                return s, ""
        return None, "No earlier observation with different values is stored."
    if kind == "at":
        if at is None:
            return None, "No time selected."
        cands = [s for s in samples if s.received_at <= at]
        if not cands:
            return None, "No observation is stored at or before the selected time."
        return cands[-1], ""
    day = _ist_date(cur.received_at)
    if kind == "session_open":
        same = [s for s in samples if _ist_date(s.received_at) == day]
        return same[0], ""
    if kind == "prev_session":
        prior = [s for s in earlier if _ist_date(s.received_at) < day]
        if not prior:
            return None, "No observation from an earlier session is stored."
        last_day = _ist_date(prior[-1].received_at)
        return [s for s in prior if _ist_date(s.received_at) == last_day][-1], ""
    return None, ""  # broker_prev_day: values come from the current contracts


def _nearest(strikes: list[float], price: float) -> float:
    return min(strikes, key=lambda k: (abs(k - price), k))


def universe(strikes: list[float], spot: float | None, each_side: int | None) -> list[float]:
    ks = sorted(strikes)
    if each_side is None or spot is None or not ks:
        return ks
    i = ks.index(_nearest(ks, spot))
    return ks[max(0, i - each_side) : i + each_side + 1]


def _change(cur: int | None, base: int | None) -> tuple[int | None, float | None]:
    if cur is None or base is None:
        return None, None
    d = cur - base
    return d, (d / base * 100 if base > 0 else None)


def _sum(vals: list[int | None]) -> int | None:
    have = [v for v in vals if v is not None]
    return sum(have) if have else None


def oi_change(
    obs: ObservationStore,
    underlying: str,
    expiry: str,
    kind: BaselineKind = "previous",
    *,
    at: datetime | None = None,
    until: datetime | None = None,
    each_side: int | None = 10,
    top_n: int = 5,
) -> OiChange:
    samples = obs.samples(underlying, expiry, until=until)
    bl = Baseline(kind=kind, label=BASELINE_LABELS[kind], at=None)
    empty = OiChange(
        underlying=underlying, expiry=expiry, baseline=bl, current_at=None, spot=None,
        baseline_spot=None, underlying_change=None, atm_strike=None, strikes_each_side=each_side,
        rows=[], totals=Totals(ce_oi=None, pe_oi=None, ce_change=None, pe_change=None),
        concentration=[], observations_available=0, definitions=DEFINITIONS,
    )  # fmt: skip
    if not samples:
        empty.warnings.append("No observations are stored for this expiry.")
        return empty
    cur = samples[-1]
    cur_c = obs.contracts(cur.values_from)
    base_sample, note = _pick_baseline(samples, kind, at)
    base_c: dict[tuple[float, int], Contract] = {}
    if kind == "broker_prev_day":
        note = "Uses the broker's previous-day OI field as supplied; prices have no baseline."
        bl = bl.model_copy(update={"note": note})
    elif base_sample is not None:
        base_c = obs.contracts(base_sample.values_from)
        bl = bl.model_copy(update={"at": base_sample.received_at, "note": note})
    else:
        bl = bl.model_copy(update={"note": note})
    warnings: list[str] = []
    if base_sample is not None and base_sample.sample_id == cur.sample_id:
        warnings.append("The baseline is the current observation, so every change is zero.")
    if kind != "broker_prev_day" and base_sample is None:
        warnings.append(note or "No baseline observation is available.")

    strikes = universe(sorted({k for k, _ in cur_c}), cur.spot, each_side)
    if cur.spot is None and each_side is not None:
        warnings.append("No spot price was recorded, so all strikes are shown.")
    atm = _nearest(strikes, cur.spot) if strikes and cur.spot is not None else None

    rows: list[OiRow] = []
    for k in strikes:
        sides: tuple[tuple[int, Side], ...] = ((CALL, "CE"), (PUT, "PE"))
        for side_i, side in sides:
            c = cur_c.get((k, side_i))
            if c is None:
                continue
            if kind == "broker_prev_day":
                b_oi, b_ltp = c.oi_prev, None
            else:
                b = base_c.get((k, side_i))
                b_oi, b_ltp = (b.oi, b.ltp) if b else (None, None)
            ch, pct = _change(c.oi, b_oi)
            p_ch = None if c.ltp is None or b_ltp is None else round(c.ltp - b_ltp, 2)
            p_pct = None if p_ch is None or not b_ltp else p_ch / b_ltp * 100
            od, pd = _direction(ch), _direction(p_ch)
            relation = None if od is None or pd is None else f"OI {od}, premium {pd}"
            rows.append(
                OiRow(
                    strike=k,
                    side=side,
                    oi=c.oi,
                    baseline_oi=b_oi,
                    change=ch,
                    change_pct=pct,
                    label=_label(ch),
                    ltp=c.ltp,
                    baseline_ltp=b_ltp,
                    price_change=p_ch,
                    price_change_pct=p_pct,
                    relation=relation,
                )  # fmt: skip
            )
    ce = [r for r in rows if r.side == "CE"]
    pe = [r for r in rows if r.side == "PE"]
    totals = Totals(
        ce_oi=_sum([r.oi for r in ce]), pe_oi=_sum([r.oi for r in pe]),
        ce_change=_sum([r.change for r in ce]), pe_change=_sum([r.change for r in pe]),
    )  # fmt: skip
    base_spot = base_sample.spot if base_sample else None
    spot_change = None if cur.spot is None or base_spot is None else round(cur.spot - base_spot, 2)
    return OiChange(
        underlying=underlying, expiry=expiry, baseline=bl, current_at=cur.received_at,
        spot=cur.spot, baseline_spot=base_spot,
        underlying_change=spot_change,
        atm_strike=atm, strikes_each_side=each_side, rows=rows, totals=totals,
        concentration=_concentration(ce, pe, top_n), observations_available=len(samples),
        warnings=warnings, definitions=DEFINITIONS,
    )  # fmt: skip


def _concentration(ce: list[OiRow], pe: list[OiRow], top_n: int) -> list[ConcentrationRow]:
    out: list[ConcentrationRow] = []
    for side_rows in (ce, pe):
        tot = sum(r.oi for r in side_rows if r.oi is not None)
        btot = sum(r.baseline_oi for r in side_rows if r.baseline_oi is not None)
        have_base = (
            bool(side_rows) and all(r.baseline_oi is not None for r in side_rows) and btot > 0
        )
        if tot <= 0:
            continue
        top = sorted((r for r in side_rows if r.oi), key=lambda r: (-(r.oi or 0), r.strike))[:top_n]
        for r in top:
            share = (r.oi or 0) / tot * 100
            bshare = (r.baseline_oi or 0) / btot * 100 if have_base else None
            out.append(
                ConcentrationRow(
                    strike=r.strike,
                    side=r.side,
                    oi=r.oi or 0,
                    share_pct=share,
                    baseline_share_pct=bshare,
                    share_change_pts=None if bshare is None else share - bshare,
                )  # fmt: skip
            )
    return out


# ------------------------------------------------------------------------------------ heatmap
class Heatmap(BaseModel):
    underlying: str
    expiry: str
    side: Side
    baseline: Baseline
    strikes: list[float]
    times: list[datetime]
    #: change[strike_index][time_index]; None = missing or no baseline
    change: list[list[int | None]]
    stride: int
    atm_strike: float | None
    missing_cells: int
    warnings: list[str] = []


def oi_heatmap(
    obs: ObservationStore,
    underlying: str,
    expiry: str,
    side: Side,
    kind: Literal["session_open", "prev_session", "previous", "broker_prev_day"] = "session_open",
    *,
    each_side: int | None = 10,
    since: datetime | None = None,
    until: datetime | None = None,
    max_columns: int = 120,
) -> Heatmap:
    """Strike-by-time grid of OI change. ``previous`` = change since the preceding column."""
    side_i = CALL if side == "CE" else PUT
    all_samples = obs.samples(underlying, expiry, until=until)
    bl = Baseline(kind=kind, label=BASELINE_LABELS.get(kind, kind), at=None)
    empty = Heatmap(
        underlying=underlying, expiry=expiry, side=side, baseline=bl, strikes=[], times=[],
        change=[], stride=1, atm_strike=None, missing_cells=0, warnings=[],
    )  # fmt: skip
    if not all_samples:
        empty.warnings.append("No observations are stored for this expiry.")
        return empty
    last = all_samples[-1]
    cache: dict[int, dict[tuple[float, int], Contract]] = {}

    def contracts_of(s: Sample) -> dict[tuple[float, int], Contract]:
        if s.values_from not in cache:
            cache[s.values_from] = obs.contracts(s.values_from)
        return cache[s.values_from]

    strikes = universe(sorted({k for k, _ in contracts_of(last)}), last.spot, each_side)
    atm = _nearest(strikes, last.spot) if strikes and last.spot is not None else None
    shown = [s for s in all_samples if since is None or s.received_at >= since]
    stride = max(1, -(-len(shown) // max_columns))
    cols = shown[::stride]
    if shown and cols[-1].sample_id != shown[-1].sample_id:
        cols.append(shown[-1])  # always include the newest observation
    warnings: list[str] = []
    if stride > 1:
        warnings.append(f"Showing every {stride}th observation ({len(shown)} stored).")

    base_by_col: list[dict[tuple[float, int], Contract] | None] = []
    base_sample: Sample | None = None
    if kind in ("session_open", "prev_session"):
        base_sample, why = _pick_baseline(all_samples, kind, None)  # relative to the newest sample
        if base_sample is None:
            warnings.append(why)
        else:
            bl = bl.model_copy(update={"at": base_sample.received_at})
        fixed = contracts_of(base_sample) if base_sample else None
        base_by_col = [fixed] * len(cols)
    elif kind == "previous":
        prev_map: dict[int, Sample | None] = {}
        for i, s in enumerate(all_samples):
            prev_map[s.sample_id] = all_samples[i - 1] if i else None
        base_by_col = [contracts_of(p) if (p := prev_map.get(s.sample_id)) else None for s in cols]
    else:  # broker_prev_day: baseline is each column's own oi_prev field
        base_by_col = [None] * len(cols)

    grid: list[list[int | None]] = []
    missing = 0
    for k in strikes:
        row: list[int | None] = []
        for s, base in zip(cols, base_by_col, strict=True):
            cur_c = contracts_of(s).get((k, side_i))
            v: int | None = None
            if cur_c is not None and cur_c.oi is not None:
                if kind == "broker_prev_day":
                    v = None if cur_c.oi_prev is None else cur_c.oi - cur_c.oi_prev
                elif base is not None:
                    b = base.get((k, side_i))
                    v = None if b is None or b.oi is None else cur_c.oi - b.oi
            if v is None:
                missing += 1
            row.append(v)
        grid.append(row)
    return Heatmap(
        underlying=underlying, expiry=expiry, side=side, baseline=bl, strikes=strikes,
        times=[s.received_at for s in cols], change=grid, stride=stride, atm_strike=atm,
        missing_cells=missing, warnings=warnings,
    )  # fmt: skip


def parse_time(v: str | None) -> datetime | None:
    if not v:
        return None
    dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
