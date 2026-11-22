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
/** The top of the smile chart in percent: 1.6 times the highest fitted volatility, rounded up to 5. Undefined when nothing is fitted (the axis then scales itself). */
export function smileTop(strikes: SurfaceStrike[]): number | undefined {
  const fitted = strikes.filter((x) => x.fit_iv != null && (x.status === "used" || x.status === "flagged"));
  return fitted.length ? Math.ceil((Math.max(...fitted.map((x) => x.fit_iv! * 100)) * 1.6) / 5) * 5 : undefined;
}
export function smileOption(strikes: SurfaceStrike[], forward: Num, c: ChartColors): EChartsCoreOption {
  const pct = (v: number | null) => (v == null ? null : v * 100);
  const fitted = [...strikes].filter((x) => x.fit_iv != null && (x.status === "used" || x.status === "flagged")).sort(byStrike);
  // The axis follows the smile, not the stray quotes: a far or other-side quote can print 100 % or more and would squash the curve into the bottom of the chart.
  // Quotes above the top are not drawn (the text under the chart counts them).
  const yMax = smileTop(strikes);
  const pts = (status: SurfaceStrike["status"]) => strikes.filter((x) => x.status === status && x.iv != null).sort(byStrike).map((x) => [x.strike, pct(x.iv)]);
  return {
    animation: false,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 12 }, itemWidth: 14, itemHeight: 8, itemGap: 14 },
    grid: { left: 54, right: 16, top: 56, bottom: 40 },
    tooltip: { trigger: "item", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "—") },
    xAxis: { type: "value", scale: true, name: "Strike", nameLocation: "middle", nameGap: 26, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { show: false } },
    yAxis: { type: "value", min: 0, ...(yMax != null ? { max: yMax } : {}), axisLabel: { ...axisText(c), formatter: (v: number) => `${v.toFixed(0)}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      { name: "Fitted smile", type: "line", showSymbol: false, smooth: false, z: 3.5, data: fitted.map((x) => [x.strike, pct(x.fit_iv)]), lineStyle: { color: c.brass, width: 2.5 }, itemStyle: { color: c.brass },
        markLine: forward != null ? { symbol: "none", silent: true, label: { formatter: "forward", color: c.muted, fontSize: 11, position: "end", rotate: 0, distance: 4 }, lineStyle: { color: c.muted, type: "dotted" }, data: [{ xAxis: forward }] } : undefined },
      { name: "Market (used in the fit)", type: "scatter", symbolSize: 6, z: 3, data: pts("used"), itemStyle: { color: c.info } },
      // flagged quotes are hollow and small so the market dot under them stays visible
      { name: "Flagged (breaks a no-arbitrage rule)", type: "scatter", symbol: "diamond", symbolSize: 9, z: 4, data: pts("flagged"), itemStyle: { color: "transparent", borderColor: c.down, borderWidth: 1.6 } },
      { name: "Not used (far or other-side quotes)", type: "scatter", symbolSize: 4, z: 1, data: pts("unused"), itemStyle: { color: c.muted, opacity: 0.55 } },
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

/** The fitted implied volatility (as a fraction) at ``k``, by straight-line interpolation between the two nearest fitted strikes; null outside the fitted strikes. */
export function fitAt(strikes: SurfaceStrike[], k: number): number | null {
  const f = [...strikes].filter((x) => x.fit_iv != null && (x.status === "used" || x.status === "flagged")).sort(byStrike);
  for (let i = 1; i < f.length; i++) {
    const a = f[i - 1]!, b = f[i]!;
    if (k >= a.strike && k <= b.strike) return b.strike === a.strike ? a.fit_iv : a.fit_iv! + ((b.fit_iv! - a.fit_iv!) * (k - a.strike)) / (b.strike - a.strike);
  }
  return null;
}

export interface SmileReading { headline: string; lines: string[]; above: number }
/**
 * The smile in plain words, every figure read from the surface: the at-the-money volatility, the volatility 5 % below and above the forward, which side the
 * market charges more for, how close the line is to the quotes, whether the no-arbitrage checks pass, what the grey dots are, and how many quotes sit above the
 * top of the chart. Nothing is concluded that the numbers do not show.
 */
export function smileReading(strikes: SurfaceStrike[], forward: Num, s: { n_used: number; n_rejected: number; n_flagged: number; rms_vol_pts: number | null; butterfly_ok: boolean; calendar_ok: boolean; params: unknown | null }): SmileReading {
  const p = (v: number | null) => (v == null ? null : v * 100);
  const atm = forward == null ? null : p(fitAt(strikes, forward));
  const lo = forward == null ? null : p(fitAt(strikes, forward * 0.95)), hi = forward == null ? null : p(fitAt(strikes, forward * 1.05));
  if (atm == null || forward == null) return { headline: "no smile could be fitted for this expiry", lines: ["There is nothing to read here until a smile can be fitted."], above: 0 };
  const f1 = (v: number) => v.toFixed(1);
  const lines: string[] = [];
  lines.push(`At the money (the forward, ${Math.round(forward).toLocaleString("en-IN")}) the market is pricing ${f1(atm)}% volatility a year. That is the bottom of the curve.`);
  if (lo != null && hi != null) {
    const d = lo - hi;
    lines.push(`5% below the forward the line is at ${f1(lo)}% (${f1(lo - atm)} points above the money) and 5% above it ${f1(hi)}% (${f1(hi - atm)} points above).`);
    lines.push(Math.abs(d) < 1 ? "The two sides are about level: the market is not paying more for one direction." : d > 0 ? "The left side is higher: puts (downside protection) are priced richer than calls. This is the usual shape for an index." : "The right side is higher: calls are priced richer than puts, which is less usual for an index.");
  }
  lines.push("A U-shape is normal: the further a strike is from the money, the more volatility the market charges. A dot above the line is an option priced richer than the smile says, below the line cheaper.");
  const gap = s.rms_vol_pts;
  lines.push(`${s.n_used} quotes shape the line${gap == null ? "" : `; on average they sit ${gap.toFixed(2)} volatility points from it (${gap < 0.5 ? "a tight fit" : gap < 1.5 ? "a fair fit" : "a loose fit: treat the Greeks with care"})`}.`);
  if (s.params != null) lines.push(s.butterfly_ok && s.calendar_ok ? "The no-arbitrage checks pass (butterfly and calendar): the curve does not imply free money between strikes or expiries." : `A no-arbitrage check fails (${[!s.butterfly_ok ? "butterfly" : "", !s.calendar_ok ? "calendar" : ""].filter(Boolean).join(" and ")}): the smile prices something inconsistently.`);
  const unused = strikes.filter((x) => x.status === "unused").length;
  if (unused > 0) lines.push(`${unused} grey dots are quotes that were not used: far out of the money or on the other side of the forward, where prices are thin and the implied volatility can print absurdly high. They are ignored by the fit.`);
  if (s.n_flagged + s.n_rejected > 0) lines.push(`${s.n_flagged} flagged (hollow red diamonds: a quote that breaks a no-arbitrage rule) and ${s.n_rejected} rejected quotes are listed under the chart with the reason.`);
  const top = smileTop(strikes) ?? Infinity;
  const above = strikes.filter((x) => x.iv != null && x.iv * 100 > top).length;
  const shape = lo != null && hi != null ? (lo - hi > 1 ? ", steeper on the downside" : hi - lo > 1 ? ", steeper on the upside" : ", level on both sides") : "";
  return { headline: `${f1(atm)}% at the money${shape}`, lines, above };
}
