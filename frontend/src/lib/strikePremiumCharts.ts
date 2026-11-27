/** Chart options of the strike premium tool (see lib/strikePremium.ts): the contract's price with NIFTY, the parts added up from the start, and the parts of every bucket. */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { hhmm, STRIKE_PARTS, type StrikePremiumData } from "./strikePremium";

/** Six part colours, one set for each theme: time grey, volatility orange, NIFTY blue, convexity green, vanna and volga purple, other sand. */
export function strikePartColors(): string[] {
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
  return dark ? ["#898781", "#d95926", "#3987e5", "#4fb36a", "#a98be0", "#c2ad4a"] : ["#8d8b84", "#eb6834", "#2a78d6", "#2f9a4f", "#7a58c4", "#b09a2f"];
}
const r2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
const tip = (c: ChartColors) => ({ confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } });
const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });
const signedAxis = (c: ChartColors) => ({ type: "value" as const, scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => (v > 0 ? `+${v}` : `${v}`) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } });
const timeAxis = (labels: string[], c: ChartColors) => ({ type: "category" as const, data: labels, axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } });

/** The price of the followed contract through the session, with NIFTY on the right axis. */
export function priceOption(d: StrikePremiumData, c: ChartColors): EChartsCoreOption {
  const s = d.series;
  const labels = (s?.t ?? []).map(hhmm);
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 56, right: 56, top: 30, bottom: 26 },
    tooltip: { ...tip(c), trigger: "axis" },
    xAxis: timeAxis(labels, c),
    yAxis: [{ type: "value", scale: true, axisLabel: axisText(c), splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", scale: true, axisLabel: axisText(c), splitLine: { show: false } }],
    series: [
      { name: d.mode === "atm" ? "At-the-money price (jumps when the strike changes)" : `${d.strike} ${d.contract}`, type: "line", showSymbol: false, data: (s?.price ?? []).map(r2), lineStyle: { color: c.paper, width: 2 }, itemStyle: { color: c.paper }, connectNulls: false },
      { name: "NIFTY", type: "line", yAxisIndex: 1, showSymbol: false, data: s?.spot ?? [], lineStyle: { color: c.muted, width: 1.2, type: "dotted" }, itemStyle: { color: c.muted } },
    ],
  };
}

/** The parts added up from the first sample, and the real change as a dashed line. */
export function cumulativeOption(d: StrikePremiumData, c: ChartColors): EChartsCoreOption {
  const s = d.series;
  const cols = strikePartColors();
  const labels = (s?.t ?? []).map(hhmm);
  const line = (name: string, data: (number | null)[] | undefined, color: string, dashed = false, width = 1.6) => ({
    name, type: "line", showSymbol: false, data: (data ?? []).map(r2), lineStyle: { color, width, type: dashed ? "dashed" : "solid" }, itemStyle: { color },
  });
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 56, right: 14, top: 40, bottom: 26 },
    tooltip: { ...tip(c), trigger: "axis" },
    xAxis: timeAxis(labels, c),
    yAxis: signedAxis(c),
    series: [...STRIKE_PARTS.map((p, k) => line(p.name, s?.cum[p.key], cols[k]!)), line("Real change (all parts)", s?.cum.actual, c.paper, true, 2.4)],
  };
}

/** The parts of every bucket (5 minutes), stacked: up = the premium rose. */
export function barsOption(d: StrikePremiumData, c: ChartColors): EChartsCoreOption {
  const bars = d.bars ?? [];
  const cols = strikePartColors();
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 56, right: 14, top: 40, bottom: 26 },
    tooltip: { ...tip(c), trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: timeAxis(bars.map((b) => hhmm(b.t)), c),
    yAxis: signedAxis(c),
    series: STRIKE_PARTS.map((p, k) => ({ name: p.name, type: "bar", stack: "parts", barMaxWidth: 14, itemStyle: { color: cols[k] }, data: bars.map((b) => r2(b[p.key])) })),
  };
}
