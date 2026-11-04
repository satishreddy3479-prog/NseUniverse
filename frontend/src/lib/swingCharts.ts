// ECharts option builders for the Swing page. Pure functions so tests can assert what is plotted.
import type { EChartsCoreOption } from "echarts/core";
import { compactIN } from "./analytics";
import type { ChartColors } from "./chartOptions";
import { BASIS_LABEL, type Basis } from "./swing";
import type { SwingPaperView, SwingReport, SwingRobustRow } from "./types";

const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });
const tip = (c: ChartColors) => ({
  trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
});
const base = (c: ChartColors) => ({
  animation: false,
  legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
  textStyle: { fontFamily: "inherit" },
});
const dateAxis = (c: ChartColors, dates: string[]) => ({
  type: "category", data: dates, boundaryGap: false,
  axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false },
});
const rupeeAxis = (c: ChartColors, name: string) => ({
  type: "value", scale: true, name, nameTextStyle: { color: c.muted, fontSize: 11, align: "left" },
  axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) },
  splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } },
});
const zoom = (c: ChartColors) => [
  { type: "inside", filterMode: "none" },
  { type: "slider", height: 14, bottom: 6, borderColor: c.rule, textStyle: { color: c.muted } },
];

export function equityOption(r: SwingReport, basis: Basis, c: ChartColors): EChartsCoreOption {
  const d = r.equity.dates;
  return {
    ...base(c),
    grid: { left: 62, right: 16, top: 40, bottom: 56 },
    tooltip: {
      ...tip(c),
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string; seriesName: string; value: number | null; color: string }[];
        return `<b>${ps[0]?.axisValue}</b><br/>` + ps.map((p) =>
          `<span style="color:${p.color}">●</span> ${p.seriesName}: ₹${p.value == null ? "—" : Math.round(p.value).toLocaleString("en-IN")}`).join("<br/>");
      },
    },
    xAxis: dateAxis(c, d),
    yAxis: rupeeAxis(c, "Portfolio value (₹, start ₹10 L)"),
    dataZoom: zoom(c),
    series: [
      { name: `Swing engine (${BASIS_LABEL[basis].toLowerCase()})`, type: "line", showSymbol: false, data: r.equity[basis], lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } },
      { name: "NIFTY 50 buy and hold", type: "line", showSymbol: false, data: r.equity.nifty, lineStyle: { color: c.info, width: 1.5, type: "dashed" }, itemStyle: { color: c.info } },
    ],
  };
}

export function drawdownOption(r: SwingReport, basis: Basis, c: ChartColors): EChartsCoreOption {
  return {
    ...base(c),
    grid: { left: 62, right: 16, top: 30, bottom: 30 },
    tooltip: {
      ...tip(c),
      formatter: (params: unknown) => {
        const p = (params as { axisValue: string; value: number | null }[])[0];
        return `<b>${p?.axisValue}</b><br/>Below peak: ${p?.value == null ? "—" : `${p.value.toFixed(2)}%`}`;
      },
    },
    xAxis: dateAxis(c, r.equity.dates),
    yAxis: { type: "value", max: 0, axisLabel: { ...axisText(c), formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{ name: "Drawdown", type: "line", showSymbol: false, data: r.equity[basis === "gross" ? "gross_dd" : "net_dd"],
      lineStyle: { color: c.down, width: 1.5 }, areaStyle: { color: c.down, opacity: 0.25 }, itemStyle: { color: c.down } }],
  };
}

export function yearReturnsOption(r: SwingReport, basis: Basis, c: ChartColors): EChartsCoreOption {
  const yrs = r.year_returns;
  const bar = (name: string, data: number[], color: string) => ({
    name, type: "bar", data, itemStyle: { color }, barMaxWidth: 28,
    label: { show: true, position: "top", color: c.paper, fontSize: 10, formatter: (p: unknown) => `${(p as { value: number }).value.toFixed(1)}%` },
  });
  return {
    ...base(c),
    grid: { left: 46, right: 12, top: 36, bottom: 26 },
    tooltip: { ...tip(c), axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: yrs.map((y) => (y.year === new Date().getFullYear() ? `${y.year} (to date)` : String(y.year))), axisLabel: axisText(c), axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      bar(`Swing engine (${BASIS_LABEL[basis].toLowerCase()})`, yrs.map((y) => (basis === "gross" ? y.gross_pct : y.net_pct)), c.brass),
      bar("NIFTY 50", yrs.map((y) => y.nifty_pct), c.info),
    ],
  };
}

export function robustnessOption(rows: SwingRobustRow[], c: ChartColors): EChartsCoreOption {
  return {
    ...base(c),
    grid: { left: 46, right: 12, top: 36, bottom: 40 },
    tooltip: { ...tip(c), axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: rows.map((x) => x.label.replace("  (rule)", " ★")), axisLabel: { ...axisText(c), interval: 0, rotate: rows.length > 6 ? 25 : 0 }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      { name: "Before costs", type: "bar", data: rows.map((x) => x.gross_return_pct), itemStyle: { color: c.brass }, barMaxWidth: 22 },
      { name: "After costs", type: "bar", data: rows.map((x) => x.net_return_pct), itemStyle: { color: c.info }, barMaxWidth: 22 },
    ],
  };
}

/** Paper-book equity against NIFTY 50 rebased to the same starting capital (NIFTY closes are stored with each session). */
export function paperEquityOption(v: SwingPaperView, c: ChartColors): EChartsCoreOption {
  const rows = v.equity;
  const n0 = rows.find((r) => r.nifty_close != null)?.nifty_close ?? null;
  const cap = v.book.capital;
  return {
    ...base(c),
    grid: { left: 62, right: 16, top: 40, bottom: 30 },
    tooltip: {
      ...tip(c),
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string; seriesName: string; value: number | null; color: string }[];
        return `<b>${ps[0]?.axisValue}</b><br/>` + ps.map((p) =>
          `<span style="color:${p.color}">●</span> ${p.seriesName}: ₹${p.value == null ? "—" : Math.round(p.value).toLocaleString("en-IN")}`).join("<br/>");
      },
    },
    xAxis: dateAxis(c, rows.map((r) => r.session)),
    yAxis: rupeeAxis(c, `Value (₹, start ${compactIN(cap)})`),
    series: [
      { name: "Paper book (after costs)", type: "line", showSymbol: rows.length < 30, data: rows.map((r) => r.equity), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } },
      { name: "NIFTY 50 buy and hold", type: "line", showSymbol: rows.length < 30, data: rows.map((r) => (r.nifty_close != null && n0 ? (r.nifty_close / n0) * cap : null)), lineStyle: { color: c.info, width: 1.5, type: "dashed" }, itemStyle: { color: c.info } },
    ],
  };
}
