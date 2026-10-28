// Pure analytics over option-chain rows. Missing values are skipped and counted, never treated as 0.
import type { OptionChainRow, OptionQuote } from "./types";

export interface Totals {
  ceOi: number | null;
  peOi: number | null;
  ceOiChange: number | null;
  peOiChange: number | null;
  ceVolume: number | null;
  peVolume: number | null;
  strikes: number;
  /** Contracts left out of a sum because the value was missing. */
  missing: { oi: number; oiChange: number; volume: number };
}

function addUp(values: (number | null | undefined)[]): { sum: number | null; missing: number } {
  let sum = 0;
  let have = 0;
  let missing = 0;
  for (const v of values) {
    if (v == null) missing++;
    else {
      sum += v;
      have++;
    }
  }
  return { sum: have ? sum : null, missing };
}

export function computeTotals(rows: OptionChainRow[]): Totals {
  const ce = rows.map((r) => r.call);
  const pe = rows.map((r) => r.put);
  const pick = (qs: (OptionQuote | null)[], k: "oi" | "oi_change" | "volume") =>
    addUp(qs.map((q) => (q ? q[k] : null)));
  const ceOi = pick(ce, "oi"), peOi = pick(pe, "oi");
  const ceCh = pick(ce, "oi_change"), peCh = pick(pe, "oi_change");
  const ceVol = pick(ce, "volume"), peVol = pick(pe, "volume");
  return {
    ceOi: ceOi.sum, peOi: peOi.sum, ceOiChange: ceCh.sum, peOiChange: peCh.sum,
    ceVolume: ceVol.sum, peVolume: peVol.sum, strikes: rows.length,
    missing: { oi: ceOi.missing + peOi.missing, oiChange: ceCh.missing + peCh.missing, volume: ceVol.missing + peVol.missing },
  };
}

/** Put-call ratio = put total / call total. Null when either total is missing or the denominator is 0. */
export function pcr(putTotal: number | null, callTotal: number | null): number | null {
  if (putTotal == null || callTotal == null || callTotal <= 0) return null;
  return putTotal / callTotal;
}

export interface MaxPain {
  strike: number;
  /** Total payout (INR) if the expiry settles at `strike`, summed over the valid strikes. */
  payout: number;
  /** Strikes excluded because OI was missing on either side. */
  excludedStrikes: number;
  usedStrikes: number;
}

/**
 * Max pain: the listed strike at which option buyers' total intrinsic value at expiry is smallest.
 *   payout(S) = sum over strikes K of  CE_OI(K) * max(0, S - K)  +  PE_OI(K) * max(0, K - S)
 * OI is in units (already contracts x lot size), so the payout is in INR. Candidate settlement
 * prices are the listed strikes. Strikes where either side's OI is missing are excluded entirely.
 * This is a description of OI positioning, not a forecast of where the index will settle.
 */
export function maxPain(rows: OptionChainRow[]): MaxPain | null {
  const valid = rows.filter((r) => r.call?.oi != null && r.put?.oi != null);
  if (valid.length === 0) return null;
  let best: { strike: number; payout: number } | null = null;
  for (const s of valid) {
    let payout = 0;
    for (const r of valid) {
      payout += r.call!.oi! * Math.max(0, s.strike - r.strike);
      payout += r.put!.oi! * Math.max(0, r.strike - s.strike);
    }
    if (best === null || payout < best.payout) best = { strike: s.strike, payout };
  }
  return { ...best!, excludedStrikes: rows.length - valid.length, usedStrikes: valid.length };
}

export interface Straddle {
  strike: number;
  call: number;
  put: number;
  premium: number;
}

/** ATM straddle = ATM call LTP + ATM put LTP. Null unless both prices exist. */
export function atmStraddle(rows: OptionChainRow[], atmStrike: number | null): Straddle | null {
  if (atmStrike == null) return null;
  const r = rows.find((x) => x.strike === atmStrike);
  const c = r?.call?.ltp, p = r?.put?.ltp;
  if (c == null || p == null) return null;
  return { strike: atmStrike, call: c, put: p, premium: c + p };
}

/** ATM plus `eachSide` listed strikes on both sides ("all" keeps every strike). */
export function universeRows(rows: OptionChainRow[], atmStrike: number | null, eachSide: number | "all"): OptionChainRow[] {
  if (eachSide === "all" || atmStrike == null) return rows;
  const i = rows.findIndex((r) => r.strike === atmStrike);
  if (i < 0) return rows;
  return rows.slice(Math.max(0, i - eachSide), i + eachSide + 1);
}

/** Indian compact notation: 1,23,456 -> 1.23 L ; 1,23,45,678 -> 1.23 Cr. */
export function compactIN(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} K`;
  return `${sign}${Math.round(a)}`;
}
