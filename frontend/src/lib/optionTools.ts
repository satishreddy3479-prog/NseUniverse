/**
 * Calculations behind Smart OI, PE-CE difference, volatility skew and the gamma / vega exposure tools.
 * Pure functions on the option-chain rows: a value that cannot be computed stays null and is counted, never zero-filled.
 */
import { carryFromForward, contractGreeks, impliedForward, type ContractGreeks } from "./optionModel";
import { isSessionMs } from "./analytics";
import type { OptionChainRow, OptionQuote, StrikeSeries } from "./types";

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

// ---------------------------------------------------------------- Price vs OI (one strike through the session)
export interface StrikeBoard {
  strike: number;
  times: number[];
  spot: (number | null)[];
  cePrice: (number | null)[]; pePrice: (number | null)[];
  ceOi: (number | null)[]; peOi: (number | null)[];
  ceChange: (number | null)[]; peChange: (number | null)[];
  /** call price + put price, only where both were observed in that sample */
  straddle: (number | null)[];
  /** put OI / call OI of this strike, only where both OIs were observed and the call OI is above zero */
  pcr: (number | null)[];
  /** samples dropped because they were taken outside the session, and points where one side's price was missing */
  outsideSession: number;
  straddleGaps: number;
}

/** One strike's series from the stored samples, session samples only. A missing value stays null; nothing is filled. */
export function strikeBoard(res: StrikeSeries, strike: number): StrikeBoard | null {
  const key = String(strike);
  const cp = res.ce_price[key], pp = res.pe_price[key], co = res.ce_oi[key], po = res.pe_oi[key], cc = res.ce_change[key], pc = res.pe_change[key];
  if (!cp || !pp || !co || !po || !cc || !pc) return null;
  const keep = res.times.map((t) => isSessionMs(new Date(t).getTime()));
  const pick = <T,>(a: T[]): T[] => a.filter((_, i) => keep[i]);
  const cePrice = pick(cp), pePrice = pick(pp), ceOi = pick(co), peOi = pick(po);
  const straddle = cePrice.map((c, i) => (c != null && pePrice[i] != null ? Math.round((c + pePrice[i]!) * 100) / 100 : null));
  const pcr = ceOi.map((c, i) => (c != null && c > 0 && peOi[i] != null ? Math.round((peOi[i]! / c) * 10000) / 10000 : null));
  return {
    strike, times: pick(res.times.map((t) => new Date(t).getTime())), spot: pick(res.spot), cePrice, pePrice, ceOi, peOi,
    ceChange: pick(cc), peChange: pick(pc), straddle, pcr,
    outsideSession: keep.filter((k) => !k).length, straddleGaps: straddle.filter((v) => v == null).length,
  };
}

/** The listed strikes nearest the ATM, in order (up to `n` of them), for the multi-strike pickers. */
export function strikesAround(strikes: number[], atm: number | null, n: number): number[] {
  const s = [...strikes].sort((a, b) => a - b);
  if (atm == null || s.length === 0) return s.slice(0, n);
  let i = s.findIndex((x) => x >= atm);
  if (i < 0) i = s.length - 1;
  const from = Math.max(0, Math.min(s.length - n, i - Math.floor(n / 2)));
  return s.slice(from, from + n);
}

// ---------------------------------------------------------------- Vega Analysis (through the session)
export interface VegaPoint {
  t: number;
  spot: number | null;
  /** sum over the chosen strikes of call vega per volatility point x OI (rupees); null when no strike had both */
  call: number | null;
  put: number | null;
  /** put minus call, only where both exist */
  diff: number | null;
  /** strikes that contributed on each side, and contracts whose price gave no volatility */
  callN: number; putN: number; skipped: number;
}

const quoteOf = (ltp: number | null, oi: number | null): OptionQuote => ({ ltp, oi } as OptionQuote);

/**
 * Call and put VEGA (the Greek) of a FIXED set of strikes at every stored sample. For each sample the chain's own prices give
 * the forward (put-call parity near spot) and every contract's implied volatility (Black-76); `vegaPt` is the change in that
 * contract's price, in rupees, for one volatility point. "greek" sums vegaPt over the strikes of each side (one unit of each
 * contract, no open interest involved). "oi" weights each contract by its open interest (units), which is the vega exposure
 * of the whole market and grows as OI builds. "change" weights each contract's vega by the OI added since the first session sample
 * of the day (so the series starts at zero and moves with new positions, negative where OI was removed). Samples outside the session are left out; a contract with no usable price
 * (or, for "oi", no OI) is skipped and counted, never zero-filled.
 */
export type VegaBasis = "greek" | "oi" | "change";
export function vegaSeries(res: StrikeSeries, expiry: string, basis: VegaBasis = "greek", rate = 0.06): VegaPoint[] {
  const out: VegaPoint[] = [];
  // OI of each contract at the first session sample that has one: the "since the open" reference of the change basis
  const base = new Map<string, number>();
  if (basis === "change") {
    for (let i = 0; i < res.times.length; i++) {
      if (!isSessionMs(new Date(res.times[i]!).getTime())) continue;
      for (const k of res.strikes) {
        for (const [side, m] of [["CE", res.ce_oi], ["PE", res.pe_oi]] as const) {
          const v = m[String(k)]?.[i];
          if (v != null && !base.has(`${side}${k}`)) base.set(`${side}${k}`, v);
        }
      }
    }
  }
  res.times.forEach((iso, i) => {
    const t = new Date(iso).getTime();
    const spot = res.spot[i];
    if (!isSessionMs(t) || spot == null) return;
    const rows: OptionChainRow[] = res.strikes.map((k) => {
      const key = String(k);
      return { strike: k, call: quoteOf(res.ce_price[key]?.[i] ?? null, res.ce_oi[key]?.[i] ?? null), put: quoteOf(res.pe_price[key]?.[i] ?? null, res.pe_oi[key]?.[i] ?? null) } as OptionChainRow;
    });
    const g = chainGreeks(rows, spot, expiry, t, rate);
    let cs: number[], ps: number[];
    if (basis === "change") {
      const one = (side: "CE" | "PE", pick: (x: (typeof g.strikes)[number]) => number | undefined, oi: Record<string, (number | null)[]>) =>
        g.strikes.flatMap((x) => {
          const v = pick(x), now = oi[String(x.strike)]?.[i], b = base.get(`${side}${x.strike}`);
          return v == null || now == null || b == null ? [] : [v * (now - b)];
        });
      cs = one("CE", (x) => x.ce?.vegaPt, res.ce_oi);
      ps = one("PE", (x) => x.pe?.vegaPt, res.pe_oi);
    } else if (basis === "oi") {
      const ex = exposures(rows, g.strikes, spot, "vega").points;
      cs = ex.map((p) => p.call).filter((v): v is number => v != null);
      ps = ex.map((p) => p.put).filter((v): v is number => v != null);
    } else {
      cs = g.strikes.map((x) => x.ce?.vegaPt).filter((v): v is number => v != null);
      ps = g.strikes.map((x) => x.pe?.vegaPt).filter((v): v is number => v != null);
    }
    const call = cs.length ? cs.reduce((x, y) => x + y, 0) : null;
    const put = ps.length ? ps.reduce((x, y) => x + y, 0) : null;
    out.push({ t, spot, call, put, diff: call != null && put != null ? put - call : null, callN: cs.length, putN: ps.length, skipped: g.skipped });
  });
  return out;
}

/** The last value inside each candle of `tf` minutes (counted from the session open): vega is a level, not a flow, so the candle shows where it ended. */
export function vegaCandles(points: VegaPoint[], tf: number, openMin: number): VegaPoint[] {
  if (tf <= 1) return points;
  const slot = (t: number) => {
    const d = new Date(t + 330 * 60_000);
    return Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes() - openMin) / tf);
  };
  const out: VegaPoint[] = [];
  let lastKey = "";
  for (const p of points) {
    const key = `${new Date(p.t + 330 * 60_000).toISOString().slice(0, 10)}|${slot(p.t)}`;
    if (key === lastKey) out[out.length - 1] = p; else out.push(p);
    lastKey = key;
  }
  return out;
}
