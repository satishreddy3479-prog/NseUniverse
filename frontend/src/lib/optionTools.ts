/**
 * Calculations behind Smart OI, PE-CE difference, volatility skew and the gamma / vega exposure tools.
 * Pure functions on the option-chain rows: a value that cannot be computed stays null and is counted, never zero-filled.
 */
import { carryFromForward, contractGreeks, impliedForward, type ContractGreeks } from "./optionModel";
import type { OptionChainRow, OptionQuote } from "./types";

// ---------------------------------------------------------------- Smart OI
export type Buildup = "Long buildup" | "Short buildup" | "Short covering" | "Long unwinding";

/**
 * The contract's own price and OI against yesterday's: price up with OI up is a long buildup, price down with OI up a
 * short buildup, price up with OI down short covering, price down with OI down long unwinding. This describes the
 * option contract itself (a rising put premium with rising OI is a long buildup in that put). Null when the previous
 * close, the LTP or the OI change is missing or exactly zero: no direction is guessed.
 */
export function buildupOf(q: Pick<OptionQuote, "ltp" | "prev_close" | "oi_change"> | null): { label: Buildup; priceChange: number; priceChangePct: number | null; oiChange: number } | null {
  if (!q || q.ltp == null || q.prev_close == null || q.oi_change == null) return null;
  const dp = q.ltp - q.prev_close;
  if (dp === 0 || q.oi_change === 0) return null;
  const label: Buildup = dp > 0 ? (q.oi_change > 0 ? "Long buildup" : "Short covering") : q.oi_change > 0 ? "Short buildup" : "Long unwinding";
  return { label, priceChange: dp, priceChangePct: q.prev_close > 0 ? (dp / q.prev_close) * 100 : null, oiChange: q.oi_change };
}

export interface SmartOiSummary { counts: Record<Buildup, { ce: number; pe: number }>; unclassified: number; classified: number }
export function smartOiSummary(rows: OptionChainRow[]): SmartOiSummary {
  const labels: Buildup[] = ["Long buildup", "Short buildup", "Short covering", "Long unwinding"];
  const counts = Object.fromEntries(labels.map((l) => [l, { ce: 0, pe: 0 }])) as SmartOiSummary["counts"];
  let unclassified = 0, classified = 0;
  for (const r of rows) for (const [side, q] of [["ce", r.call], ["pe", r.put]] as const) {
    const b = buildupOf(q);
    if (!b) { if (q) unclassified++; continue; }
    counts[b.label][side]++; classified++;
  }
  return { counts, unclassified, classified };
}

// ---------------------------------------------------------------- PE - CE difference
export type DiffMetric = "oi" | "oiChange" | "volume";
const pick = (q: OptionQuote | null, m: DiffMetric) => (q == null ? null : m === "oi" ? q.oi : m === "oiChange" ? q.oi_change : q.volume);
/** Put minus call for one metric, strike by strike. A strike missing either side is left out and counted. */
export function peCeDifference(rows: OptionChainRow[], metric: DiffMetric): { points: { strike: number; ce: number; pe: number; diff: number }[]; skipped: number; total: number } {
  const points: { strike: number; ce: number; pe: number; diff: number }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const ce = pick(r.call, metric), pe = pick(r.put, metric);
    if (ce == null || pe == null) { skipped++; continue; }
    points.push({ strike: r.strike, ce, pe, diff: pe - ce });
  }
  return { points, skipped, total: points.reduce((t, p) => t + p.diff, 0) };
}

// ---------------------------------------------------------------- Greeks of the whole chain
export interface StrikeGreeks { strike: number; ce: ContractGreeks | null; pe: ContractGreeks | null }
/**
 * Black-76 Greeks of every listed contract from its own LTP (implied volatility solved per contract). The forward comes
 * from put-call parity at the strikes nearest spot; when it cannot be found the carry falls back to the interest rate.
 * `skipped` counts contracts whose price gave no volatility (no price, or outside what the model can fit).
 */
export function chainGreeks(rows: OptionChainRow[], spot: number, expiry: string, nowMs: number, rate = 0.06): { strikes: StrikeGreeks[]; forward: number | null; carry: number; skipped: number } {
  const fwd = impliedForward(rows.map((r) => ({ strike: r.strike, call: r.call?.ltp ?? null, put: r.put?.ltp ?? null })), spot, expiry, nowMs, rate);
  const carry = (fwd ? carryFromForward(spot, fwd.forward, expiry, nowMs) : null) ?? rate;
  let skipped = 0;
  const g = (type: "CE" | "PE", q: OptionQuote | null, strike: number) => {
    const px = q?.ltp != null && q.ltp > 0 ? q.ltp : null;
    const out = contractGreeks(type, px, spot, strike, expiry, nowMs, rate, carry);
    if (q && !out) skipped++;
    return out;
  };
  return { strikes: rows.map((r) => ({ strike: r.strike, ce: g("CE", r.call, r.strike), pe: g("PE", r.put, r.strike) })), forward: fwd?.forward ?? null, carry, skipped };
}

// ---------------------------------------------------------------- exposure
/**
 * Gamma exposure per strike = gamma x open interest (units) x spot^2 x 1 %: the rupee value of underlying whose delta
 * changes for a 1 % move. Calls and puts are listed separately; `net` = call - put is a CONVENTION (it assumes the
 * market is long calls and short puts), not something observed. Vega exposure = vega per volatility point x OI: the rupee
 * change in all contracts of that strike for one volatility point. A strike without Greeks or OI is skipped and counted.
 */
export interface Exposure { strike: number; call: number | null; put: number | null; net: number | null }
export function exposures(rows: OptionChainRow[], greeks: StrikeGreeks[], spot: number, kind: "gamma" | "vega"): { points: Exposure[]; skipped: number } {
  const byStrike = new Map(greeks.map((g) => [g.strike, g]));
  const f = (g: ContractGreeks | null, oi: number | null | undefined) => (g == null || oi == null ? null : kind === "gamma" ? g.gamma * oi * spot * spot * 0.01 : g.vegaPt * oi);
  let skipped = 0;
  const points: Exposure[] = [];
  for (const r of rows) {
    const g = byStrike.get(r.strike);
    const call = f(g?.ce ?? null, r.call?.oi), put = f(g?.pe ?? null, r.put?.oi);
    if (call == null && put == null) { skipped++; continue; }
    points.push({ strike: r.strike, call, put, net: kind === "gamma" && call != null && put != null ? call - put : null });
  }
  return { points, skipped };
}
