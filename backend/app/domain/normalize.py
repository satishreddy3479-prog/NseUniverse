"""Normalize a Kotak Neo ``option_chain()`` response into OptionChainSnapshot.

Two key vocabularies are accepted:
- OBSERVED LIVE (2026-10-28, kotakneoapi 3.0.13, nse_fo NIFTY): per contract
  ``inst{neoSymbol,symbol,optType,strkPrc,exp,moneyness}``, ``quote{ltp,o,h,l,c,pc,vol}``,
  ``oi{cur,prev,chg,chgPct}``; top level ``common_data, call, put, spot, future``.
- DOCUMENTED (SDK docs): ``instrument{...strikePrice}``, ``quote{open,high,low,prevClose,...}``,
  ``openInterest{current,previous,change,changePct}``.

Verified quirk: in the live payload ``oi.chg``/``oi.chgPct`` equal LTP minus previous close
(and its percentage), NOT the change in open interest. They are therefore never used.
OI change is computed here as ``cur - prev`` (percentage only when ``prev > 0``).

Missing values stay ``None``; invalid values (non-numeric, NaN/inf, negative where impossible)
become ``None`` and are listed in ``invalid_fields``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any

from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)


class ChainFormatError(ValueError):
    """The response does not look like an option chain at all."""


def parse_number(value: Any, *, allow_negative: bool = False) -> tuple[float | None, bool]:
    """Return (number, invalid). Missing -> (None, False); invalid -> (None, True)."""
    if value is None:
        return None, False
    if isinstance(value, bool):
        return None, True
    if isinstance(value, int | float):
        num = float(value)
    elif isinstance(value, str):
        s = value.strip().replace(",", "")
        if s in ("", "-", "--", "NA", "N/A", "null", "None"):
            return None, False
        try:
            num = float(s)
        except ValueError:
            return None, True
    else:
        return None, True
    if math.isnan(num) or math.isinf(num):
        return None, True
    if num < 0 and not allow_negative:
        return None, True
    return num, False


def _str_or_none(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _split_neo_symbol(neo_symbol: Any) -> tuple[str | None, str | None]:
    s = _str_or_none(neo_symbol)
    if not s or "|" not in s:
        return None, None
    seg, _, tok = s.partition("|")
    return (seg.strip() or None), (tok.strip() or None)


def _pick(src: Mapping[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in src and src[k] is not None:
            return src[k]
    return None


def _block(item: Mapping[str, Any], *names: str) -> Mapping[str, Any]:
    for n in names:
        v = item.get(n)
        if isinstance(v, Mapping):
            return v
    return {}


def _unwrap(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    if "call" in raw or "put" in raw:
        return raw
    data = raw.get("data")
    if isinstance(data, Mapping) and ("call" in data or "put" in data):
        return data
    raise ChainFormatError("response has no 'call'/'put' arrays")


def _quote(item: Any, expected_type: str) -> tuple[float | None, OptionQuote | None, list[str]]:
    """Return (strike, quote, warnings) for one call/put item."""
    if not isinstance(item, Mapping):
        return None, None, ["ignored non-object chain entry"]
    inst = _block(item, "inst", "instrument")
    q = _block(item, "quote")
    oi = _block(item, "oi", "openInterest")

    strike, bad_strike = parse_number(_pick(inst, "strkPrc", "strikePrice"))
    if strike is None:
        reason = "invalid" if bad_strike else "missing"
        return None, None, [f"ignored {expected_type} entry with {reason} strikePrice"]

    invalid: list[str] = []

    def num(name: str, src: Mapping[str, Any], *keys: str) -> float | None:
        v, bad = parse_number(_pick(src, *keys))
        if bad:
            invalid.append(name)
        return v

    seg, tok = _split_neo_symbol(inst.get("neoSymbol"))
    opt_type = (_str_or_none(_pick(inst, "optType", "optionType")) or expected_type).upper()
    warnings: list[str] = []
    if opt_type != expected_type:
        warnings.append(f"strike {strike:g}: optionType {opt_type} found in {expected_type} list")

    oi_cur = num("oi", oi, "cur", "current")
    oi_prev = num("oi_previous", oi, "prev", "previous")
    oi_change = oi_cur - oi_prev if oi_cur is not None and oi_prev is not None else None
    oi_change_pct = (
        oi_change / oi_prev * 100 if oi_change is not None and oi_prev and oi_prev > 0 else None
    )
    money = _str_or_none(inst.get("moneyness"))

    quote = OptionQuote(
        exchange_segment=seg,
        instrument_token=tok,
        trading_symbol=_str_or_none(inst.get("symbol")),
        option_type=expected_type,
        ltp=num("ltp", q, "ltp"),
        open=num("open", q, "o", "open"),
        high=num("high", q, "h", "high"),
        low=num("low", q, "l", "low"),
        prev_close=num("prev_close", q, "pc", "prevClose"),
        close=num("close", q, "c", "close"),
        volume=num("volume", q, "vol", "volume"),
        oi=oi_cur,
        oi_previous=oi_prev,
        oi_change=oi_change,
        oi_change_pct=oi_change_pct,
        moneyness=money.upper() if money else None,
        invalid_fields=invalid,
    )
    if tok is None:
        warnings.append(f"strike {strike:g} {expected_type}: missing instrument token")
    return strike, quote, warnings


def normalize_option_chain(
    raw: Mapping[str, Any],
    *,
    snapshot_id: str,
    session_id: str,
    underlying: str,
    expiry: date,
    expiry_kinds: list[ExpiryKind],
    source: DataSource,
    retrieved_at: datetime,
    requested_strike_count: int,
) -> OptionChainSnapshot:
    body = _unwrap(raw)
    warnings: list[str] = []
    common = body.get("common_data") if isinstance(body.get("common_data"), Mapping) else {}
    assert isinstance(common, Mapping)

    resp_expiry = _str_or_none(common.get("expiryDt"))  # not present on every response
    if resp_expiry and resp_expiry != expiry.isoformat():
        warnings.append(f"response expiryDt {resp_expiry!r} differs from requested {expiry}")

    rows: dict[float, dict[str, OptionQuote | None]] = {}
    for side, key in (("CE", "call"), ("PE", "put")):
        items = body.get(key)
        if items is None:
            warnings.append(f"response has no '{key}' list")
            continue
        if not isinstance(items, list):
            warnings.append(f"'{key}' is not a list")
            continue
        for item in items:
            strike, quote, w = _quote(item, side)
            warnings.extend(w)
            if strike is None or quote is None:
                continue
            slot = rows.setdefault(strike, {"CE": None, "PE": None})
            if slot[side] is not None:
                warnings.append(f"duplicate {side} at strike {strike:g}; kept first")
                continue
            slot[side] = quote

    out_rows = [
        OptionChainRow(strike=s, call=v["CE"], put=v["PE"]) for s, v in sorted(rows.items())
    ]
    ce = sum(1 for r in out_rows if r.call is not None)
    pe = sum(1 for r in out_rows if r.put is not None)
    if not out_rows:
        completeness = Completeness.EMPTY
    elif ce != len(out_rows) or pe != len(out_rows) or len(out_rows) < requested_strike_count:
        completeness = Completeness.PARTIAL
    else:
        completeness = Completeness.COMPLETE
    if out_rows and len(out_rows) < requested_strike_count:
        warnings.append(f"received {len(out_rows)} strikes; requested {requested_strike_count}")

    spot = body.get("spot") if isinstance(body.get("spot"), Mapping) else {}
    assert isinstance(spot, Mapping)
    spot_ltp, spot_bad = parse_number(spot.get("ltp"))
    spot_prev, _ = parse_number(spot.get("prevClose"))
    if spot_bad:
        warnings.append("underlying spot price failed validation")
    lot, _ = parse_number(common.get("mktLot"))
    mult, _ = parse_number(common.get("multiplier"))
    return OptionChainSnapshot(
        snapshot_id=snapshot_id,
        session_id=session_id,
        underlying=underlying,
        expiry=expiry,
        expiry_kinds=expiry_kinds,
        source=source,
        retrieved_at=retrieved_at,
        lot_size=lot,
        multiplier=mult,
        underlying_ltp=spot_ltp,
        underlying_prev_close=spot_prev,
        requested_strike_count=requested_strike_count,
        completeness=completeness,
        rows=out_rows,
        ce_count=ce,
        pe_count=pe,
        warnings=warnings[:200],
    )
