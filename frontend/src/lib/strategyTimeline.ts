/**
 * The strategy as a price through time, from the stored one-minute samples (pure functions; the Strategy builder draws what this returns).
 *
 * For the legs ticked in the builder, at every stored sample:
 *   value[t]  = Σ sign × lots × price(leg, t)            net debit in index points per lot-multiple (BUY +, SELL −); a short straddle is negative
 *   display   = −value for a net-credit structure (so a sold straddle reads as the premium to buy it back), value otherwise
 *   pnl[t]    = Σ sign × lots × lot size × (price(leg, t) − entry premium)    rupees, needs every leg's entry premium
 * Prices are last traded prices of stored samples, not bid/ask. A sample where a leg has no price gives null; nothing is carried forward or
 * interpolated. Averages, moving averages and bands restart at each IST day; a one-sample spacer separates days so no line crosses a night.
 *
 * Strategy VWAP: each leg's own volume-weighted average price since the day's first sample, Σ price × interval volume / Σ interval volume, where the
 * interval volume is the rise of the contract's stored cumulative traded volume between two samples (the first sample of a day carries the volume
 * traded since the open). The strategy VWAP is the same signed, lot-weighted sum of the legs' VWAPs as the strategy value: what building the structure
 * at every leg's volume-weighted average would have cost. It needs a volume for every leg; until each leg has traded, it is null. Interval volume
 * is priced at the last traded price of the sample that closes the interval (samples are about a minute apart).
 * Future VWAP: the same calculation on the NIFTY current-month future with its volume per minute.
 *
 * The spot-driven / other split is a regression estimate over the shown range, not a model Greek: ΔP&L over a few samples against Δ spot gives an
 * empirical delta (rupees per index point). Spot-driven = that delta × (spot − first spot); the rest (time decay, volatility, strike and
 * curvature effects, noise) is the residual.
 */
import type { Action, OptionType } from "./strategy";
import type { FuturesSeries, StrikeSeries } from "./types";

export interface TimelineLeg { strike: number; type: OptionType; action: Action; lots: number; premium: number | null; /** key of this leg in the series maps when it is not the plain strike (a merged multi-expiry series) */ key?: string }

export interface Timeline {
  /** ms since epoch; a spacer between days has t = the next day's first sample and every value null */
  t: number[];
  day: string[];
  label: string[];
  spacer: boolean[];
  spot: (number | null)[];
  value: (number | null)[];
  display: (number | null)[];
  pnl: (number | null)[];
  /** strategy VWAP in the same units as ``display`` / ``pnl`` (null until every leg has traded that day) */
  vwap: (number | null)[];
  vwapPnl: (number | null)[];
  /** the lowest, over the legs, of the contracts traded today in the newest sample: how thin the least-traded leg is */
  thinnestLegVolume: number | null;
  isCredit: boolean;
  /** samples (excluding spacers) where at least one leg had no stored price */
  missing: number;
  samples: number;
}

const IST_MS = 330 * 60_000;
export const istDay = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);
const hm = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(11, 16);
const sgn = (a: Action) => (a === "BUY" ? 1 : -1);

function priceAt(map: Record<string, (number | null)[]>, strike: number, i: number, key?: string): number | null {
  const arr = key != null ? map[key] : map[String(strike)] ?? map[strike.toFixed(1)] ?? map[Object.keys(map).find((k) => Number(k) === strike) ?? ""];
  const v = arr?.[i];
  return v == null ? null : v;
}

export function buildTimeline(legs: TimelineLeg[], ss: StrikeSeries, lotSize: number, opts: { days?: number } = {}): Timeline {
  const times = ss.times.map((x) => Date.parse(x));
  const keepFrom = (() => {
    const days = [...new Set(times.filter((x) => !Number.isNaN(x)).map(istDay))].sort();
    return days.slice(-(opts.days ?? 1))[0] ?? "";
  })();
  const out: Timeline = { t: [], day: [], label: [], spacer: [], spot: [], value: [], display: [], pnl: [], vwap: [], vwapPnl: [], thinnestLegVolume: null, isCredit: false, missing: 0, samples: 0 };
  const allEntry = legs.length > 0 && legs.every((l) => l.premium != null);
  type Acc = { pv: number; v: number; prevVol: number | null } | null;
  const acc: Acc[] = legs.map(() => null);
  let prevDay: string | null = null;
  const multi = (opts.days ?? 1) > 1;
  for (let i = 0; i < times.length; i++) {
    const ms = times[i]!;
    if (Number.isNaN(ms)) continue;
    const d = istDay(ms);
    if (d < keepFrom) continue;
    if (prevDay != null && d !== prevDay) {
      out.t.push(ms); out.day.push(d); out.label.push(""); out.spacer.push(true);
      out.spot.push(null); out.value.push(null); out.display.push(null); out.pnl.push(null); out.vwap.push(null); out.vwapPnl.push(null);
      acc.fill(null);
    }
    prevDay = d;
    let v: number | null = 0;
    let p: number | null = allEntry ? 0 : null;
    legs.forEach((l, li) => {
      const px = priceAt(l.type === "CE" ? ss.ce_price : ss.pe_price, l.strike, i, l.key);
      // interval volume of this leg: the rise of its cumulative volume since the previous sample of the same day (the first sample: all of it)
      const cum = priceAt(l.type === "CE" ? ss.ce_volume ?? {} : ss.pe_volume ?? {}, l.strike, i, l.key);
      const a: NonNullable<Acc> = acc[li] ?? { pv: 0, v: 0, prevVol: null };
      acc[li] = a;
      if (cum != null) {
        const dv = a.prevVol == null ? cum : cum - a.prevVol;
        if (dv > 0 && px != null) { a.pv += px * dv; a.v += dv; }
        a.prevVol = cum;
      }
      if (px == null || v == null) { v = null; p = null; return; }
      v += sgn(l.action) * l.lots * px;
      if (p != null && l.premium != null) p += sgn(l.action) * l.lots * lotSize * (px - l.premium);
    });
    // strategy VWAP: the legs' own VWAPs combined exactly like the strategy value; needs every leg to have traded
    let vw: number | null = 0, vwp: number | null = allEntry ? 0 : null;
    legs.forEach((l, li) => {
      const a = acc[li];
      if (!a || a.v <= 0) { vw = null; vwp = null; return; }
      const lv = a.pv / a.v;
      if (vw != null) vw += sgn(l.action) * l.lots * lv;
      if (vwp != null && l.premium != null) vwp += sgn(l.action) * l.lots * lotSize * (lv - l.premium);
    });
    out.vwap.push(vw); out.vwapPnl.push(vwp);
    out.thinnestLegVolume = legs.length ? Math.min(...legs.map((l) => priceAt(l.type === "CE" ? ss.ce_volume ?? {} : ss.pe_volume ?? {}, l.strike, i, l.key) ?? 0)) : null;
    out.samples++;
    if (v == null) out.missing++;
    out.t.push(ms); out.day.push(d); out.spacer.push(false);
    out.label.push(multi ? `${d.slice(5)} ${hm(ms)}` : hm(ms));
    out.spot.push(ss.spot[i] ?? null);
    out.value.push(v); out.pnl.push(p);
    out.display.push(v);
  }
  const first = out.value.find((x) => x != null);
  out.isCredit = first != null && first < 0;
  if (out.isCredit) for (let i = 0; i < out.display.length; i++) { out.display[i] = out.value[i] == null ? null : -(out.value[i] as number); out.vwap[i] = out.vwap[i] == null ? null : -(out.vwap[i] as number); }
  return out;
}

/** Runs of consecutive indices with the same key (days), as [start, end] inclusive, skipping spacer rows (those are ``null`` keys). */
function segments(day: readonly string[], spacer: readonly boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  for (let i = 0; i < day.length; i++) {
    if (spacer[i]) { if (s >= 0) out.push([s, i - 1]); s = -1; continue; }
    if (s >= 0 && day[i] !== day[s]) { out.push([s, i - 1]); s = i; }
    if (s < 0) s = i;
  }
  if (s >= 0) out.push([s, day.length - 1]);
  return out;
}

/** Simple moving average of the last ``n`` valid values; null until ``n`` valid values exist (restarts each day). */
export function sma(values: readonly (number | null)[], n: number, tl: Pick<Timeline, "day" | "spacer">): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  for (const [a, b] of segments(tl.day, tl.spacer)) {
    const win: number[] = [];
    for (let i = a; i <= b; i++) {
      const v = values[i];
      if (v == null) continue;
      win.push(v);
      if (win.length > n) win.shift();
      if (win.length === n) out[i] = win.reduce((x, y) => x + y, 0) / n;
    }
  }
  return out;
}

/** Exponential moving average with smoothing 2/(n+1), seeded by the simple average of the first ``n`` valid values (restarts each day). */
export function ema(values: readonly (number | null)[], n: number, tl: Pick<Timeline, "day" | "spacer">): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const k = 2 / (n + 1);
  for (const [a, b] of segments(tl.day, tl.spacer)) {
    const seed: number[] = [];
    let e: number | null = null;
    for (let i = a; i <= b; i++) {
      const v = values[i];
      if (v == null) continue;
      if (e == null) { seed.push(v); if (seed.length === n) { e = seed.reduce((x, y) => x + y, 0) / n; out[i] = e; } } else { e = v * k + e * (1 - k); out[i] = e; }
    }
  }
  return out;
}

/** Bollinger bands: SMA of the last ``n`` valid values ± ``k`` population standard deviations. */
export function bands(values: readonly (number | null)[], n: number, k: number, tl: Pick<Timeline, "day" | "spacer">): { mid: (number | null)[]; up: (number | null)[]; low: (number | null)[] } {
  const mid = sma(values, n, tl);
  const up: (number | null)[] = values.map(() => null);
  const low: (number | null)[] = values.map(() => null);
  for (const [a, b] of segments(tl.day, tl.spacer)) {
    const win: number[] = [];
    for (let i = a; i <= b; i++) {
      const v = values[i];
      if (v == null) continue;
      win.push(v);
      if (win.length > n) win.shift();
      if (win.length === n) {
        const m = mid[i]!;
        const sd = Math.sqrt(win.reduce((x, y) => x + (y - m) ** 2, 0) / n);
        up[i] = m + k * sd; low[i] = m - k * sd;
      }
    }
  }
  return { mid, up, low };
}

/** Running weighted average Σ v·w / Σ w from the day's first sample (restarts each day). Samples without a value or with weight ≤ 0 are skipped; null until the first. */
export function cumWeighted(values: readonly (number | null)[], weights: readonly (number | null)[], tl: Pick<Timeline, "day" | "spacer">): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  for (const [a, b] of segments(tl.day, tl.spacer)) {
    let sw = 0, sv = 0;
    for (let i = a; i <= b; i++) {
      const v = values[i], w = weights[i];
      if (v != null && w != null && w > 0) { sw += w; sv += v * w; }
      if (sw > 0) out[i] = sv / sw;
    }
  }
  return out;
}

/** Running plain average from the day's first valid sample (time-weighted, since samples are about a minute apart). */
export function cumMean(values: readonly (number | null)[], tl: Pick<Timeline, "day" | "spacer">): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  for (const [a, b] of segments(tl.day, tl.spacer)) {
    let n = 0, s = 0;
    for (let i = a; i <= b; i++) {
      const v = values[i];
      if (v != null) { n++; s += v; }
      if (n > 0) out[i] = s / n;
    }
  }
  return out;
}

/** The future's price and per-minute volume at each timeline sample: the nearest futures sample within ``tolMs``, otherwise null (never carried). */
export function alignFuture(tl: Pick<Timeline, "t" | "spacer">, f: FuturesSeries | undefined, tolMs = 90_000): { future: (number | null)[]; volume: (number | null)[] } {
  const future: (number | null)[] = tl.t.map(() => null);
  const volume: (number | null)[] = tl.t.map(() => null);
  if (!f || f.times.length === 0) return { future, volume };
  const ft = f.times.map((x) => Date.parse(x));
  let j = 0;
  for (let i = 0; i < tl.t.length; i++) {
    if (tl.spacer[i]) continue;
    while (j + 1 < ft.length && Math.abs(ft[j + 1]! - tl.t[i]!) <= Math.abs(ft[j]! - tl.t[i]!)) j++;
    if (Math.abs(ft[j]! - tl.t[i]!) <= tolMs) { future[i] = f.future[j] ?? null; volume[i] = f.volume_per_min[j] ?? null; }
  }
  return { future, volume };
}

export interface Regression { beta: number; r2: number; n: number; lag: number }

/** Least-squares slope of Δy on Δx over ``lag`` samples (within a day, both ends valid). beta = y change per x unit; r2 = share of y's variance it explains. */
export function regress(x: readonly (number | null)[], y: readonly (number | null)[], tl: Pick<Timeline, "day" | "spacer">, lag = 5): Regression | null {
  const dx: number[] = [], dy: number[] = [];
  for (let i = lag; i < x.length; i++) {
    if (tl.spacer[i] || tl.spacer[i - lag] || tl.day[i] !== tl.day[i - lag]) continue;
    const a = x[i], b = x[i - lag], c = y[i], d = y[i - lag];
    if (a == null || b == null || c == null || d == null) continue;
    dx.push(a - b); dy.push(c - d);
  }
  if (dx.length < 20) return null;
  const mx = dx.reduce((s, v) => s + v, 0) / dx.length, my = dy.reduce((s, v) => s + v, 0) / dy.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < dx.length; i++) { sxx += (dx[i]! - mx) ** 2; sxy += (dx[i]! - mx) * (dy[i]! - my); syy += (dy[i]! - my) ** 2; }
  if (sxx === 0) return null;
  return { beta: sxy / sxx, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy), n: dx.length, lag };
}

/** Split the P&L change since the first sample into the part a constant empirical delta explains and the rest. */
export function decompose(pnl: readonly (number | null)[], spot: readonly (number | null)[], beta: number): { explained: (number | null)[]; rest: (number | null)[] } {
  const i0 = pnl.findIndex((v, i) => v != null && spot[i] != null);
  const explained: (number | null)[] = pnl.map(() => null);
  const rest: (number | null)[] = pnl.map(() => null);
  if (i0 < 0) return { explained, rest };
  const p0 = pnl[i0]!, s0 = spot[i0]!;
  for (let i = i0; i < pnl.length; i++) {
    if (pnl[i] == null || spot[i] == null) continue;
    const e = beta * (spot[i]! - s0);
    explained[i] = e; rest[i] = pnl[i]! - p0 - e;
  }
  return { explained, rest };
}

export interface TimelineStats {
  open: number | null; high: number | null; low: number | null; now: number | null;
  change: number | null; changePct: number | null;
  mean: number | null; vsMean: number | null; zScore: number | null; percentile: number | null;
  pnlNow: number | null; pnlHigh: number | null; pnlLow: number | null; maxDrawdown: number | null;
  spotMove: number | null;
}

/** Summary of the newest day in the series. ``percentile`` = share of that day's valid values that are at or below the latest one. */
export function timelineStats(tl: Timeline): TimelineStats {
  const lastIdx = tl.spacer.lastIndexOf(false);
  const lastDay = lastIdx >= 0 ? tl.day[lastIdx] : undefined;
  const idx = tl.day.map((d, i) => (d === lastDay && !tl.spacer[i] && tl.display[i] != null ? i : -1)).filter((i) => i >= 0);
  const empty: TimelineStats = { open: null, high: null, low: null, now: null, change: null, changePct: null, mean: null, vsMean: null, zScore: null, percentile: null, pnlNow: null, pnlHigh: null, pnlLow: null, maxDrawdown: null, spotMove: null };
  if (idx.length === 0) return empty;
  const v = idx.map((i) => tl.display[i] as number);
  const open = v[0]!, now = v[v.length - 1]!;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const pn = idx.map((i) => tl.pnl[i]).filter((x): x is number => x != null);
  let peak = -Infinity, dd = 0;
  for (const p of pn) { peak = Math.max(peak, p); dd = Math.min(dd, p - peak); }
  const sp = idx.map((i) => tl.spot[i]).filter((x): x is number => x != null);
  return {
    open, high: Math.max(...v), low: Math.min(...v), now, change: now - open, changePct: open !== 0 ? ((now - open) / Math.abs(open)) * 100 : null,
    mean, vsMean: now - mean, zScore: sd > 0 ? (now - mean) / sd : null, percentile: (v.filter((x) => x <= now).length / v.length) * 100,
    pnlNow: pn.length ? pn[pn.length - 1]! : null, pnlHigh: pn.length ? Math.max(...pn) : null, pnlLow: pn.length ? Math.min(...pn) : null, maxDrawdown: pn.length ? dd : null,
    spotMove: sp.length > 1 ? sp[sp.length - 1]! - sp[0]! : null,
  };
}


/**
 * One series for legs on several expiries. Every expiry's stored samples have their own timestamps (the sampler fetches the chains one after
 * the other), so the others are laid on the base expiry's time axis: each base sample takes the nearest sample of the other expiry within
 * ``tolMs``, else null (never carried, never interpolated). Keys of the merged maps are ``"<expiry>:<strike>"``; a leg of the merged series
 * carries that key (``mergedKey``).
 */
export const mergedKey = (expiry: string, strike: number): string => `${expiry}:${strike}`;

export function mergeStrikeSeries(parts: { expiry: string; ss: StrikeSeries }[], tolMs = 90_000): StrikeSeries {
  const base = parts[0]!.ss;
  const bt = base.times.map((x) => Date.parse(x));
  const out: StrikeSeries = { ...base, strikes: [], ce_price: {}, pe_price: {}, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {}, ce_volume: {}, pe_volume: {}, warnings: [] };
  for (const { expiry, ss } of parts) {
    const t = ss.times.map((x) => Date.parse(x));
    const idx: (number | null)[] = [];
    let j = 0;
    for (const ms of bt) {
      while (j + 1 < t.length && Math.abs(t[j + 1]! - ms) <= Math.abs(t[j]! - ms)) j++;
      idx.push(t.length > 0 && Math.abs(t[j]! - ms) <= tolMs ? j : null);
    }
    const take = (arr: (number | null)[] | undefined) => idx.map((k) => (k == null ? null : arr?.[k] ?? null));
    for (const k of Object.keys(ss.ce_price)) {
      const key = mergedKey(expiry, Number(k));
      out.ce_price[key] = take(ss.ce_price[k]); out.pe_price[key] = take(ss.pe_price[k]);
      out.ce_volume![key] = take(ss.ce_volume?.[k]); out.pe_volume![key] = take(ss.pe_volume?.[k]);
    }
  }
  return out;
}
