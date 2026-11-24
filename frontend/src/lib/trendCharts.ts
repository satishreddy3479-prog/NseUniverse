/** Chart builders of the Trend & Regime pages: stacked panels on one shared time axis (linked crosshair and zoom), with the regime shaded behind every panel and value zones shaded where a reading has a meaning. */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { candleSeries } from "./chartOptions";
import type { RBar } from "./trendStats";

export const labelColor = (c: ChartColors, l: string): string =>
  l === "Trending up" || l === "Weak uptrend" ? c.up : l === "Trending down" || l === "Weak downtrend" ? c.down : l === "Range-bound" ? c.info : c.muted;
const labelOpacity = (l: string) => (l === "Trending up" || l === "Trending down" ? 0.2 : l === "Weak uptrend" || l === "Weak downtrend" ? 0.1 : l === "Range-bound" ? 0.14 : 0.07);

type Area = [{ xAxis: string; name: string; itemStyle: { color: string; opacity: number } }, { xAxis: string }];

/** Contiguous runs of the same label as shaded time ranges; the warm-up is left unshaded. */
export function regimeAreas(labels: readonly (string | null)[], x: readonly string[], c: ChartColors): Area[] {
  const out: Area[] = [];
  let s = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i === labels.length || labels[i] !== labels[s]) {
      const l = labels[s];
      if (l && l !== "Warming up") out.push([{ xAxis: x[s]!, name: l, itemStyle: { color: labelColor(c, l), opacity: labelOpacity(l) } }, { xAxis: x[i - 1]! }]);
      s = i;
    }
  }
  return out;
}

export interface Zone { from: number; to: number; color: string; opacity?: number; label?: string }
export interface PanelSpec {
  title: string;
  height: number;
  /** series factories get the axis indexes of their panel */
  series: ((xi: number, yi: number) => Record<string, unknown>)[];
  y?: { min?: number; max?: number; scale?: boolean; fmt?: (v: number) => string };
  /** value ranges shaded across the panel (where a reading means trend, range, overbought...) */
  zones?: Zone[];
  /** horizontal reference lines */
  guides?: { y: number; label?: string }[];
}

const TOP = 28, GAP = 30, SLIDER = 30;

/** Stacked panels, one time axis. ``areas`` (the regime) is shaded behind every panel. Returns the option and the pixel height to give its container. */
export function multiPanelOption(c: ChartColors, x: string[], panels: PanelSpec[], areas: Area[] | null): { option: EChartsCoreOption; height: number } {
  const axisText = { color: c.muted, fontSize: 11 };
  const grids: object[] = [], xAxes: object[] = [], yAxes: object[] = [], titles: object[] = [], series: Record<string, unknown>[] = [];
  const legend: string[] = [];
  let y0 = TOP + 6;
  panels.forEach((p, i) => {
    grids.push({ left: 56, right: 14, top: y0, height: p.height });
    xAxes.push({
      type: "category", gridIndex: i, data: x, boundaryGap: true, axisTick: { show: false }, axisLine: { lineStyle: { color: c.rule } },
      axisLabel: { show: i === panels.length - 1, ...axisText, hideOverlap: true, showMaxLabel: true }, splitLine: { show: false },
      axisPointer: { show: true, label: { show: i === panels.length - 1, backgroundColor: c.paper, color: c.slate } },
    });
    yAxes.push({
      type: "value", gridIndex: i, scale: p.y?.scale ?? true, min: p.y?.min, max: p.y?.max, splitNumber: 3,
      axisLabel: { ...axisText, formatter: p.y?.fmt ?? ((v: number) => String(+v.toFixed(2))) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } }, axisLine: { show: false },
    });
    titles.push({ text: p.title, left: 56, top: y0 - 17, textStyle: { color: c.muted, fontSize: 12, fontWeight: "normal" } });
    for (const make of p.series) {
      const s = make(i, i);
      if (typeof s.name === "string") legend.push(s.name);
      series.push(s);
    }
    const marks = [
      ...(areas ?? []),
      ...(p.zones ?? []).map((z) => [{ yAxis: z.from, name: z.label ?? "", itemStyle: { color: z.color, opacity: z.opacity ?? 0.1 }, label: z.label ? { show: true, position: "insideTopRight", color: c.muted, fontSize: 10 } : { show: false } }, { yAxis: z.to }]),
    ];
    // a hidden series carries the shaded areas and guide lines of the panel, so they stay out of the legend
    series.push({
      name: `__panel${i}`, type: "line", xAxisIndex: i, yAxisIndex: i, data: [], silent: true, showSymbol: false, tooltip: { show: false },
      markArea: { silent: true, label: { show: false }, data: marks },
      markLine: p.guides?.length ? { silent: true, symbol: "none", lineStyle: { color: c.muted, type: "dashed", opacity: 0.7 }, label: { color: c.muted, fontSize: 10, formatter: (a: { name?: string; value?: number }) => a.name || String(a.value) }, data: p.guides.map((g) => ({ yAxis: g.y, name: g.label ?? "" })) } : undefined,
    });
    y0 += p.height + GAP;
  });
  const height = y0 - GAP + SLIDER + 14;
  const option: EChartsCoreOption = {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: c.muted, type: "dashed" } },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "cross" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    legend: { data: [...new Set(legend)], top: 0, left: 52, itemWidth: 14, itemHeight: 8, itemGap: 12, textStyle: { color: c.paper, fontSize: 11 }, type: "scroll" },
    title: titles, grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    dataZoom: [
      { type: "inside", xAxisIndex: panels.map((_, i) => i), filterMode: "none" },
      { type: "slider", xAxisIndex: panels.map((_, i) => i), height: 18, bottom: 6, filterMode: "none", borderColor: c.rule, textStyle: { color: c.muted }, brushSelect: false },
    ],
  };
  return { option, height };
}

export const line = (name: string, data: (number | null)[], color: string, extra: object = {}) => (xi: number, yi: number) => ({
  name, type: "line", xAxisIndex: xi, yAxisIndex: yi, data, showSymbol: false, connectNulls: false, lineStyle: { width: 1.6, color }, itemStyle: { color }, ...extra,
});

export const candles = (name: string, bars: RBar[], c: ChartColors) => (xi: number, yi: number) =>
  candleSeries(name, xi, yi, bars.map((b) => ({ o: b.o, c: b.c, l: b.l, h: b.h })), c);

export const barSeries = (name: string, data: (number | null)[], color: string | ((v: number) => string)) => (xi: number, yi: number) => ({
  name, type: "bar", xAxisIndex: xi, yAxisIndex: yi,
  data: data.map((v) => (v == null ? null : { value: v, itemStyle: { color: typeof color === "function" ? color(v) : color, opacity: 0.85 } })),
});
