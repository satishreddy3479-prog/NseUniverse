// ECharts options of the Greeks and What-If page: pure builders, so tests can assert exactly what each chart shows. Missing values are gaps, never zeros.
import type { EChartsCoreOption } from "echarts/core";
import type { ChartColors } from "./chartOptions";
import { fmtInt } from "./format";
import { type GridResult, num, type Num, rupees, type SurfaceStrike } from "./risk";

const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });
const signedPts = (v: number): string => (v > 0 ? `+${fmtInt(v)}` : v < 0 ? `−${fmtInt(-v)}` : "0");
const compact = (v: number): string => {
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(1)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${s}`;
};

/** Column labels of a grid: volatility shocks in points, or elapsed time in hours/days. */
export function colLabel(kind: GridResult["col_kind"], v: number): string {
  if (kind === "iv_points") return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0";
  return v === 0 ? "now" : v < 48 ? `+${v.toFixed(v % 1 ? 1 : 0)}h` : `+${(v / 24).toFixed(1)}d`;
}

/** The risk matrix: P&L in rupees for every spot shock (rows) and volatility shock or elapsed time (columns), red below zero, green above, symmetrical so the colour never lies about sign. */
export function riskMatrixOption(g: GridResult, forward: Num, c: ChartColors): EChartsCoreOption {
  const cols = g.col_axis.map((v) => colLabel(g.col_kind, v));
  const rows = g.row_axis.map((v) => (forward != null ? `${fmtInt(forward + v)} (${signedPts(v)})` : signedPts(v)));
  const data: [number, number, number][] = [];
  let big = 0;
  g.pnl.forEach((r, yi) => r.forEach((v, xi) => { if (v != null) { data.push([xi, yi, v]); big = Math.max(big, Math.abs(v)); } }));
  const bound = big > 0 ? big : 1;
  const showLabels = g.row_axis.length * g.col_axis.length <= 81;
  return {
    animation: false,
    grid: { left: 96, right: 70, top: 20, bottom: 44 },
    tooltip: {
      confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (p: { value: [number, number, number] }) => `Spot ${rows[p.value[1]]}<br/>${g.col_kind === "iv_points" ? "IV" : "Time"} ${cols[p.value[0]]}<br/><b>${rupees(p.value[2])}</b>`,
    },
    xAxis: { type: "category", data: cols, name: g.col_kind === "iv_points" ? "IV shock (vol points)" : "Time elapsed", nameLocation: "middle", nameGap: 28, axisLabel: axisText(c), splitArea: { show: false } },
    yAxis: { type: "category", data: rows, name: "Spot (forward, shock)", nameLocation: "middle", nameGap: 78, axisLabel: axisText(c), inverse: true },
    visualMap: { min: -bound, max: bound, calculable: false, orient: "vertical", right: 0, top: "center", itemHeight: 120, text: ["profit", "loss"], textStyle: { color: c.muted, fontSize: 10 }, inRange: { color: [c.down, c.slate, c.up] }, formatter: (v: number) => compact(v) },
    series: [{
      name: "P&L", type: "heatmap", data,
      label: { show: showLabels, fontSize: 10, color: c.paper, formatter: (p: { value: [number, number, number] }) => compact(p.value[2]) },
      emphasis: { itemStyle: { borderColor: c.paper, borderWidth: 1 } },
    }],
  } as EChartsCoreOption;
}

/** Zero crossings of a piecewise-linear curve (x ascending): where the position breaks even, found by interpolating between the returned points. */
export function breakevens(xs: number[], ys: Num[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = ys[i - 1];
    const b = ys[i];
    if (a == null || b == null) continue;
    if (a === 0) out.push(xs[i - 1]!);
    else if (a * b < 0) out.push(xs[i - 1]! + ((xs[i]! - xs[i - 1]!) * a) / (a - b));
  }
  return out;
}

export interface PayoffInput { atExpiry: GridResult; now: { shocks: number[]; pnl: Num[] } | null; forward: Num; sd1: Num; sd2: Num; colors: ChartColors }

/** The payoff chart: P&L at the nearest expiry and, when given, today, against the index level, with the one and two standard deviation bands and the breakeven points. */
export function payoffOption(i: PayoffInput): EChartsCoreOption {
  const c = i.colors;
  const f = i.forward ?? 0;
  const xs = i.atExpiry.row_axis.map((v) => f + v);
  const exp = i.atExpiry.pnl.map((r) => r[0] ?? null);
  const line = (name: string, shocks: number[], ys: Num[], color: string, dash = false) => ({
    name, type: "line", showSymbol: false, connectNulls: false, data: shocks.map((s, k) => [f + s, ys[k] ?? null]), lineStyle: { color, width: 2, type: dash ? "dashed" : "solid" }, itemStyle: { color },
  });
  const be = breakevens(xs, exp);
  const band = (lo: number, hi: number, alpha: number) => [{ xAxis: f + lo, itemStyle: { color: c.brass, opacity: alpha } }, { xAxis: f + hi }];
  const areas: unknown[] = [];
  if (i.sd2 != null) { areas.push(band(-i.sd2, -i.sd1!, 0.07), band(i.sd1!, i.sd2, 0.07)); }
  if (i.sd1 != null) areas.push(band(-i.sd1, i.sd1, 0.12));
  const series: Record<string, unknown>[] = [line("At expiry", i.atExpiry.row_axis, exp, c.up)];
  if (i.now) series.push(line("Today (no time or volatility change)", i.now.shocks, i.now.pnl, c.info, true));
  series[0] = {
    ...series[0],
    markLine: { symbol: "none", silent: true, lineStyle: { color: c.muted, type: "solid", width: 1 }, label: { show: false }, data: [{ yAxis: 0 }, ...(i.forward != null ? [{ xAxis: f, lineStyle: { color: c.brass, type: "dotted" } }] : [])] },
    markArea: { silent: true, data: areas },
    markPoint: { symbol: "diamond", symbolSize: 12, itemStyle: { color: c.paper }, label: { show: false }, data: be.map((x) => ({ coord: [x, 0], name: `Breakeven ${fmtInt(x)}` })) },
  };
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 70, right: 16, top: 30, bottom: 40 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => rupees(typeof v === "number" ? v : null) },
    xAxis: { type: "value", scale: true, name: "Index level", nameLocation: "middle", nameGap: 26, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => compact(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series,
  } as EChartsCoreOption;
}

const byStrike = (a: SurfaceStrike, b: SurfaceStrike) => a.strike - b.strike;

/** The smile of one expiry: the SVI fit as a line, the market volatilities used as dots, the flagged and the unused other-side points marked apart; the forward as a vertical line. */
export function smileOption(strikes: SurfaceStrike[], forward: Num, c: ChartColors): EChartsCoreOption {
  const pct = (v: number | null) => (v == null ? null : v * 100);
  const fitted = [...strikes].filter((x) => x.fit_iv != null && (x.status === "used" || x.status === "flagged")).sort(byStrike);
  const pts = (status: SurfaceStrike["status"]) => strikes.filter((x) => x.status === status && x.iv != null).sort(byStrike).map((x) => [x.strike, pct(x.iv)]);
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 54, right: 16, top: 30, bottom: 40 },
    tooltip: { trigger: "item", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "—") },
    xAxis: { type: "value", scale: true, name: "Strike", nameLocation: "middle", nameGap: 26, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => `${v.toFixed(1)}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      { name: "Fitted smile", type: "line", showSymbol: false, smooth: false, data: fitted.map((x) => [x.strike, pct(x.fit_iv)]), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass },
        markLine: forward != null ? { symbol: "none", silent: true, label: { formatter: "forward", color: c.muted, fontSize: 10 }, lineStyle: { color: c.muted, type: "dotted" }, data: [{ xAxis: forward }] } : undefined },
      { name: "Market (used)", type: "scatter", symbolSize: 6, data: pts("used"), itemStyle: { color: c.info } },
      { name: "Flagged (arbitrage)", type: "scatter", symbol: "diamond", symbolSize: 11, data: pts("flagged"), itemStyle: { color: c.down } },
      { name: "Other side (not used)", type: "scatter", symbolSize: 4, data: pts("unused"), itemStyle: { color: c.muted, opacity: 0.6 } },
    ],
  } as EChartsCoreOption;
}

/** Fit residuals in volatility points per strike (market minus fit), with the degradation limit as lines; flagged strikes in red. */
export function residualOption(strikes: SurfaceStrike[], limit: number, c: ChartColors): EChartsCoreOption {
  const rows = strikes.filter((x) => (x.status === "used" || x.status === "flagged") && x.residual_vol_pts != null).sort(byStrike);
  return {
    animation: false,
    grid: { left: 54, right: 16, top: 16, bottom: 40 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => `${num(typeof v === "number" ? v : null, 3, true)} vol pts` },
    xAxis: { type: "category", data: rows.map((x) => String(x.strike)), name: "Strike", nameLocation: "middle", nameGap: 26, axisLabel: axisText(c) },
    yAxis: { type: "value", name: "Residual (vol pts)", axisLabel: axisText(c), splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{
      name: "Residual", type: "bar", data: rows.map((x) => ({ value: x.residual_vol_pts, itemStyle: { color: x.status === "flagged" ? c.down : Math.abs(x.residual_vol_pts ?? 0) > limit ? c.brass : c.info } })),
      markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, type: "dashed" }, data: [{ yAxis: limit }, { yAxis: -limit }] },
    }],
  } as EChartsCoreOption;
}
