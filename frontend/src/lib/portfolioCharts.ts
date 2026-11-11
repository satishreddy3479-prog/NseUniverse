/**
 * Chart option of the Portfolio page: closed strategies in the order they closed.
 *
 * Three panels share one x axis, one position per close ("#1 3 Nov"), so ten closes are ten evenly spaced points instead of bunching on the days they happened:
 *   1. cumulative closed P&L (a line through one dot per close, each dot green above zero and red below it, the peak marked, the latest value tagged);
 *   2. the result of each closed strategy (a bar per close, green or red);
 *   3. drawdown from the highest cumulative P&L reached (the worst point marked).
 * Values are booked P&L in rupees from ``portfolioStats``; nothing is estimated. The first position is the start at zero.
 */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { fmtDateTimeIST, fmtInt } from "./format";
import type { PortfolioStats } from "./portfolioStats";

export const money = (v: number | null | undefined, signed = true): string =>
  v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "3 Nov" in IST for a UTC timestamp (ms). */
export function shortDay(ms: number): string {
  const d = new Date(ms + 330 * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface EquityLayout { height: number }
/** Pixel layout (the container is ``height`` tall): equity panel, per-close bars, drawdown, then room for the axis labels. */
export const EQUITY_HEIGHT = 470;
const G = { left: 74, right: 78, eqTop: 30, eqH: 196, barTop: 270, barH: 70, ddTop: 384, ddH: 54 };

export function portfolioEquityOption(stats: PortfolioStats, c: ChartColors): EChartsCoreOption {
  const cv = stats.curve;
  const cats = ["Start", ...cv.map((_, i) => `#${i + 1}`)];
  const dates = ["", ...cv.map((p) => shortDay(p.t))];
  const cum = [0, ...cv.map((p) => p.cum)];
  const dd = [0, ...cv.map((p) => -p.dd)];
  const pnl: (number | null)[] = [null, ...cv.map((p) => p.pnl)];
  const last = cum[cum.length - 1] ?? 0;
  const axisText = { color: c.muted, fontSize: 11 };
  const title = (text: string, top: number) => ({ text, left: G.left, top, textStyle: { color: c.paper, fontSize: 12, fontWeight: 600 } });
  const xAxis = (gridIndex: number, show: boolean) => ({
    type: "category", gridIndex, data: cats, boundaryGap: true, axisTick: { show: false }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: true, lineStyle: { color: c.rule, opacity: 0.25 } },
    axisLabel: show ? { ...axisText, interval: 0, hideOverlap: true, lineHeight: 15, formatter: (_: string, i: number) => (i === 0 ? "Start" : `{n|${cats[i]}}\n{d|${dates[i]}}`), rich: { n: { color: c.paper, fontSize: 11 }, d: { color: c.muted, fontSize: 10 } } } : { show: false },
  });
  const yAxis = (gridIndex: number, extra: Record<string, unknown> = {}) => ({
    type: "value", gridIndex, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: c.rule, opacity: 0.45 } },
    axisLabel: { ...axisText, formatter: (v: number) => (v === 0 ? "₹0" : money(v, false)) }, ...extra,
  });
  return {
    animation: false,
    title: [title("Cumulative closed P&L", 4), title("Result of each closed strategy", G.barTop - 26), title("Drawdown from peak", G.ddTop - 26)],
    grid: [{ left: G.left, right: G.right, top: G.eqTop, height: G.eqH }, { left: G.left, right: G.right, top: G.barTop, height: G.barH }, { left: G.left, right: G.right, top: G.ddTop, height: G.ddH }],
    xAxis: [xAxis(0, false), xAxis(1, false), xAxis(2, true)],
    yAxis: [yAxis(0, { scale: true, splitNumber: 4 }), yAxis(1, { splitNumber: 2 }), yAxis(2, { splitNumber: 2, max: 0, scale: true })],
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: c.muted, type: "dashed" } },
    tooltip: {
      trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, axisPointer: { type: "line" },
      formatter: (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
        if (i === 0) return "<b>Start</b><br/>Cumulative ₹0";
        const p = cv[i - 1]!;
        const col = (v: number) => (v > 0 ? c.up : v < 0 ? c.down : c.paper);
        return `<b>#${i} · ${p.name}</b><br/><span style="color:${c.muted}">Closed ${fmtDateTimeIST(p.label)}</span><br/>`
          + `Result <b style="color:${col(p.pnl)}">${money(p.pnl)}</b><br/>Cumulative <b style="color:${col(p.cum)}">${money(p.cum)}</b><br/>Drawdown <b style="color:${p.dd > 0 ? c.down : c.paper}">${p.dd > 0 ? money(-p.dd) : "at a new high"}</b>`;
      },
    },
    series: [
      {
        name: "Cumulative closed P&L", type: "line", xAxisIndex: 0, yAxisIndex: 0, symbol: "circle", symbolSize: 8, lineStyle: { width: 2.2, color: c.info }, itemStyle: { borderColor: c.slate, borderWidth: 1.5 },
        // each close is a dot, green when the cumulative P&L is above zero and red when it is below (a visualMap would do this but makes ECharts throw on a stepped category line)
        data: cum.map((v) => ({ value: v, itemStyle: { color: v > 0 ? c.up : v < 0 ? c.down : c.muted } })),
        areaStyle: { color: c.info, opacity: 0.06 },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: c.muted, type: "dashed", opacity: 0.7 }, data: [{ yAxis: 0 }] },
        markPoint: { silent: true, symbol: "circle", symbolSize: 1, data: [{ type: "max", name: "Peak" }], label: { show: true, position: "top", color: c.muted, fontSize: 10, formatter: (p: { value?: number }) => `Peak ${money(p.value ?? 0)}` } },
        endLabel: { show: true, formatter: () => money(last), backgroundColor: last >= 0 ? c.up : c.down, color: "#fff", padding: [2, 6], borderRadius: 3, fontSize: 11, offset: [6, 0] }, labelLayout: { moveOverlap: "shiftY" },
      },
      {
        name: "Result of each close", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: pnl.map((v) => (v == null ? null : { value: v, itemStyle: { color: v > 0 ? c.up : v < 0 ? c.down : c.muted, borderRadius: v >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })),
        barMaxWidth: 22, markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: c.muted, type: "solid", opacity: 0.5 }, data: [{ yAxis: 0 }] },
      },
      {
        name: "Drawdown", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: dd, symbol: "none", lineStyle: { color: c.down, width: 1.6 }, itemStyle: { color: c.down }, areaStyle: { color: c.down, opacity: 0.2 },
        markPoint: { silent: true, symbol: "circle", symbolSize: 6, itemStyle: { color: c.down, borderColor: c.slate, borderWidth: 1 }, data: stats.maxDrawdown > 0 ? [{ type: "min", name: "Worst" }] : [],
          label: { show: true, position: "bottom", color: c.down, fontSize: 10, formatter: (p: { value?: number }) => `Worst ${money(p.value ?? 0)}` } },
      },
    ],
  };
}
