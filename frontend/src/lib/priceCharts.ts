/**
 * Chart options of the price tools (Price vs OI, MultiStrike, Multi-Straddle). Every chart takes the same time grid
 * (the newest session, 09:15 to the close, IST) so the crosshair of linked charts lands on the same minute.
 * A missing value is a gap in the line, never a zero.
 */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { compactIN } from "./analytics";
import { fmtInt, fmtPrice } from "./format";

export interface Line {
  name: string;
  color: string;
  data: (number | null)[];
  /** 0 = left axis, 1 = right axis */
  axis?: 0 | 1;
  dotted?: boolean;
  /** drawn only after the user clicks it in the legend */
  hidden?: boolean;
  /** shade between the line and the zero line */
  area?: boolean;
  fmt: (v: number) => string;
}

export const rupee = (v: number) => fmtPrice(v);
export const ratio = (v: number) => v.toFixed(2);
export const units = (v: number) => compactIN(v);
export const signedUnits = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${compactIN(Math.abs(v))}`;
const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
export const dayLabel = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/** Categorical colours for several strikes on one chart: distinguishable on both the light and the dark theme. */
export const STRIKE_COLORS = ["#2f81f7", "#e8912d", "#a371f7", "#1fb5a5", "#e5568c", "#8fb339"];

/** Right margin of a chart with a right axis: the latest-value tags sit first, the axis numbers after them. */
export const TIME_LINES_RIGHT = 132;

export function timeLinesOption(
  times: number[], lines: Line[], c: ChartColors, bounds: { min: number; max: number } | null,
  opts: { leftFmt?: (v: number) => string; rightFmt?: (v: number) => string; zeroLine?: boolean } = {},
): EChartsCoreOption {
  const hasRight = lines.some((l) => l.axis === 1);
  const yAxis = (right: boolean, f: (v: number) => string) => ({
    type: "value", scale: true, position: right ? "right" : "left", axisLabel: { ...axisText(c), formatter: f, ...(right ? { margin: 70 } : {}) },
    splitLine: { show: !right, lineStyle: { color: c.rule, opacity: 0.5 } }, axisLine: { show: false },
  });
  const leftFmt = opts.leftFmt ?? ((v: number) => fmtInt(v));
  const series = lines.map((l) => ({
    name: l.name, type: "line", yAxisIndex: l.axis ?? 0, showSymbol: false, connectNulls: false, sampling: "lttb",
    itemStyle: { color: l.color }, lineStyle: { color: l.color, width: l.dotted ? 1.4 : 1.8, type: l.dotted ? "dotted" : "solid" },
    ...(l.area ? { areaStyle: { color: l.color, opacity: 0.16 } } : {}),
    data: times.map((t, i) => [t, l.data[i] ?? null]),
    // the tag at the right end shows the latest value of the line, as on the reference page
    endLabel: { show: true, formatter: (p: { value: unknown }) => { const v = (p.value as [number, number | null])[1]; return v == null ? "" : l.fmt(v); },
      backgroundColor: l.color, color: "#fff", padding: [2, 5], borderRadius: 3, fontSize: 11, offset: [4, 0] },
    labelLayout: { moveOverlap: "shiftY" },
    ...(opts.zeroLine && !l.dotted ? { markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, type: "dashed", opacity: 0.6 }, data: [{ yAxis: 0 }] } } : {}),
  }));
  return {
    animation: false,
    grid: { left: 58, right: hasRight ? TIME_LINES_RIGHT : 64, top: 34, bottom: 28 },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8, selected: Object.fromEntries(lines.map((l) => [l.name, !l.hidden])) },
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: c.muted, type: "dashed" } },
    tooltip: {
      trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      axisPointer: { type: "cross", lineStyle: { color: c.muted, type: "dashed" }, label: { backgroundColor: c.paper, color: c.slate,
        formatter: (p: { axisDimension?: string; value: unknown }) => (p.axisDimension === "x" ? hhmm(Number(p.value)) : typeof p.value === "number" ? fmtInt(p.value) : String(p.value)) } },
      formatter: (params: unknown) => {
        const ps = params as { axisValue: number; seriesName: string; value?: [number, number | null]; marker: string; data?: { from?: number; to?: number } }[];
        const by = new Map(lines.map((l) => [l.name, l]));
        // a series that is not one of the lines (the roll markers a board adds, for one) must not break the tooltip: it threw on every mouse move and froze the chart
        const row = (p: (typeof ps)[number]): string => {
          const l = by.get(p.seriesName);
          if (l) return `${p.marker}${p.seriesName}: ${p.value?.[1] == null ? "—" : l.fmt(p.value[1])}`;
          return p.data?.from != null ? `${p.marker}Roll ${fmtInt(p.data.from)} → ${fmtInt(p.data.to ?? 0)}` : "";
        };
        return `<b>${dayLabel(ps[0]!.axisValue)} ${hhmm(ps[0]!.axisValue)} IST</b><br/>` + ps.map(row).filter(Boolean).join("<br/>");
      },
    },
    xAxis: {
      type: "time", ...(bounds ? { min: bounds.min, max: bounds.max } : {}),
      axisLabel: { ...axisText(c), hideOverlap: true, formatter: (v: number) => hhmm(v) }, axisLine: { lineStyle: { color: c.rule } },
      splitLine: { show: true, lineStyle: { color: c.rule, opacity: 0.25 } }, axisTick: { show: false },
    },
    yAxis: hasRight ? [yAxis(false, leftFmt), yAxis(true, opts.rightFmt ?? units)] : yAxis(false, leftFmt),
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series,
  };
}
