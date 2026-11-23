/**
 * Intraday trend / range regime of the NIFTY 50 session so far, from price only (lib/trendStats.ts). DESCRIPTIVE and NOT validated:
 * it labels how the day has behaved, it does not predict. All thresholds are conventional textbook values (stated below) and uncalibrated.
 *
 * Four independent readings each cast one vote per bar, evaluated on the last ``window`` bars of the chosen timeframe:
 *   efficiency ratio  >= 0.35 trend, <= 0.20 range
 *   ADX (Wilder)      >= 25   trend, <  20   range
 *   regression R^2    >= 0.60 trend, <= 0.30 range
 *   choppiness index  <  38.2 trend, >  61.8 range      (the Fibonacci levels of the indicator's author)
 * A reading in between, or one that cannot be computed, votes for neither. Label: 3 or more trend votes = Trending (up or down by the sign of
 * the regression slope, which +DI against -DI must not contradict); 3 or more range votes = Range-bound; otherwise Unclear. Confidence is the
 * share of evaluable readings that agree with the label, times the share of readings that could be evaluated. The shown label only changes
 * after the new reading has held for ``minDwell`` consecutive bars (hysteresis), so one noisy bar does not flip it.
 */
import { adx, aggregate, choppiness, efficiencyRatio, istMinute, regression, type RBar } from "./trendStats";
import type { IndexBar } from "./types";

export type RegimeLabel = "Trending up" | "Trending down" | "Range-bound" | "Unclear" | "Warming up";

export const THRESHOLDS = { erTrend: 0.35, erRange: 0.2, adxTrend: 25, adxRange: 20, r2Trend: 0.6, r2Range: 0.3, chopTrend: 38.2, chopRange: 61.8, votesNeeded: 3 } as const;

export interface RegimeParams { tf: number; window: number; adxN: number; minDwell: number }
export const DEFAULT_PARAMS: RegimeParams = { tf: 5, window: 12, adxN: 14, minDwell: 3 };

export interface RegimeMetrics { er: number | null; adx: number | null; plusDi: number | null; minusDi: number | null; r2: number | null; slope: number | null; chop: number | null }
export interface RegimePoint {
  t: number;
  /** label shown (after the dwell rule) and the label of this bar alone */
  label: RegimeLabel; raw: RegimeLabel;
  /** 0-1, null while warming up */
  confidence: number | null;
  votes: { trend: number; range: number; evaluable: number };
  metrics: RegimeMetrics;
  reasons: string[];
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

const f = (v: number, d = 2) => v.toFixed(d);

/** Classify bar i from its metrics. */
export function classify(m: RegimeMetrics): { raw: RegimeLabel; confidence: number | null; votes: RegimePoint["votes"]; reasons: string[] } {
  const th = THRESHOLDS;
  const reasons: string[] = [];
  let trend = 0, range = 0, evaluable = 0;
  const vote = (v: number | null, isTrend: boolean, isRange: boolean, text: string) => {
    if (v == null) return;
    evaluable++;
    if (isTrend) { trend++; reasons.push(`${text}: trending`); } else if (isRange) { range++; reasons.push(`${text}: range-bound`); } else reasons.push(`${text}: in between`);
  };
  vote(m.er, (m.er ?? 0) >= th.erTrend, (m.er ?? 1) <= th.erRange, `efficiency ratio ${f(m.er ?? 0)}`);
  vote(m.adx, (m.adx ?? 0) >= th.adxTrend, (m.adx ?? 99) < th.adxRange, `ADX ${f(m.adx ?? 0, 1)}`);
  vote(m.r2, (m.r2 ?? 0) >= th.r2Trend, (m.r2 ?? 1) <= th.r2Range, `R² ${f(m.r2 ?? 0)}`);
  vote(m.chop, (m.chop ?? 99) < th.chopTrend, (m.chop ?? 0) > th.chopRange, `choppiness ${f(m.chop ?? 0, 1)}`);
  const votes = { trend, range, evaluable };
  if (evaluable < 3) return { raw: "Warming up", confidence: null, votes, reasons };
  let raw: RegimeLabel = "Unclear";
  let agree = Math.max(trend, range);
  if (trend >= th.votesNeeded) {
    const up = (m.slope ?? 0) > 0;
    const diAgrees = m.plusDi == null || m.minusDi == null ? true : up ? m.plusDi >= m.minusDi : m.minusDi >= m.plusDi;
    if (diAgrees && m.slope != null && m.slope !== 0) raw = up ? "Trending up" : "Trending down";
    else reasons.push("direction readings disagree (slope against +DI / -DI)");
  } else if (range >= th.votesNeeded) raw = "Range-bound";
  if (raw === "Unclear") agree = evaluable - Math.max(trend, range); // the readings that did not point to either regime
  return { raw, confidence: (agree / evaluable) * (evaluable / 4), votes, reasons };
}

export interface RegimeSeries { bars: RBar[]; points: RegimePoint[]; params: RegimeParams }

/** The regime at every bar of the session so far (causal: bar i uses bars 0..i only), on ``params.tf``-minute bars made from the one-minute bars. */
export function regimeSeries(oneMin: RBar[], params: Partial<RegimeParams> = {}): RegimeSeries {
  const p = { ...DEFAULT_PARAMS, ...params };
  const bars = aggregate(oneMin, p.tf);
  const dmi = adx(bars, p.adxN);
  const closes = bars.map((b) => b.c);
  const rows = bars.map((b, i) => {
    const upTo = closes.slice(0, i + 1);
    const reg = regression(upTo, p.window);
    const metrics: RegimeMetrics = {
      er: efficiencyRatio(upTo, p.window), adx: dmi[i]!.adx, plusDi: dmi[i]!.plusDi, minusDi: dmi[i]!.minusDi,
      r2: reg?.r2 ?? null, slope: reg?.slope ?? null, chop: choppiness(bars.slice(0, i + 1), p.window),
    };
    return { t: b.t, metrics, ...classify(metrics) };
  });
  const shown = applyDwell(rows.map((r) => r.raw), p.minDwell);
  const points: RegimePoint[] = rows.map((r, i) => ({ t: r.t, label: shown[i] as RegimeLabel, raw: r.raw, confidence: r.confidence, votes: r.votes, metrics: r.metrics, reasons: r.reasons }));
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

export interface ForwardCheck { n: number; meanForwardEr: number | null }

/** A stored-session check of the label, NOT a validation: for every bar with a shown label, the efficiency ratio of the next ``horizon`` bars, averaged by label class.
 *  The windows overlap, so the bars are not independent samples and no significance is claimed; a handful of sessions cannot validate anything. */
export function forwardCheck(series: RegimeSeries, horizon = 12): Record<"trending" | "range" | "unclear", ForwardCheck> {
  const acc = { trending: [] as number[], range: [] as number[], unclear: [] as number[] };
  const closes = series.bars.map((b) => b.c);
  series.points.forEach((p, i) => {
    if (i + horizon >= closes.length || p.label === "Warming up") return;
    const er = efficiencyRatio(closes.slice(i, i + horizon + 1), horizon);
    if (er == null) return;
    acc[p.label === "Range-bound" ? "range" : p.label === "Unclear" ? "unclear" : "trending"].push(er);
  });
  const mk = (v: number[]): ForwardCheck => ({ n: v.length, meanForwardEr: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null });
  return { trending: mk(acc.trending), range: mk(acc.range), unclear: mk(acc.unclear) };
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
