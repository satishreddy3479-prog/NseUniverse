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

// ---------------------------------------------------------------- Smart OI (OI change inside each candle)
/** The stored OI series the calculation reads: totals over one fixed set of strikes, one value per stored sample. */
export interface SmartOiSeries {
  times: string[];
  spot: (number | null)[];
  ce_oi: (number | null)[];
  pe_oi: (number | null)[];
  ce_volume?: (number | null)[];
  pe_volume?: (number | null)[];
}

export interface SmartOiCandle {
  /** Position of this candle in the session (0 = 09:15 slot), so gaps in stored data are visible. */
  slot: number;
  /** Start of the candle, "HH:MM" in IST. */
  label: string;
  spot: { open: number; high: number; low: number; close: number } | null;
  ceOi: number;
  peOi: number;
  /** Interval change against the previous candle with data; null on the first candle (the baseline). */
  dPe: number | null;
  dCe: number | null;
  /** Smart OI: ΔPE − ΔCE. */
  p: number | null;
  bullish: boolean | null;
  /** How many candle slots the change spans: 1 normally, more when stored samples are missing in between. */
  span: number;
  /** Day change against the first candle. */
  peDay: number;
  ceDay: number;
  diffDay: number;
  /** Put OI ÷ call OI; null when call OI is 0. */
  pcr: number | null;
  /** Cumulative put volume ÷ cumulative call volume today; null when not stored or call volume is 0. */
  volPcr: number | null;
  /** Option volume traded inside this candle (change in the cumulative total); null when unknown. */
  ceVolDelta: number | null;
  peVolDelta: number | null;
}

export interface SmartOiResult {
  /** IST date the candles belong to (the newest day with stored samples). */
  day: string | null;
  timeframe: number;
  candles: SmartOiCandle[];
  /** Time of the first stored sample used as the baseline (the spec's i = 0). */
  baselineAt: string | null;
  /** Candles whose change spans more than one slot because stored samples are missing in between. */
  gapCandles: number;
  /** Samples left out because call or put OI was missing. */
  skippedSamples: number;
}

const IST_MS = 5.5 * 3600_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 40;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Smart OI per candle. The session (open to close as the backend reports it, 09:15–15:40 while the closing auction alignment is on) is cut into candles of `timeframe` minutes. In each candle the
 * last stored sample gives that candle's total call and put OI. For candle i against the previous candle i−1:
 *   ΔPE = PE[i] − PE[i−1],  ΔCE = CE[i] − CE[i−1],  Smart OI p = ΔPE − ΔCE
 * (positive: puts added faster than calls, negative: calls added faster). The first candle is the baseline [0], so it has
 * no bar. Candles with no stored sample are left out, never filled in; the next change then spans the gap (`span` > 1)
 * and is counted in `gapCandles`. Only the newest day with data is used so no change ever crosses a night.
 */
export function smartOiCandles(s: SmartOiSeries, timeframe: number, opts: { day?: string; openMin?: number; closeMin?: number } = {}): SmartOiResult {
  const day = opts.day, openMin = opts.openMin ?? OPEN_MIN, closeMin = opts.closeMin ?? CLOSE_MIN;
  const empty: SmartOiResult = { day: null, timeframe, candles: [], baselineAt: null, gapCandles: 0, skippedSamples: 0 };
  const n = Math.min(s.times.length, s.ce_oi.length, s.pe_oi.length, s.spot.length);
  const istOf = (iso: string) => new Date(new Date(iso).getTime() + IST_MS);
  let useDay = day ?? null;
  if (!useDay) for (let i = n - 1; i >= 0; i--) { const t = new Date(s.times[i]!).getTime(); if (!Number.isNaN(t)) { useDay = istOf(s.times[i]!).toISOString().slice(0, 10); break; } }
  if (!useDay || timeframe < 1) return empty;
  type B = { last: number; lastOi: number; spots: number[]; volIdx: number };
  const buckets = new Map<number, B>();
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const t = istOf(s.times[i]!);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== useDay) continue;
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    if (m < openMin || m > closeMin) continue; // the close minute itself is kept: the last stored sample is the closing state
    const slot = Math.floor((m - openMin) / timeframe);
    const b = buckets.get(slot) ?? { last: -1, lastOi: -1, spots: [], volIdx: -1 };
    const sp = s.spot[i];
    if (sp != null) b.spots.push(sp);
    if (s.ce_oi[i] == null || s.pe_oi[i] == null) skipped++;
    else b.lastOi = i;
    b.last = i;
    buckets.set(slot, b);
  }
  const slots = [...buckets.keys()].sort((a, b) => a - b).filter((k) => buckets.get(k)!.lastOi >= 0);
  const candles: SmartOiCandle[] = [];
  let gaps = 0;
  let baseline: SmartOiCandle | null = null;
  let cumPrev: { ce: number | null; pe: number | null } | null = null;
  for (const k of slots) {
    const b = buckets.get(k)!;
    const ce = s.ce_oi[b.lastOi]!, pe = s.pe_oi[b.lastOi]!;
    const cev = s.ce_volume?.[b.lastOi] ?? null, pev = s.pe_volume?.[b.lastOi] ?? null;
    const prev = candles[candles.length - 1] ?? null;
    const dPe = prev ? pe - prev.peOi : null, dCe = prev ? ce - prev.ceOi : null;
    const p = dPe != null && dCe != null ? dPe - dCe : null;
    const span = prev ? k - prev.slot : 1;
    if (prev && span > 1) gaps++;
    const dv = (cur: number | null, old: number | null) => (cur != null && old != null && cur >= old ? cur - old : null);
    const c: SmartOiCandle = {
      slot: k, label: hhmm(openMin + k * timeframe),
      spot: b.spots.length ? { open: b.spots[0]!, high: Math.max(...b.spots), low: Math.min(...b.spots), close: b.spots[b.spots.length - 1]! } : null,
      ceOi: ce, peOi: pe, dPe, dCe, p, bullish: p == null ? null : p >= 0, span,
      peDay: baseline ? pe - baseline.peOi : 0, ceDay: baseline ? ce - baseline.ceOi : 0,
      diffDay: baseline ? pe - baseline.peOi - (ce - baseline.ceOi) : 0,
      pcr: ce > 0 ? pe / ce : null,
      volPcr: cev != null && pev != null && cev > 0 ? pev / cev : null,
      ceVolDelta: prev ? dv(cev, cumPrev?.ce ?? null) : null, peVolDelta: prev ? dv(pev, cumPrev?.pe ?? null) : null,
    };
    if (!baseline) baseline = c;
    cumPrev = { ce: cev, pe: pev };
    candles.push(c);
  }
  return { day: useDay, timeframe, candles, baselineAt: baseline ? s.times[slots.length ? buckets.get(slots[0]!)!.lastOi : 0]! : null, gapCandles: gaps, skippedSamples: skipped };
}
