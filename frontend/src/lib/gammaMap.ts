// Gamma map and sudden-move reading ("gamma blast") of the Greeks page: types, the API call and pure chart builders (missing values are gaps, never zeros).
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { MISSING } from "./format";
import type { GexHistoryPoint } from "./types";

export interface GammaStat { now: number; mean: number; min: number; max: number; samples: number; now_vs_mean: number | null; peak_at: string | null }
export interface GammaProfileRow { strike: number; ce: number | null; pe: number | null; net: number | null; abs: number | null }
export interface BlastComponent { key: string; label: string; weight: number; value: number | null; detail: string }
export interface SuddenEvent { at: string; move: number; pct: number; direction: "up" | "down"; near_net_before: number | null; short_gamma_before: boolean | null }
export interface GammaBlast {
  status: "ok" | "unavailable"; message?: string; score: number | null; level: "calm" | "building" | "elevated" | "high" | null; components: BlastComponent[]; coverage_pct?: number;
  sudden?: { typical_step_pct: number | null; threshold_pct: number | null; events: SuddenEvent[]; latest_is_sudden: boolean | null; steps: number }; note?: string;
}
export interface GammaMap {
  status: string; expiry: string; session?: string; universe?: string; sessions?: string[]; snapshot_at?: string; spot?: number | null; hours_to_expiry?: number;
  profile: GammaProfileRow[]; points: GexHistoryPoint[]; skipped?: { at: string; reason: string }[];
  average?: { abs: GammaStat | null; near_net: GammaStat | null; net: GammaStat | null; negative_share: number | null; points: number };
  blast?: GammaBlast; units?: string; note?: string;
}

export async function fetchGammaMap(expiry: string, universe: "dynamic" | "full"): Promise<GammaMap> {
  const res = await fetch(`/api/intraday/gamma-map?expiry=${encodeURIComponent(expiry)}&universe=${universe}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`The gamma map could not be loaded (${res.status}).`);
  return (await res.json()) as GammaMap;
}

export const crore = (v: number | null | undefined, d = 1): string => (v == null || !Number.isFinite(v) ? MISSING : `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(d)}`);
export const LEVEL_TONE: Record<string, string> = { calm: "text-up", building: "text-info", elevated: "text-warn", high: "text-down" };
export const LEVEL_TEXT: Record<string, string> = { calm: "Calm", building: "Building", elevated: "Elevated", high: "High" };

const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });

/** Gamma exposure by strike: calls above zero, puts below, net as a line; the strike nearest spot and the one nearest the flip are marked. */
export function profileOption(rows: GammaProfileRow[], spot: number | null, flip: number | null, c: ChartColors): EChartsCoreOption {
  const nearest = (v: number | null) => (v == null || rows.length === 0 ? null : rows.reduce((b, r) => (Math.abs(r.strike - v) < Math.abs(b.strike - v) ? r : b)).strike);
  const sk = nearest(spot), fk = nearest(flip);
  const mark = (k: number | null, name: string, color: string) => (k == null ? [] : [{ xAxis: String(k), name, lineStyle: { color, type: "dashed" }, label: { formatter: name, color, fontSize: 10 } }]);
  return {
    animation: false, grid: { left: 8, right: 12, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (v == null ? MISSING : `${crore(Number(v), 2)} ₹ crore`) },
    xAxis: { type: "category", data: rows.map((r) => String(r.strike)), axisLabel: { ...axisText(c), interval: "auto", rotate: 60 }, axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => crore(v, 0) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    series: [
      { name: "Call (+)", type: "bar", stack: "side", itemStyle: { color: c.up }, data: rows.map((r) => r.ce), markLine: { symbol: "none", silent: true, data: [...mark(sk, "spot", c.paper), ...mark(fk, "flip", c.brass)] } },
      { name: "Put (−)", type: "bar", stack: "side", itemStyle: { color: c.down }, data: rows.map((r) => r.pe) },
      { name: "Net", type: "line", symbol: "circle", symbolSize: 4, lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass }, data: rows.map((r) => r.net) },
    ],
  };
}
