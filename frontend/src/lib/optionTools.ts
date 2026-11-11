/**
 * Calculations behind Smart OI, PE-CE difference, volatility skew and the gamma / vega exposure tools.
 * Pure functions on the option-chain rows: a value that cannot be computed stays null and is counted, never zero-filled.
 */
import { RISK_FREE_RATE } from "./assumptions";
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
export function chainGreeks(rows: OptionChainRow[], spot: number, expiry: string, nowMs: number, rate = RISK_FREE_RATE): { strikes: StrikeGreeks[]; forward: number | null; carry: number; skipped: number } {
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
  /** OI now minus the previous day's OI, summed over the same strikes (what the broker-day change means). Optional. */
  ce_change?: (number | null)[];
  pe_change?: (number | null)[];
  /** How many strikes had a value in each sample. When it differs between two candles, part of the change is a strike appearing or vanishing. */
  ce_strikes_used?: number[];
  pe_strikes_used?: number[];
}

export interface SmartOiCandle {
  /** Position of this candle in the session (0 = 09:15 slot), so gaps in stored data are visible. */
  slot: number;
  /** Start of the candle, "HH:MM" in IST. */
  label: string;
  spot: { open: number; high: number; low: number; close: number } | null;
  /** True when the spot candle comes from one-minute index bars (real highs and lows), false when it is cut from the stored samples. */
  spotFromBars: boolean;
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
  /** Cumulative option volume traded today (units) at this candle; null when not stored. */
  ceVol: number | null;
  peVol: number | null;
  /** Option volume traded inside this candle (change in the cumulative total); null when unknown. */
  ceVolDelta: number | null;
  peVolDelta: number | null;
  /** True when dPe/dCe/p of this (first) candle are measured against the previous day's closing OI, not a prior candle. */
  fromPrevClose: boolean;
  /** The number of strikes behind the call or put total differs from the previous candle's, so this change is not like for like. */
  strikesChanged: boolean;
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
  /** Candles whose change mixes in a strike that appeared or vanished between samples (see `strikesChanged`). */
  strikeChangeCandles: number;
  /** Stretches where the index quote repeated one identical value (a stalled feed, never a real tape); those samples are not drawn as candles. */
  stalls: SpotStall[];
  /** One-minute bars with almost no reads in the minute (feed silent): left out of the NIFTY candles. */
  thinBars: number;
  /** A drawn candle opened far from the previous drawn candle's close right after a stall or silence: the move is real feed output but unconfirmed. */
  jumps: { at: string; from: number; to: number; pct: number }[];
}

export interface SpotStall { from: string; to: string; value: number; samples: number }

/** Identical spot values in this many consecutive stored samples (about a minute apart) cannot be a live NIFTY tape. */
export const STALL_MIN_SAMPLES = 5;
/** A one-minute bar built from fewer reads than this was made while the index feed was silent. */
export const THIN_BAR_READS = 10;
/** An opening more than this fraction away from the previous close after a silence is flagged. */
export const JUMP_FRACTION = 0.005;

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
export function smartOiCandles(s: SmartOiSeries, timeframe: number, opts: { day?: string; openMin?: number; closeMin?: number; bars?: { at: string; o: number; h: number; l: number; c: number; n?: number | null }[] } = {}): SmartOiResult {
  const day = opts.day, openMin = opts.openMin ?? OPEN_MIN, closeMin = opts.closeMin ?? CLOSE_MIN;
  const empty: SmartOiResult = { day: null, timeframe, candles: [], baselineAt: null, gapCandles: 0, skippedSamples: 0, strikeChangeCandles: 0, stalls: [], thinBars: 0, jumps: [] };
  const n = Math.min(s.times.length, s.ce_oi.length, s.pe_oi.length, s.spot.length);
  const istOf = (iso: string) => new Date(new Date(iso).getTime() + IST_MS);
  let useDay = day ?? null;
  if (!useDay) for (let i = n - 1; i >= 0; i--) { const t = new Date(s.times[i]!).getTime(); if (!Number.isNaN(t)) { useDay = istOf(s.times[i]!).toISOString().slice(0, 10); break; } }
  if (!useDay || timeframe < 1) return empty;
  type B = { last: number; lastOi: number; spots: number[]; volIdx: number };
  // Stalled quote: the same spot value in a long run of consecutive samples of the day. Those samples keep their OI but carry no usable price.
  const stale = new Set<number>();
  const stalls: SpotStall[] = [];
  {
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && s.spot[j + 1] != null && s.spot[j + 1] === s.spot[i]) j++;
      if (s.spot[i] != null && j - i + 1 >= STALL_MIN_SAMPLES && istOf(s.times[i]!).toISOString().slice(0, 10) === useDay) {
        for (let k = i; k <= j; k++) stale.add(k);
        const hm = (k: number) => istOf(s.times[k]!).toISOString().slice(11, 16);
        const startMin = istOf(s.times[i]!).getUTCHours() * 60 + istOf(s.times[i]!).getUTCMinutes();
        if (startMin < 15 * 60 + 30) stalls.push({ from: hm(i), to: hm(j), value: s.spot[i]!, samples: j - i + 1 }); // a constant after the 15:30 close is the closing value, not a stall
      }
      i = j + 1;
    }
  }
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
    if (sp != null && !stale.has(i)) b.spots.push(sp);
    if (s.ce_oi[i] == null || s.pe_oi[i] == null) skipped++;
    else b.lastOi = i;
    b.last = i;
    buckets.set(slot, b);
  }
  // One-minute index bars of the same day, grouped into the same candle slots: they carry the real highs and lows.
  const barSlots = new Map<number, { at: string; o: number; h: number; l: number; c: number }[]>();
  let thinBars = 0;
  for (const bar of opts.bars ?? []) {
    const t = istOf(bar.at);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== useDay) continue;
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    if (m < openMin || m > closeMin) continue;
    if (bar.n != null && bar.n < THIN_BAR_READS) { thinBars++; continue; }
    const slot = Math.floor((m - openMin) / timeframe);
    barSlots.set(slot, [...(barSlots.get(slot) ?? []), bar]);
  }
  for (const list of barSlots.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  const slots = [...buckets.keys()].sort((a, b) => a - b).filter((k) => buckets.get(k)!.lastOi >= 0);
  const candles: SmartOiCandle[] = [];
  let gaps = 0, strikeChanges = 0;
  let prevN: { ce: number; pe: number } | null = null;
  let baseline: SmartOiCandle | null = null;
  let cumPrev: { ce: number | null; pe: number | null } | null = null;
  for (const k of slots) {
    const b = buckets.get(k)!;
    const ce = s.ce_oi[b.lastOi]!, pe = s.pe_oi[b.lastOi]!;
    const cev = s.ce_volume?.[b.lastOi] ?? null, pev = s.pe_volume?.[b.lastOi] ?? null;
    const prev = candles[candles.length - 1] ?? null;
    const nCe = s.ce_strikes_used?.[b.lastOi], nPe = s.pe_strikes_used?.[b.lastOi];
    const strikesChanged = !!prev && prevN != null && nCe != null && nPe != null && (nCe !== prevN.ce || nPe !== prevN.pe);
    if (strikesChanged) strikeChanges++;
    prevN = nCe != null && nPe != null ? { ce: nCe, pe: nPe } : null;
    const chPe = s.pe_change?.[b.lastOi] ?? null, chCe = s.ce_change?.[b.lastOi] ?? null;
    const hasChg = chPe != null && chCe != null;
    // The first candle has no earlier candle: when the stored previous-day OI exists, its change is measured against yesterday's close
    // (the "day change" the other platforms show at 09:15); otherwise it stays the baseline with no bar.
    const fromPrevClose = !prev && hasChg;
    const dPe = prev ? pe - prev.peOi : fromPrevClose ? chPe : null, dCe = prev ? ce - prev.ceOi : fromPrevClose ? chCe : null;
    const p = dPe != null && dCe != null ? dPe - dCe : null;
    const span = prev ? k - prev.slot : 1;
    if (prev && span > 1) gaps++;
    const dv = (cur: number | null, old: number | null) => (cur != null && old != null && cur >= old ? cur - old : null);
    const c: SmartOiCandle = {
      slot: k, label: hhmm(openMin + k * timeframe),
      spot: barSlots.get(k)?.length
        ? { open: barSlots.get(k)![0]!.o, high: Math.max(...barSlots.get(k)!.map((x) => x.h)), low: Math.min(...barSlots.get(k)!.map((x) => x.l)), close: barSlots.get(k)![barSlots.get(k)!.length - 1]!.c }
        : b.spots.length ? { open: b.spots[0]!, high: Math.max(...b.spots), low: Math.min(...b.spots), close: b.spots[b.spots.length - 1]! } : null,
      spotFromBars: !!barSlots.get(k)?.length,
      ceOi: ce, peOi: pe, dPe, dCe, p, bullish: p == null ? null : p >= 0, span,
      // day change: against yesterday's close when stored, else against the first candle (starts at 0)
      peDay: hasChg ? chPe : baseline ? pe - baseline.peOi : 0, ceDay: hasChg ? chCe : baseline ? ce - baseline.ceOi : 0,
      diffDay: hasChg ? chPe - chCe : baseline ? pe - baseline.peOi - (ce - baseline.ceOi) : 0,
      pcr: ce > 0 ? pe / ce : null,
      volPcr: cev != null && pev != null && cev > 0 ? pev / cev : null,
      ceVol: cev, peVol: pev,
      // the 09:15 candle's volume is everything traded since the open; later candles take the change in the cumulative total
      ceVolDelta: prev ? dv(cev, cumPrev?.ce ?? null) : k === 0 ? cev : null, peVolDelta: prev ? dv(pev, cumPrev?.pe ?? null) : k === 0 ? pev : null,
      fromPrevClose, strikesChanged,
    };
    if (!baseline) baseline = c;
    cumPrev = { ce: cev, pe: pev };
    candles.push(c);
  }
  // A drawn candle that opens far from the last drawn close after missing price candles in between.
  const jumps: SmartOiResult["jumps"] = [];
  let lastDrawn: SmartOiCandle | null = null;
  for (const c of candles) {
    if (!c.spot) continue;
    if (lastDrawn?.spot && c.slot - lastDrawn.slot > 1 && Math.abs(c.spot.open / lastDrawn.spot.close - 1) > JUMP_FRACTION) {
      jumps.push({ at: c.label, from: lastDrawn.spot.close, to: c.spot.open, pct: (c.spot.open / lastDrawn.spot.close - 1) * 100 });
    }
    lastDrawn = c;
  }
  return { day: useDay, timeframe, candles, baselineAt: baseline ? s.times[slots.length ? buckets.get(slots[0]!)!.lastOi : 0]! : null, gapCandles: gaps, skippedSamples: skipped, strikeChangeCandles: strikeChanges, stalls, thinBars, jumps };
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
  /** synthetic future of that sample: the forward read from put-call parity near the money */
  fwd: number | null;
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
 * (or, for "oi", no OI) is skipped and counted, never zero-filled. "dgreek" is the Greek sum minus its first value of the session (both
 * lines start at 0). `win` keeps the ATM ± n strikes of each sample ("auto") or of the first sample ("fixed"). With `otmOnly`, inside the band each sample keeps calls above
 * and puts below that sample's NIFTY level, so the two sides are different contracts.
 */
export type VegaBasis = "greek" | "dgreek" | "oi" | "change";
export interface VegaWindow { n: number; mode: "auto" | "fixed" }

/**
 * Call and put VEGA (the Greek) of the strikes in a window, at every stored sample. For each sample the chain's own prices give
 * the forward (put-call parity near spot) and every contract's implied volatility (Black-76); `vegaPt` is the change in that
 * contract's price, in rupees, for one volatility point.
 *   "greek"  sum of vegaPt over the window (one unit of each contract, no open interest)
 *   "oi"     sum of vegaPt x open interest (units): the vega of all open positions
 *   "dgreek" / "change"  the same sums as a change since the open: each strike is measured from its OWN first value of the
 *            session and only strikes with a value now and at their first sample count, so a strike that only gets its first
 *            price at 09:20 adds nothing at 09:20 instead of showing up as a build-up. Both lines start at 0 and equal
 *            "sum now minus sum at the open" whenever every strike was priced at the open.
 * `win` keeps the ATM ± n strikes of each sample ("auto") or of the first sample ("fixed"); `otmOnly` keeps calls above and puts
 * below that sample's NIFTY level. Samples outside the session are left out; a contract with no usable price (or, for the OI
 * measures, no OI) is skipped and counted, never zero-filled.
 */
export function vegaSeries(res: StrikeSeries, expiry: string, basis: VegaBasis = "greek", rate = RISK_FREE_RATE, otmOnly = false, win?: VegaWindow): VegaPoint[] {
  const listed = [...res.strikes].sort((a, b) => a - b);
  const around = (ref: number, n: number) => {
    let c = 0;
    listed.forEach((k, j) => { if (Math.abs(k - ref) < Math.abs(listed[c]! - ref)) c = j; });
    return new Set(listed.slice(Math.max(0, c - n), c + n + 1));
  };
  const weighted = basis === "oi" || basis === "change";
  const delta = basis === "dgreek" || basis === "change";
  type Vals = { ce: Map<number, number>; pe: Map<number, number> };
  const per: { t: number; spot: number; fwd: number | null; skipped: number; v: Vals }[] = [];
  res.times.forEach((iso, i) => {
    const t = new Date(iso).getTime();
    const spot = res.spot[i];
    if (!isSessionMs(t) || spot == null) return;
    const rows: OptionChainRow[] = res.strikes.map((k) => {
      const key = String(k);
      return { strike: k, call: quoteOf(res.ce_price[key]?.[i] ?? null, res.ce_oi[key]?.[i] ?? null), put: quoteOf(res.pe_price[key]?.[i] ?? null, res.pe_oi[key]?.[i] ?? null) } as OptionChainRow;
    });
    const g = chainGreeks(rows, spot, expiry, t, rate);
    const v: Vals = { ce: new Map(), pe: new Map() };
    if (weighted) {
      for (const p of exposures(rows, g.strikes, spot, "vega").points) { if (p.call != null) v.ce.set(p.strike, p.call); if (p.put != null) v.pe.set(p.strike, p.put); }
    } else {
      for (const x of g.strikes) { if (x.ce) v.ce.set(x.strike, x.ce.vegaPt); if (x.pe) v.pe.set(x.strike, x.pe.vegaPt); }
    }
    per.push({ t, spot, fwd: g.forward, skipped: g.skipped, v });
  });
  // each strike's first value of the session, per side: the zero of the change measures
  const first: Vals = { ce: new Map(), pe: new Map() };
  for (const p of per) for (const side of ["ce", "pe"] as const) for (const [k, x] of p.v[side]) if (!first[side].has(k)) first[side].set(k, x);
  const out: VegaPoint[] = [];
  let fixedSet: Set<number> | null = null;
  for (const p of per) {
    if (win && fixedSet == null) fixedSet = around(p.spot, win.n);
    const band = win ? (win.mode === "fixed" ? fixedSet! : around(p.spot, win.n)) : new Set(listed);
    const sum = (side: "ce" | "pe") => {
      const inSide = (k: number) => band.has(k) && (!otmOnly || (side === "ce" ? k > p.spot : k < p.spot));
      const xs: number[] = [];
      for (const [k, x] of p.v[side]) if (inSide(k)) xs.push(delta ? x - first[side].get(k)! : x);
      return { total: xs.length ? xs.reduce((a, b) => a + b, 0) : null, n: xs.length };
    };
    const c = sum("ce"), q = sum("pe");
    out.push({ t: p.t, spot: p.spot, fwd: p.fwd, call: c.total, put: q.total, diff: c.total != null && q.total != null ? q.total - c.total : null, callN: c.n, putN: q.n, skipped: p.skipped });
  }
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
