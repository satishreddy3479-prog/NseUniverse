/** Chart options of the Premium Change tool (see lib/premiumChange.ts). Parts: time decay, NIFTY moving, volatility and the rest. */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { type ChangeWindow, rupees, runningTotals, type Split } from "./premiumChange";

export const PARTS = [
  { key: "decay", name: "Time decay" },
  { key: "spot", name: "NIFTY moving" },
  { key: "vol", name: "Volatility and the rest" },
] as const;

/**
 * The three parts' colours: grey, blue and orange (the chart palette's blue and orange, so the two causes that matter are told apart at a glance), one set for each theme.
 * The theme's own muted, info and brass colours were too close together and too dark on the light theme.
 */
export function partColors(): [string, string, string] {
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
  return dark ? ["#898781", "#3987e5", "#d95926"] : ["#b4b2a9", "#2a78d6", "#eb6834"];
}
const colorOf = (_c: ChartColors) => partColors();
const r2 = (v: number) => Math.round(v * 100) / 100;
const val = (s: Split | null | undefined, k: (typeof PARTS)[number]["key"]) => (s ? r2(s[k]) : null);
const tipBase = (c: ChartColors) => ({ confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } });
const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });
const moneyAxis = (c: ChartColors) => ({ type: "value" as const, axisLabel: { ...axisText(c), formatter: (v: number) => (v > 0 ? `+${v}` : `${v}`) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } });
const signed = (v: unknown) => (typeof v === "number" ? rupees(v) : "—");

/** Every window of the ATM straddle: the three parts stacked (up = the premium rose, down = it fell). `sel` marks the window being read. */
export function windowsOption(ws: readonly ChangeWindow[], labels: readonly string[], sel: number, c: ChartColors): EChartsCoreOption {
  const cols = colorOf(c);
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 52, right: 12, top: 30, bottom: 26 },
    tooltip: { ...tipBase(c), trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: signed },
    xAxis: { type: "category", data: labels, axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: moneyAxis(c),
    series: PARTS.map((p, k) => ({
      name: p.name, type: "bar", stack: "change", barMaxWidth: 14, itemStyle: { color: cols[k] },
      data: ws.map((w) => val(w.atm, p.key)),
      ...(k === 0 ? { markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: c.paper, width: 1.5, type: "solid" }, data: sel >= 0 && sel < labels.length ? [{ xAxis: sel }] : [] } } : {}),
    })),
  };
}

/** Running totals from the first window of the day, with the real total as a dashed line. */
export function runningOption(ws: readonly ChangeWindow[], labels: readonly string[], sel: number, c: ChartColors): EChartsCoreOption {
  const run = runningTotals(ws);
  const cols = colorOf(c);
  const line = (name: string, data: (number | null)[], color: string, dashed = false, width = 2) => ({
    name, type: "line", showSymbol: false, connectNulls: false, data: data.map((v) => (v == null ? null : r2(v))), lineStyle: { color, width, type: dashed ? "dashed" : "solid" }, itemStyle: { color },
  });
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 52, right: 12, top: 30, bottom: 26 },
    tooltip: { ...tipBase(c), trigger: "axis", valueFormatter: signed },
    xAxis: { type: "category", data: labels, axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { ...moneyAxis(c), scale: true },
    series: [
      { ...line(PARTS[0].name, run.map((r) => r.decay), cols[0]), markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: c.paper, width: 1.5 }, data: sel >= 0 && sel < labels.length ? [{ xAxis: sel }] : [] } },
      line(PARTS[1].name, run.map((r) => r.spot), cols[1]),
      line(PARTS[2].name, run.map((r) => r.vol), cols[2]),
      line("Real change (all three)", run.map((r) => r.total), c.paper, true, 2.5),
    ],
  };
}

/** The strikes of one window: each straddle's three parts, side by side across strikes (strikes ascending upwards). */
export function strikesOption(w: ChangeWindow | undefined, perSide: number, c: ChartColors): EChartsCoreOption {
  const cols = colorOf(c);
  const ks = w ? Object.keys(w.strikes).map(Number).sort((a, b) => a - b) : [];
  const at = ks.findIndex((k) => k === w?.atmStrike);
  const shown = at < 0 ? ks : ks.slice(Math.max(0, at - perSide), at + perSide + 1);
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 60, right: 16, top: 30, bottom: 24 },
    tooltip: {
      ...tipBase(c), trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const ps = params as { axisValue?: string; seriesName: string; value: number | null }[];
        const k = Number(ps[0]?.axisValue);
        const s = w?.strikes[k];
        return `<b>${k}${k === w?.atmStrike ? " (ATM)" : ""}</b><br/>${ps.map((p) => `${p.seriesName}: ${signed(p.value)}`).join("<br/>")}${s ? `<br/><b>Real change: ${rupees(s.total)}</b>` : ""}`;
      },
    },
    xAxis: moneyAxis(c),
    yAxis: { type: "category", data: shown.map(String), axisLabel: axisText(c), axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    series: PARTS.map((p, k) => ({ name: p.name, type: "bar", stack: "change", barMaxWidth: 16, itemStyle: { color: cols[k] }, data: shown.map((s) => val(w?.strikes[s], p.key)) })),
  };
}

/** NIFTY at the end of every window. */
export function spotOption(ws: readonly ChangeWindow[], labels: readonly string[], sel: number, c: ChartColors): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 10, bottom: 22 },
    tooltip: { ...tipBase(c), trigger: "axis" },
    xAxis: { type: "category", data: labels, axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: axisText(c), splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{
      name: "NIFTY", type: "line", showSymbol: false, data: ws.map((w) => w.spot), lineStyle: { color: c.muted, width: 1.6 }, itemStyle: { color: c.muted },
      markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: c.paper, width: 1.5 }, data: sel >= 0 && sel < labels.length ? [{ xAxis: sel }] : [] },
    }],
  };
}
