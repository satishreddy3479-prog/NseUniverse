/** Helpers of the Market Intelligence day board: the sentiment-through-the-day chart and the small formatters its tables share. */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { hhmmIST } from "./format";
import type { Outlook } from "./intelligence";
import { line, multiPanelOption, regimeAreas } from "./trendCharts";

/** The verdict classes in the order of the score, with the band edges the backend uses. */
export const CLASS_ORDER = ["Strong Bullish", "Bullish", "Mild Bullish", "Neutral", "Mild Bearish", "Bearish", "Strong Bearish"] as const;

export const scoreTone = (s: number | null | undefined): "up" | "down" | "flat" => (s == null || Math.abs(s) < 15 ? "flat" : s > 0 ? "up" : "down");
export const toneClass = (t: "up" | "down" | "flat") => (t === "up" ? "text-up" : t === "down" ? "text-down" : "text-paper");
export const sgn = (v: number | null | undefined, d = 0): string => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
export const pctOf = (v: number | null | undefined, d = 0): string => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);

/** The class of a score by the backend's cut-offs (70 / 35 / 15). */
export function classOf(s: number | null | undefined): string {
  if (s == null) return "—";
  return s >= 70 ? "Strong Bullish" : s >= 35 ? "Bullish" : s >= 15 ? "Mild Bullish" : s > -15 ? "Neutral" : s > -35 ? "Mild Bearish" : s > -70 ? "Bearish" : "Strong Bearish";
}

/**
 * The day chart: NIFTY on top, the fused sentiment under it (the zones the verdict classes name: bullish above +35, bearish under −35, neutral inside ±15) with the trend-and-regime group's own
 * score beside it, and the evidence quality at the bottom. The trend regime is shaded behind every panel where it was recorded (from the trend group's first day: older minutes carry none).
 */
export function dayBoardChart(c: ChartColors, o: Outlook): { option: EChartsCoreOption; height: number } {
  const x = o.path.map((p) => hhmmIST(p.at));
  const spot = o.path.map((p) => p.spot);
  const score = o.path.map((p) => p.score);
  const trendGroup = o.path.map((p) => p.trend_group);
  const conf = o.path.map((p) => p.confidence);
  const labels = o.path.map((p) => p.trend_label);
  const shaded = labels.some((l) => l != null);
  const info = (i: number): string[] => {
    const p = o.path[i];
    if (!p) return [];
    return [`Verdict: <b>${classOf(p.score)}</b>${p.score == null ? "" : ` (${sgn(p.score)})`}${p.confidence == null ? "" : ` · evidence quality ${p.confidence.toFixed(0)}`}`, p.trend_label ? `Trend regime: <b>${p.trend_label}</b>${p.trend_score == null ? "" : ` · score ${Math.round(p.trend_score * 100)}`}` : "Trend regime: not recorded for this minute"];
  };
  return multiPanelOption(c, x, [
    { title: "NIFTY 50 (the index, as recorded each minute)", height: 190, series: [line("NIFTY", spot, c.paper)] },
    {
      title: "Sentiment: the fused verdict (−100 bearish to +100 bullish) and the trend & regime group", height: 150,
      series: [line("Sentiment", score, c.brass, { lineStyle: { width: 2, color: c.brass }, areaStyle: { color: c.brass, opacity: 0.08 } }), line("Trend & regime group", trendGroup, c.info, { lineStyle: { width: 1.4, color: c.info, type: "dashed" } })],
      y: { min: -100, max: 100, scale: false },
      zones: [{ from: 35, to: 100, color: c.up, opacity: 0.1, label: "bullish" }, { from: -100, to: -35, color: c.down, opacity: 0.1, label: "bearish" }, { from: -15, to: 15, color: c.muted, opacity: 0.08 }],
      guides: [{ y: 0 }, { y: 15 }, { y: -15 }, { y: 35 }, { y: -35 }],
    },
    { title: "Evidence quality (0-100): how fresh, complete and in agreement the evidence is, not a probability", height: 70, series: [line("Evidence quality", conf, c.muted)], y: { min: 0, max: 100, scale: false }, guides: [{ y: 35 }, { y: 60 }] },
  ], shaded ? regimeAreas(labels, x, c) : null, info);
}

/** A short label for the minutes of a horizon ("Next 30 minutes" stays as the backend wrote it; the close reads in hours when it is far). */
export const horizonName = (label: string, minutes: number): string => (label === "To the close" ? `To the close (${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim() : `${minutes} min`})` : label);

/** One standard deviation of the move over ``minutes`` of trading time, in points: spot x IV x sqrt(minutes / (252 x 375)) (the backend's formula, so a live tick can re-price the bands without a request). */
export const sigmaPoints = (spot: number | null | undefined, ivPct: number | null | undefined, minutes: number): number | null => (!spot || ivPct == null || minutes <= 0 ? null : spot * (ivPct / 100) * Math.sqrt(minutes / (252 * 375)));

/**
 * The outlook with the live NIFTY tick laid over it: the priced bands and the distances to the levels are measured from the tick (the implied volatility and the verdict stay the server's), and the
 * last point of the chart is the tick (replacing the recorded minute's price when it is the same minute, else appended with no verdict). Returns the outlook unchanged when the market is not live.
 */
export function applyLiveSpot(o: Outlook, tick: { ltp: number; at: number } | null): Outlook {
  if (!o.live || !tick) return o;
  const spot = tick.ltp;
  const expected = o.expected.map((e) => {
    const sd = sigmaPoints(spot, o.atm_iv, e.minutes);
    return sd == null ? e : { ...e, sd_points: Math.round(sd * 10) / 10, low: Math.round((spot - sd) * 10) / 10, high: Math.round((spot + sd) * 10) / 10 };
  });
  const levels = o.levels.map((l) => { const d = l.price - spot; return { ...l, distance_points: Math.round(d * 10) / 10, distance_atr: o.atr ? Math.round((d / o.atr) * 100) / 100 : l.distance_atr, side: d > 0 ? "above" : d < 0 ? "below" : "at" } as typeof l; })
    .sort((a, b) => Math.abs(a.distance_points ?? 1e9) - Math.abs(b.distance_points ?? 1e9));
  const at = new Date(tick.at).toISOString();
  const last = o.path[o.path.length - 1];
  const sameMinute = last != null && hhmmIST(last.at) === hhmmIST(at);
  const path = last == null ? o.path : sameMinute ? [...o.path.slice(0, -1), { ...last, spot }] : [...o.path, { at, spot, score: null, confidence: null, trend_score: null, trend_label: null, trend_group: null }];
  return { ...o, spot, expected, levels, path };
}
