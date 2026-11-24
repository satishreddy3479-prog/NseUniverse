/**
 * Intraday trend / range regime of the NIFTY 50 session so far, from price only (lib/trendStats.ts). DESCRIPTIVE and NOT validated:
 * it labels how the day has behaved, it does not predict.
 *
 * Four independent readings of the last ``window`` bars are each turned into a 0-1 trend score by a linear ramp between a "no trend" level and a
 * "full trend" level (so a reading just short of a line counts as nearly there, not as nothing):
 *   efficiency ratio   0.15 -> 0   0.45 -> 1      (a straight line is 1, a random walk of 12 bars averages about 0.2)
 *   ADX (Wilder)       15   -> 0   35   -> 1      (the usual "no trend" below 20 and "strong trend" above 25 to 40 reading)
 *   regression R^2     0.20 -> 0   0.80 -> 1
 *   choppiness index   61.8 -> 0   38.2 -> 1      (the Fibonacci levels the indicator's author gave)
 * The trend score is the mean of the readings that could be computed (at least 3). The label comes from the score with a margin of 0.05 before it
 * moves to a neighbouring class (so it does not flicker on a boundary), and after that only changes when the new class has held ``minDwell`` bars:
 *   score >= 0.65 Trending, 0.45-0.65 Weak trend, 0.30-0.45 Mixed, < 0.30 Range-bound.
 * Direction is the sign of the regression slope; +DI against -DI must not contradict it, otherwise the bar is Mixed. The scales and the cut-offs are
 * conventional and uncalibrated; none was fitted to data. "Agreement" is how many of the evaluable readings sit on the label's side of the midpoint
 * (score above 0.5 for a trend label, below 0.5 for range): it is a count, not a probability.
 */
import { adx, aggregate, choppiness, efficiencyRatio, istMinute, regression, type RBar } from "./trendStats";
import type { IndexBar } from "./types";

export type RegimeLabel = "Trending up" | "Trending down" | "Weak uptrend" | "Weak downtrend" | "Range-bound" | "Mixed" | "Warming up";
export const LABELS: RegimeLabel[] = ["Trending up", "Trending down", "Weak uptrend", "Weak downtrend", "Range-bound", "Mixed", "Warming up"];

/** [score 0 at, score 1 at] for each reading. */
export const SCALES = { er: [0.15, 0.45], adx: [15, 35], r2: [0.2, 0.8], chop: [61.8, 38.2] } as const;
/** Lower bounds of the classes by trend score (Range-bound starts at 0), and the margin needed to cross one. */
export const BANDS = { mixed: 0.3, weak: 0.45, trend: 0.65, margin: 0.05 } as const;

export interface RegimeParams { tf: number; window: number; adxN: number; minDwell: number; minWindow: number }
/** The look-back in bars that spans about an hour at each bar length. */
export const WINDOW_FOR_TF: Record<number, number> = { 1: 30, 3: 20, 5: 12, 15: 8 };
export const DEFAULT_PARAMS: RegimeParams = { tf: 5, window: 12, adxN: 14, minDwell: 3, minWindow: 6 };

export interface RegimeMetrics { er: number | null; adx: number | null; plusDi: number | null; minusDi: number | null; r2: number | null; slope: number | null; chop: number | null }
export interface RegimeScores { er: number | null; adx: number | null; r2: number | null; chop: number | null }
export interface RegimePoint {
  t: number;
  /** label shown (after the margin and dwell rules) and the label of this bar alone after the margin rule */
  label: RegimeLabel; raw: RegimeLabel;
  /** trend score 0-1 (null while warming up) and the four readings' own 0-1 scores */
  score: number | null; scores: RegimeScores;
  /** readings on the label's side of the midpoint, of those evaluated (null for Mixed and Warming up) */
  agreement: { agree: number; of: number } | null;
  metrics: RegimeMetrics;
  /** the window this bar's readings used, in bars (shorter than the standard one early in the session) */
  window: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (v: number | null, [a, b]: readonly [number, number]): number | null => (v == null ? null : clamp01((v - a) / (b - a)));

/** The 0-1 trend score of each reading, and their mean (null with fewer than 3 readings). */
export function trendScore(m: RegimeMetrics): { score: number | null; scores: RegimeScores } {
  const scores: RegimeScores = { er: ramp(m.er, SCALES.er), adx: ramp(m.adx, SCALES.adx), r2: ramp(m.r2, SCALES.r2), chop: ramp(m.chop, SCALES.chop) };
  const v = Object.values(scores).filter((x): x is number => x != null);
  return { score: v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null, scores };
}

/** Class index of a score by the plain cut-offs: 0 Range-bound, 1 Mixed, 2 Weak trend, 3 Trending. */
const classOf = (t: number) => (t >= BANDS.trend ? 3 : t >= BANDS.weak ? 2 : t >= BANDS.mixed ? 1 : 0);
const LOWER = [0, BANDS.mixed, BANDS.weak, BANDS.trend] as const;
const EPS = 1e-9; // a score exactly on a boundary must not be decided by floating point (0.65 + 0.05 is 0.7000000000000001)

/** The class after this score given the previous class: it moves up only when the score is ``margin`` past the new class's lower bound, and down only when it is ``margin`` under its own. */
export function stepClass(prev: number | null, t: number): number {
  if (prev == null) return classOf(t);
  let p = prev;
  while (p < 3 && t >= LOWER[p + 1]! + BANDS.margin - EPS) p++;
  while (p > 0 && t < LOWER[p]! - BANDS.margin - EPS) p--;
  return p;
}

/** The label of a class with its direction; a direction that the +DI / -DI lines contradict makes a trend class Mixed. */
export function labelFor(cls: number, m: RegimeMetrics): RegimeLabel {
  if (cls === 0) return "Range-bound";
  if (cls === 1) return "Mixed";
  if (m.slope == null || m.slope === 0) return "Mixed";
  const up = m.slope > 0;
  if (m.plusDi != null && m.minusDi != null && (up ? m.plusDi < m.minusDi : m.minusDi < m.plusDi)) return "Mixed";
  return cls === 3 ? (up ? "Trending up" : "Trending down") : up ? "Weak uptrend" : "Weak downtrend";
}

/** The displayed label series from the per-bar labels: it switches to a new label only after that label has been seen ``minDwell`` times in a row. */
export function applyDwell<T>(raw: T[], minDwell: number): T[] {
  const out: T[] = [];
  let shown: T | undefined;
  let cand: T | undefined;
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (i === 0) shown = r;
    else if (r === shown) { cand = undefined; count = 0; }
    else {
      if (r === cand) count++;
      else { cand = r; count = 1; }
      if (count >= minDwell) { shown = r; cand = undefined; count = 0; }
    }
    out.push(shown as T);
  }
  return out;
}

/** How many of the evaluated readings are on the side of the midpoint the label names. */
function agreementOf(label: RegimeLabel, s: RegimeScores): { agree: number; of: number } | null {
  if (label === "Mixed" || label === "Warming up") return null;
  const v = Object.values(s).filter((x): x is number => x != null);
  return { agree: v.filter((x) => (label === "Range-bound" ? x < 0.5 : x > 0.5)).length, of: v.length };
}

export interface RegimeSeries { bars: RBar[]; points: RegimePoint[]; params: RegimeParams }

/** The regime at every bar of the session so far (causal: bar i uses bars 0..i only), on ``params.tf``-minute bars made from the one-minute bars.
 *  Early in the session the look-back is the bars there are (at least ``minWindow``), so the first labels come after about half an hour, not a full window. */
export function regimeSeries(oneMin: RBar[], params: Partial<RegimeParams> = {}): RegimeSeries {
  const tf = params.tf ?? DEFAULT_PARAMS.tf;
  const p: RegimeParams = { ...DEFAULT_PARAMS, window: WINDOW_FOR_TF[tf] ?? DEFAULT_PARAMS.window, ...params };
  const bars = aggregate(oneMin, p.tf);
  const dmi = adx(bars, p.adxN);
  const closes = bars.map((b) => b.c);
  let cls: number | null = null;
  const rows = bars.map((b, i) => {
    const w = Math.min(p.window, i);
    const upTo = closes.slice(0, i + 1);
    const ok = w >= p.minWindow;
    const reg = ok ? regression(upTo, w) : null;
    const metrics: RegimeMetrics = {
      er: ok ? efficiencyRatio(upTo, w) : null, adx: dmi[i]!.adx, plusDi: dmi[i]!.plusDi, minusDi: dmi[i]!.minusDi,
      r2: reg?.r2 ?? null, slope: reg?.slope ?? null, chop: ok ? choppiness(bars.slice(0, i + 1), w) : null,
    };
    const { score, scores } = trendScore(metrics);
    let raw: RegimeLabel = "Warming up";
    if (score != null) { cls = stepClass(cls, score); raw = labelFor(cls, metrics); }
    return { t: b.t, metrics, score, scores, raw, window: w };
  });
  const shown = applyDwell(rows.map((r) => r.raw), p.minDwell);
  const points: RegimePoint[] = rows.map((r, i) => ({ t: r.t, label: shown[i] as RegimeLabel, raw: r.raw, score: r.score, scores: r.scores, agreement: agreementOf(shown[i] as RegimeLabel, r.scores), metrics: r.metrics, window: r.window }));
  return { bars, points, params: p };
}

/** Time spent in each shown label, in bars, and the number of label changes: a day with many changes is itself a sign of no clear regime. */
export function regimeSummary(points: RegimePoint[]): { counts: Partial<Record<RegimeLabel, number>>; changes: number } {
  const counts: Partial<Record<RegimeLabel, number>> = {};
  let changes = 0;
  points.forEach((p, i) => {
    counts[p.label] = (counts[p.label] ?? 0) + 1;
    if (i > 0 && p.label !== points[i - 1]!.label && points[i - 1]!.label !== "Warming up") changes++;
  });
  return { counts, changes };
}

export type ForwardClass = "trending" | "weak" | "range" | "mixed";
export interface ForwardCheck { n: number; meanForwardEr: number | null }

/** A stored-session check of the label, NOT a validation: for every bar with a shown label, the efficiency ratio of the next ``horizon`` bars, averaged by label class.
 *  The windows overlap, so the bars are not independent samples and no significance is claimed; a handful of sessions cannot validate anything. */
export function forwardCheck(series: RegimeSeries, horizon = 12): Record<ForwardClass, ForwardCheck> {
  const acc: Record<ForwardClass, number[]> = { trending: [], weak: [], range: [], mixed: [] };
  const closes = series.bars.map((b) => b.c);
  series.points.forEach((p, i) => {
    if (i + horizon >= closes.length || p.label === "Warming up") return;
    const er = efficiencyRatio(closes.slice(i, i + horizon + 1), horizon);
    if (er == null) return;
    acc[p.label === "Range-bound" ? "range" : p.label === "Mixed" ? "mixed" : p.label.startsWith("Weak") ? "weak" : "trending"].push(er);
  });
  const mk = (v: number[]): ForwardCheck => ({ n: v.length, meanForwardEr: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null });
  return { trending: mk(acc.trending), weak: mk(acc.weak), range: mk(acc.range), mixed: mk(acc.mixed) };
}

/** One-minute index bars as indicator bars. */
export const fromIndexBars = (bars: readonly IndexBar[]): RBar[] => bars.map((b) => ({ t: Date.parse(b.at), o: b.o, h: b.h, l: b.l, c: b.c }));

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The shown label for each chart candle (by its HH:MM slot start, ``tf`` minutes long, from 09:15); null where the regime has no bar for that slot. */
export function regimeForCandles(series: RegimeSeries, candleLabels: readonly string[], tf: number): (RegimeLabel | null)[] {
  const by = new Map<string, RegimeLabel>();
  for (const p of series.points) by.set(hm(555 + Math.floor((istMinute(p.t) - 555) / tf) * tf), p.label);
  return candleLabels.map((l) => by.get(l) ?? null);
}
