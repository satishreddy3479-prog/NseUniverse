/**
 * Mark-to-market (MTM) of a built strategy through time: its P&L at every stored one-minute sample, from the moment the first leg was entered; a leg counts from its own entry (a leg added later adds to the line from then on, not before).
 *
 * Per leg and instant t:
 *   - before the leg was entered: not part of the strategy yet; the strategy has no MTM until every ticked leg is in (a partial book would mislead);
 *   - while open:  P&L = earlier booked + sign x (stored price at t - entry price) x lots x lot size   (a future uses its own stored price, an option its strike's);
 *   - after its exit: P&L = what it booked (``realised``), whatever the price does afterwards.
 * ``earlier booked`` is the leg's ``realised`` before its current cycle (a re-entry or a roll), counted from the entry of the current cycle.
 * A price that was not stored at t leaves the strategy's value at t missing (a gap, counted), never zero or carried forward.
 * Pure functions: no network, no UI.
 */
import { isFuture, isExited, sign, type Leg } from "./strategy";
import type { FuturesSeries, StrikeSeries } from "./types";

export interface MtmPoint { t: number; pnl: number | null }
export interface Mtm {
  /** the instant every ticked leg was in (the series starts here), ms; null when a leg has no entry time or price */
  from: number | null;
  t: number[];
  pnl: (number | null)[];
  /** samples after ``from`` where a needed price was not stored */
  missing: number;
  now: number | null;
  peak: { pnl: number; t: number } | null;
  trough: { pnl: number; t: number } | null;
  /** largest fall from a running high to a later low, in rupees (a positive number), with when it happened */
  drawdown: { amount: number; from: number; to: number } | null;
  /** why nothing is drawn, when that is so */
  reason: string | null;
  /** legs whose entry time is not recorded (the strategy was built before the time was kept) */
  untimed: number;
}

export type Pt = [number, number | null];
export interface ZeroSplit {
  /** every sample, with an exact point added where the line crosses zero between two samples */
  full: Pt[];
  /** the same points clipped to zero from below (for the green area) and from above (for the red area) */
  pos: Pt[]; neg: Pt[];
  /** the line itself in two colours: its green part (null where it is below zero) and its red part (null where it is above) */
  linePos: Pt[]; lineNeg: Pt[];
}
/**
 * The mark-to-market series prepared for drawing in two colours. Between two consecutive samples on opposite sides of zero the crossing is found by
 * straight-line interpolation and added as a point at exactly zero, so the green area, the red area and the two parts of the line all meet at the
 * crossing, not at the next sample. A gap (a missing value) stays a gap.
 */
export function splitAtZero(t: readonly number[], pnl: readonly (number | null)[]): ZeroSplit {
  const full: Pt[] = [];
  for (let i = 0; i < t.length; i++) {
    const v = pnl[i] ?? null, p = i > 0 ? pnl[i - 1] ?? null : null;
    if (v != null && p != null && ((p < 0 && v > 0) || (p > 0 && v < 0))) full.push([t[i - 1]! + ((0 - p) / (v - p)) * (t[i]! - t[i - 1]!), 0]);
    full.push([t[i]!, v]);
  }
  return {
    full,
    pos: full.map(([x, v]) => [x, v == null ? null : Math.max(v, 0)]),
    neg: full.map(([x, v]) => [x, v == null ? null : Math.min(v, 0)]),
    linePos: full.map(([x, v]) => [x, v != null && v >= 0 ? v : null]),
    lineNeg: full.map(([x, v]) => [x, v != null && v <= 0 ? v : null]),
  };
}

const priceIn = (map: Record<string, (number | null)[]>, strike: number, i: number): number | null => {
  const arr = map[String(strike)] ?? map[strike.toFixed(1)] ?? map[Object.keys(map).find((k) => Number(k) === strike) ?? ""];
  const v = arr?.[i];
  return v == null || !(v > 0) ? null : v;
};

/** The leg's stored price series on the grid ``grid`` (ms), nearest sample within ``tol``; null where none. */
function legPrices(l: Leg, grid: number[], byExpiry: Record<string, StrikeSeries | undefined>, fut: FuturesSeries | undefined, tol: number): (number | null)[] {
  if (isFuture(l)) {
    if (!fut || fut.expiry !== l.expiry) return grid.map(() => null); // the stored future series is the current contract only
    const ft = fut.times.map((x) => Date.parse(x));
    return grid.map((g) => nearest(ft, g, tol, (j) => (fut.future[j] != null && fut.future[j]! > 0 ? fut.future[j]! : null)));
  }
  const ss = byExpiry[l.expiry];
  if (!ss) return grid.map(() => null);
  const st = ss.times.map((x) => Date.parse(x));
  const map = l.type === "CE" ? ss.ce_price : ss.pe_price;
  return grid.map((g) => nearest(st, g, tol, (j) => priceIn(map, l.strike, j)));
}

function nearest(ts: number[], g: number, tol: number, at: (j: number) => number | null): number | null {
  let lo = 0, hi = ts.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m]! < g) lo = m + 1; else hi = m; }
  let best = -1, bd = Infinity;
  for (const j of [lo - 1, lo]) if (j >= 0 && j < ts.length) { const d = Math.abs(ts[j]! - g); if (d < bd) { bd = d; best = j; } }
  return best >= 0 && bd <= tol ? at(best) : null;
}

export function buildMtm(legsIn: readonly Leg[], lotSize: number, byExpiry: Record<string, StrikeSeries | undefined>, fut: FuturesSeries | undefined, opts: { tolMs?: number } = {}): Mtm {
  const empty = (reason: string, extra: Partial<Mtm> = {}): Mtm => ({ from: null, t: [], pnl: [], missing: 0, now: null, peak: null, trough: null, drawdown: null, reason, untimed: 0, ...extra });
  const legs = legsIn.filter((l) => l.enabled !== false);
  if (legs.length === 0) return empty("Add at least one leg.");
  if (legs.some((l) => l.premium == null)) return empty("Enter the entry price of every leg: the P&L is measured from it.");
  const entered = legs.map((l) => (l.enteredAt ? Date.parse(l.enteredAt) : NaN));
  const untimed = entered.filter((x) => Number.isNaN(x)).length;
  if (untimed > 0) return empty(`${untimed} leg${untimed === 1 ? " has" : "s have"} no recorded entry time (built before the time was kept): the mark-to-market cannot say when the position began. Enter the leg again to start it.`, { untimed });
  const from = Math.min(...entered);
  // the sample grid: the option series of the first leg that has one, else the future's
  const firstOpt = legs.find((l) => !isFuture(l) && byExpiry[l.expiry]);
  const gridSrc = firstOpt ? byExpiry[firstOpt.expiry]!.times : fut?.times ?? [];
  const grid = gridSrc.map((x) => Date.parse(x)).filter((x) => Number.isFinite(x) && x >= from);
  if (grid.length === 0) return empty("No stored sample since the first leg was entered yet. The sampler stores one a minute in market hours.", { from });
  const tol = opts.tolMs ?? 90_000;
  const px = legs.map((l) => legPrices(l, grid, byExpiry, fut, tol));
  const t: number[] = [], pnl: (number | null)[] = [];
  let missing = 0;
  for (let i = 0; i < grid.length; i++) {
    let total = 0, ok = true;
    for (let k = 0; k < legs.length; k++) {
      const l = legs[k]!;
      if (grid[i]! < entered[k]!) continue; // not in the market yet: it adds nothing before its own entry
      const exitedAt = isExited(l) && l.exitedAt ? Date.parse(l.exitedAt) : null;
      if (isExited(l) && (exitedAt == null || grid[i]! >= exitedAt)) { total += l.realised ?? 0; continue; } // out: what it booked
      const p = px[k]![i];
      if (p == null) { ok = false; break; }
      const q = sign(l.action) * l.lots * lotSize;
      // booked before this cycle = realised minus this cycle's result when the leg is already out (then it is read only before its exit)
      const cycle = isExited(l) ? q * ((l.exitPrice as number) - (l.premium as number)) : 0;
      const prior = (l.realised ?? 0) - cycle;
      total += prior + q * (p - (l.premium as number));
    }
    t.push(grid[i]!); pnl.push(ok ? total : null);
    if (!ok) missing++;
  }
  const have = pnl.map((v, i) => (v == null ? null : { v, t: t[i]! })).filter((x): x is { v: number; t: number } => x != null);
  if (have.length === 0) return empty("The stored prices of the legs do not overlap in time yet.", { from, t, pnl, missing });
  let peak = have[0]!, trough = have[0]!, run = have[0]!, dd: Mtm["drawdown"] = null;
  for (const h of have) {
    if (h.v > peak.v) peak = h;
    if (h.v < trough.v) trough = h;
    if (h.v > run.v) run = h;
    if (run.v - h.v > (dd?.amount ?? 0)) dd = { amount: run.v - h.v, from: run.t, to: h.t };
  }
  return { from, t, pnl, missing, now: have[have.length - 1]!.v, peak: { pnl: peak.v, t: peak.t }, trough: { pnl: trough.v, t: trough.t }, drawdown: dd, reason: null, untimed: 0 };
}

// ---------------------------------------------------------------- live ticks
/** The P&L seen live, tick by tick: a point is kept only when the value changed, and the oldest are thinned (every second one dropped) past ``cap`` so a long day stays small. */
export function appendTick(series: readonly { t: number; v: number }[], t: number, v: number, cap = 6000): { t: number; v: number }[] {
  const last = series[series.length - 1];
  if (last && last.v === v) return series as { t: number; v: number }[];
  let out = [...series, { t, v }];
  if (out.length > cap) out = out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
  return out;
}
/** Stored samples up to the first live tick, then the live ticks: the stored part is the history from before the page was open, the rest is what was seen live. */
export function joinLive(stored: readonly MtmPoint[], live: readonly { t: number; v: number }[]): { t: number; v: number }[] {
  const first = live[0]?.t ?? Infinity;
  const old = stored.filter((p): p is { t: number; pnl: number } => p.pnl != null && p.t < first).map((p) => ({ t: p.t, v: p.pnl }));
  return [...old, ...live];
}
export interface MtmStats { now: number | null; high: { v: number; t: number } | null; low: { v: number; t: number } | null; drawdown: { amount: number; from: number; to: number } | null; points: number }
/** Latest value, highest and lowest value, and the largest fall from a running high to a later low, over a series of points. */
export function mtmStats(pts: readonly { t: number; v: number }[]): MtmStats {
  if (pts.length === 0) return { now: null, high: null, low: null, drawdown: null, points: 0 };
  let high = pts[0]!, low = pts[0]!, run = pts[0]!, dd: MtmStats["drawdown"] = null;
  for (const p of pts) {
    if (p.v > high.v) high = p;
    if (p.v < low.v) low = p;
    if (p.v > run.v) run = p;
    if (run.v - p.v > (dd?.amount ?? 0)) dd = { amount: run.v - p.v, from: run.t, to: p.t };
  }
  return { now: pts[pts.length - 1]!.v, high: { v: high.v, t: high.t }, low: { v: low.v, t: low.t }, drawdown: dd, points: pts.length };
}
