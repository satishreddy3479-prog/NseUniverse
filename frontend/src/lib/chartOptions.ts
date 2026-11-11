// Pure builders for ECharts options. They contain all plotting decisions so tests can assert exactly
// what each chart shows. Missing values become gaps (null), never zero.
import type { EChartsCoreOption } from "echarts/core";
import type { SmartOiResult } from "./optionTools";
import { compactIN, isSessionMs, type Totals } from "./analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice, fmtTimeIST } from "./format";
import type { FuturesSeries, IntradayScoreRow, Observation, OiChange, OiHeatmap, OiSeries, OptionChainRow, PremiumDecay } from "./types";

export interface ChartColors {
  up: string; down: string; brass: string; info: string; muted: string; rule: string; paper: string; slate: string;
}

export type StrikeMetric = "oi" | "oiChange" | "volume";

const LABEL: Record<StrikeMetric, string> = { oi: "Open interest", oiChange: "OI change", volume: "Volume" };

function metricOf(q: { oi: number | null; oi_change: number | null; volume: number | null } | null, m: StrikeMetric): number | null {
  if (!q) return null;
  return m === "oi" ? q.oi : m === "oiChange" ? q.oi_change : q.volume;
}

const axisText = (c: ChartColors) => ({ color: c.muted, fontSize: 11 });

export interface StrikeBarInput {
  rows: OptionChainRow[];
  metric: StrikeMetric;
  atmStrike: number | null;
  selectedStrike: number | null;
  showCalls: boolean;
  showPuts: boolean;
  colors: ChartColors;
}

export function strikeBarOption(i: StrikeBarInput): EChartsCoreOption {
  const strikes = i.rows.map((r) => String(r.strike));
  const ce = i.rows.map((r) => metricOf(r.call, i.metric));
  const pe = i.rows.map((r) => metricOf(r.put, i.metric));
  const lines = [] as { xAxis: string; name: string; lineStyle: object; label: object }[];
  if (i.atmStrike != null && strikes.includes(String(i.atmStrike)))
    lines.push({
      xAxis: String(i.atmStrike), name: "ATM",
      lineStyle: { color: i.colors.brass, type: "dashed", width: 1.5 },
      label: { formatter: `ATM ${fmtInt(i.atmStrike)}`, color: i.colors.brass, fontSize: 11 },
    });
  if (i.selectedStrike != null && i.selectedStrike !== i.atmStrike && strikes.includes(String(i.selectedStrike)))
    lines.push({
      xAxis: String(i.selectedStrike), name: "Selected",
      lineStyle: { color: i.colors.info, type: "solid", width: 1.5 },
      label: { formatter: `Selected ${fmtInt(i.selectedStrike)}`, color: i.colors.info, fontSize: 11 },
    });
  // The marker lines hang on the first visible series, so they stay when calls or puts are hidden.
  const firstShown = i.showCalls ? "Calls (CE)" : "Puts (PE)";
  const mk = (name: string, data: (number | null)[], color: string, show: boolean) =>
    show ? [{
      name, type: "bar", data, itemStyle: { color }, barMaxWidth: 14, barGap: "10%",
      emphasis: { focus: "series" },
      markLine: name === firstShown && lines.length ? { symbol: "none", silent: true, data: lines } : undefined,
    }] : [];
  return {
    animation: false,
    grid: { left: 58, right: 14, top: 34, bottom: 56 },
    legend: { top: 0, right: 0, textStyle: { color: i.colors.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: i.colors.slate, borderColor: i.colors.rule, textStyle: { color: i.colors.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string; seriesName: string; value: number | null }[];
        const head = `<b>Strike ${fmtInt(Number(ps[0]?.axisValue))}</b>`;
        const body = ps.map((p) => `${p.seriesName}: ${p.value == null ? "—" : fmtInt(p.value)}`).join("<br/>");
        return `${head}<br/>${LABEL[i.metric]} (units)<br/>${body}`;
      },
    },
    xAxis: { type: "category", data: strikes, axisLabel: { ...axisText(i.colors), hideOverlap: true }, axisLine: { lineStyle: { color: i.colors.rule } } },
    yAxis: { type: "value", axisLabel: { ...axisText(i.colors), formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: i.colors.rule, opacity: 0.5 } } },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 14, bottom: 6, borderColor: i.colors.rule, textStyle: { color: i.colors.muted } }],
    series: [...mk("Calls (CE)", ce, i.colors.up, i.showCalls), ...mk("Puts (PE)", pe, i.colors.down, i.showPuts)],
  };
}

export interface TotalsInput { totals: Totals; metric: StrikeMetric; showCalls: boolean; showPuts: boolean; colors: ChartColors }

export function totalsBarOption(i: TotalsInput): EChartsCoreOption {
  const t = i.totals;
  const ce = i.metric === "oi" ? t.ceOi : i.metric === "oiChange" ? t.ceOiChange : t.ceVolume;
  const pe = i.metric === "oi" ? t.peOi : i.metric === "oiChange" ? t.peOiChange : t.peVolume;
  const bars: { name: string; value: number | null; itemStyle: { color: string } }[] = [];
  if (i.showCalls) bars.push({ name: "CE", value: ce, itemStyle: { color: i.colors.up } });
  if (i.showPuts) bars.push({ name: "PE", value: pe, itemStyle: { color: i.colors.down } });
  return {
    animation: false,
    grid: { left: 6, right: 6, top: 34, bottom: 24 },
    title: { text: `Total ${LABEL[i.metric]}`, left: "center", top: 0, textStyle: { color: i.colors.muted, fontSize: 11, fontWeight: "normal" } },
    tooltip: { trigger: "item", backgroundColor: i.colors.slate, borderColor: i.colors.rule, textStyle: { color: i.colors.paper, fontSize: 12 },
      formatter: (p: unknown) => { const x = p as { name: string; value: number | null }; return `${x.name} total: ${x.value == null ? "—" : fmtInt(x.value)} units`; } },
    xAxis: { type: "category", data: bars.map((b) => b.name), axisLabel: axisText(i.colors), axisTick: { show: false }, axisLine: { lineStyle: { color: i.colors.rule } } },
    yAxis: { type: "value", show: false },
    series: [{ type: "bar", data: bars, barWidth: "60%", label: { show: true, position: "top", color: i.colors.paper, fontSize: 11, formatter: (p: unknown) => compactIN((p as { value: number | null }).value) } }],
  };
}

// ----------------------------------------------------------------- time series from stored snapshots
const t = (o: Observation) => new Date(o.retrieved_at).getTime();

/** Soft fill under a line: the same colour fading to nothing, so the level reads at a glance. */
const fade = (color: string, top = 0.22) => ({
  color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color }, { offset: 1, color: /^#[0-9a-f]{6}$/i.test(color) ? `${color}00` : "rgba(128,128,128,0)" }] },
  opacity: top,
});

function timeAxis(c: ChartColors) {
  return { type: "time", axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: false } };
}

function tsBase(c: ChartColors, valueFormatter: (v: number) => string) {
  return {
    animation: false,
    grid: { left: 58, right: 16, top: 34, bottom: 44 },
    legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: c.muted, type: "dashed" }, label: { backgroundColor: c.slate } },
      extraCssText: "border-radius:6px;box-shadow:var(--shadow-pop)",
      formatter: (params: unknown) => {
        const ps = params as { axisValue: number; seriesName: string; value: [number, number | null] }[];
        return `<b>${fmtDateTimeIST(new Date(ps[0]!.axisValue).toISOString())}</b><br/>` +
          ps.map((p) => `${p.seriesName}: ${p.value[1] == null ? "—" : valueFormatter(p.value[1])}`).join("<br/>");
      } },
    xAxis: timeAxis(c),
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 12, bottom: 4, borderColor: c.rule, textStyle: { color: c.muted } }],
  };
}

export function premiumOption(obs: Observation[], c: ChartColors, showCalls = true, showPuts = true): EChartsCoreOption {
  // A sample with more contracts missing a price than the best sample sums fewer contracts, so its total would
  // jump for a reason that is not the market: draw it as a gap instead of a misleading point.
  const fewestMissing = Math.min(...obs.map((o) => o.missing_ltp));
  const line = (name: string, color: string, rawPick: (o: Observation) => number | null) => {
    const pick = (o: Observation) => (o.missing_ltp > fewestMissing ? null : rawPick(o));
    return lineOf(name, color, pick);
  };
  const lineOf = (name: string, color: string, pick: (o: Observation) => number | null) => ({
    name, type: "line", showSymbol: false, emphasis: { focus: "series" }, itemStyle: { color }, lineStyle: { color, width: 2 },
    areaStyle: fade(color, 0.14), data: obs.map((o) => [t(o), pick(o)]),
  });
  return {
    ...tsBase(c, (v) => fmtPrice(v)),
    yAxis: { type: "value", scale: true, minInterval: 1, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      ...(showCalls ? [line("CE total premium", c.up, (o) => o.total_ce_premium)] : []),
      ...(showPuts ? [line("PE total premium", c.down, (o) => o.total_pe_premium)] : []),
    ],
  };
}

/** Change in total premium relative to the first observation passed in (the baseline of the chosen range). */
/**
 * Premium change of a FIXED set of strikes since the first sample in range (server side sums the same contracts at
 * every point). A point with no usable strike is a gap.
 */
export function decayOption(res: PremiumDecay, c: ChartColors, showCalls = true, showPuts = true): EChartsCoreOption {
  const times = res.times.map((x) => new Date(x).getTime());
  const area = (name: string, color: string, vals: (number | null)[]) => ({
    name, type: "line", showSymbol: false, itemStyle: { color }, lineStyle: { color, width: 1.8 },
    areaStyle: { color, opacity: 0.25 }, data: times.map((x, i) => [x, vals[i] ?? null]),
    markLine: { symbol: "none", silent: true, lineStyle: { color: c.muted, type: "dashed" }, label: { show: false }, data: [{ yAxis: 0 }] },
  });
  return {
    ...tsBase(c, (v) => `${v >= 0 ? "+" : "−"}${fmtPrice(Math.abs(v))}`),
    yAxis: { type: "value", scale: true, minInterval: 1, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      ...(showCalls ? [area("CE premium change", c.up, res.ce)] : []),
      ...(showPuts ? [area("PE premium change", c.down, res.pe)] : []),
    ],
  };
}

export function spotOption(obs: Observation[], c: ChartColors): EChartsCoreOption {
  const prev = obs.find((o) => o.underlying_prev_close != null)?.underlying_prev_close ?? null;
  // Fit the axis to the index level and the previous close; ECharts' own scaling blows a flat line up to 10,000-35,000.
  const levels = [...obs.map((o) => o.underlying_ltp), prev].filter((v): v is number => v != null);
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = Math.max((hi - lo) * 0.25, hi * 0.001);
  const fit = levels.length ? { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) } : {};
  return {
    ...tsBase(c, (v) => fmtPrice(v)),
    yAxis: { type: "value", scale: true, ...fit, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{
      name: "NIFTY 50 at snapshot", type: "line", showSymbol: false, itemStyle: { color: c.info }, lineStyle: { color: c.info, width: 2 },
      areaStyle: fade(c.info, 0.14),
      data: obs.map((o) => [t(o), o.underlying_ltp]),
      markLine: prev == null ? undefined : { symbol: "none", silent: true, lineStyle: { color: c.muted, type: "dashed" },
        label: { formatter: `Prev close ${fmtPrice(prev)}`, color: c.muted, fontSize: 11, position: "insideEndTop" }, data: [{ yAxis: prev }] },
    }],
  };
}

export function straddleOption(obs: Observation[], c: ChartColors): EChartsCoreOption {
  return {
    ...tsBase(c, (v) => fmtPrice(v)),
    yAxis: { type: "value", scale: true, minInterval: 1, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{
      name: "ATM straddle", type: "line", showSymbol: false, itemStyle: { color: c.brass }, lineStyle: { color: c.brass, width: 2 },
      areaStyle: fade(c.brass, 0.14),
      data: obs.map((o) => ({ value: [t(o), o.straddle], atm: o.atm_strike })),
      tooltip: { formatter: (p: unknown) => { const x = p as { value: [number, number | null]; data: { atm: number | null } }; return `ATM ${x.data.atm ?? "—"}: ${x.value[1] == null ? "—" : fmtPrice(x.value[1])}`; } },
    }],
  };
}

// ----------------------------------------------------------------- OI intelligence
// Colours for OI direction are deliberately neutral (blue = increase, amber = decrease): OI moving
// either way says nothing about who traded or what happens next.

/** OI change per strike against the chosen baseline. Missing baselines are gaps, never zero. */
export function oiChangeBarOption(
  res: OiChange, showCalls: boolean, showPuts: boolean, selectedStrike: number | null, c: ChartColors,
): EChartsCoreOption {
  const strikes = [...new Set(res.rows.map((r) => r.strike))].sort((a, b) => a - b);
  const pick = (side: "CE" | "PE") => strikes.map((k) => res.rows.find((r) => r.strike === k && r.side === side)?.change ?? null);
  const lines: { xAxis: string; name: string; lineStyle: object; label: object }[] = [];
  const mark = (k: number | null, name: string, color: string) => {
    if (k != null && strikes.includes(k))
      lines.push({ xAxis: String(k), name, lineStyle: { color, type: "dashed", width: 1.5 }, label: { formatter: `${name} ${fmtInt(k)}`, color, fontSize: 11 } });
  };
  mark(res.atm_strike, "ATM", c.brass);
  if (selectedStrike !== res.atm_strike) mark(selectedStrike, "Selected", c.info);
  const firstShown = showCalls ? "Calls (CE)" : "Puts (PE)";
  const bar = (name: string, data: (number | null)[], color: string, show: boolean) =>
    show ? [{ name, type: "bar", data, itemStyle: { color }, barMaxWidth: 14, barGap: "10%",
      markLine: name === firstShown && lines.length ? { symbol: "none", silent: true, data: lines } : undefined }] : [];
  return {
    animation: false,
    grid: { left: 58, right: 14, top: 34, bottom: 56 },
    legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string; seriesName: string; value: number | null }[];
        return `<b>Strike ${fmtInt(Number(ps[0]?.axisValue))}</b><br/>OI change (units)<br/>` +
          ps.map((p) => `${p.seriesName}: ${p.value == null ? "no baseline" : (p.value > 0 ? "+" : p.value < 0 ? "−" : "") + fmtInt(Math.abs(p.value))}`).join("<br/>");
      } },
    xAxis: { type: "category", data: strikes.map(String), axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 14, bottom: 6, borderColor: c.rule, textStyle: { color: c.muted } }],
    series: [...bar("Calls (CE)", pick("CE"), c.info, showCalls), ...bar("Puts (PE)", pick("PE"), c.brass, showPuts)],
  };
}

/** Strike-by-time grid of OI change. Cells without a value are left out of the data, so they stay blank. */
export function oiHeatmapOption(h: OiHeatmap, c: ChartColors): EChartsCoreOption {
  const data: [number, number, number][] = [];
  h.change.forEach((row, yi) => row.forEach((v, xi) => { if (v != null) data.push([xi, yi, v]); }));
  const max = Math.max(1, ...data.map((d) => Math.abs(d[2])));
  const times = h.times.map((t) => fmtTimeIST(t));
  return {
    animation: false,
    grid: { left: 62, right: 16, top: 12, bottom: 70 },
    tooltip: { backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (p: unknown) => {
        const [xi, yi, v] = (p as { data: [number, number, number] }).data;
        return `Strike ${fmtInt(h.strikes[yi])} · ${times[xi]} IST<br/>OI change ${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtInt(Math.abs(v))} units<br/>${h.baseline.label}`;
      } },
    xAxis: { type: "category", data: times, axisLabel: { ...axisText(c), hideOverlap: true }, splitArea: { show: false }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "category", data: h.strikes.map((k) => String(k)), axisLabel: axisText(c), axisLine: { lineStyle: { color: c.rule } } },
    visualMap: { min: -max, max, calculable: false, orient: "horizontal", left: "center", bottom: 8, itemWidth: 12, itemHeight: 140,
      textStyle: { color: c.muted, fontSize: 11 }, inRange: { color: [c.brass, c.slate, c.info] }, formatter: (v: number) => compactIN(v) },
    series: [{ name: `OI change (${h.side})`, type: "heatmap", data, progressive: 0,
      itemStyle: { borderColor: c.slate, borderWidth: 1 }, emphasis: { itemStyle: { borderColor: c.paper } } }],
  };
}

/**
 * Stored rules-based sentiment scores through the session (left axis, -1..+1) with the sampled
 * NIFTY spot at each score (right axis). Missing scores are gaps, never 0.
 */
export function sentimentHistoryOption(rows: IntradayScoreRow[], c: ChartColors): EChartsCoreOption {
  // short HH:MM labels on the axis; the tooltip carries the full time and both values
  const hhmm = (iso: string) => fmtTimeIST(iso).slice(0, 5);
  const x = rows.map((r) => hhmm(r.sample_utc));
  return {
    animation: false,
    grid: { left: 44, right: 62, top: 36, bottom: 26 },
    legend: { top: 0, left: 0, itemWidth: 16, itemHeight: 3, textStyle: { color: c.paper, fontSize: 11 }, data: ["Sentiment score (−1 to +1)", "NIFTY (right axis)"] },
    tooltip: { trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const ps = params as { dataIndex: number; seriesName: string; value: number | null }[];
        const i = ps[0]!.dataIndex;
        return `<b>${fmtTimeIST(rows[i]!.sample_utc)}</b><br/>` + ps.map((p) => `${p.seriesName.startsWith("Sentiment") ? "Score" : "NIFTY"}: ${p.value == null ? "—" : p.seriesName.startsWith("Sentiment") ? p.value.toFixed(2) : fmtPrice(p.value)}`).join("<br/>");
      } },
    xAxis: { type: "category", data: x, axisLabel: { ...axisText(c), hideOverlap: true, interval: "auto" }, axisTick: { show: false }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [
      { type: "value", min: -1, max: 1, interval: 0.5, axisLabel: { color: c.brass, fontSize: 11, formatter: (v: number) => (v > 0 ? `+${v}` : String(v)) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      { type: "value", scale: true, axisLabel: { color: c.info, fontSize: 11, formatter: (v: number) => fmtInt(Math.round(v)) }, splitLine: { show: false } },
    ],
    series: [
      { name: "Sentiment score (−1 to +1)", type: "line", data: rows.map((r) => r.score), connectNulls: false, showSymbol: false,
        lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass }, areaStyle: { color: c.brass, opacity: 0.08 },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } } },
      { name: "NIFTY (right axis)", type: "line", yAxisIndex: 1, data: rows.map((r) => r.spot), showSymbol: false,
        lineStyle: { color: c.info, width: 1.4 }, itemStyle: { color: c.info } },
    ],
  };
}


/**
 * OI per strike over a window, three ways. "both": each side is one stacked bar whose height is the OI at the start of the
 * window plus any increase (lighter fill) and, for a decrease, an outlined segment up to where the OI used to be.
 * "change": only the change. "total": only the OI now. A strike without a baseline shows its total as a plain bar.
 */
export function oiExplorerOption(
  res: OiChange, mode: "both" | "change" | "total", showCalls: boolean, showPuts: boolean, selectedStrike: number | null, c: ChartColors, compact = false,
): EChartsCoreOption {
  const strikes = [...new Set(res.rows.map((r) => r.strike))].sort((a, b) => a - b);
  const row = (k: number, side: "CE" | "PE") => res.rows.find((r) => r.strike === k && r.side === side);
  const lines: { xAxis: string; name: string; lineStyle: object; label: object }[] = [];
  const mark = (k: number | null, name: string, color: string) => {
    if (k != null && strikes.includes(k)) lines.push({ xAxis: String(k), name, lineStyle: { color, type: "dashed", width: 1.5 }, label: { formatter: `${name} ${fmtInt(k)}`, color, fontSize: 11 } });
  };
  mark(res.atm_strike, "ATM", c.brass);
  if (selectedStrike !== res.atm_strike) mark(selectedStrike, "Selected", c.info);
  const sides = [{ side: "CE" as const, name: "Call", color: c.up, show: showCalls }, { side: "PE" as const, name: "Put", color: c.down, show: showPuts }].filter((s) => s.show);
  const series: object[] = [];
  sides.forEach((s, si) => {
    const r = strikes.map((k) => row(k, s.side));
    const first = si === 0 && lines.length ? { markLine: { symbol: "none", silent: true, data: lines } } : {};
    const common = { type: "bar", barMaxWidth: 16, barGap: "8%", stack: s.side };
    if (mode === "total") {
      series.push({ ...common, name: `${s.name} OI`, data: r.map((x) => x?.oi ?? null), itemStyle: { color: s.color }, ...first });
    } else if (mode === "change") {
      series.push({ ...common, stack: undefined, name: `${s.name} OI change`, data: r.map((x) => x?.change ?? null), itemStyle: { color: s.color }, ...first });
    } else {
      series.push(
        { ...common, name: `${s.name} OI`, data: r.map((x) => (x == null || x.oi == null ? null : x.baseline_oi == null ? x.oi : Math.min(x.oi, x.baseline_oi))), itemStyle: { color: s.color }, ...first },
        { ...common, name: `${s.name} OI increase`, data: r.map((x) => (x?.change != null && x.change > 0 ? x.change : null)), itemStyle: { color: s.color, opacity: 0.5 } },
        { ...common, name: `${s.name} OI decrease`, data: r.map((x) => (x?.change != null && x.change < 0 ? -x.change : null)), itemStyle: { color: s.color, opacity: 0.5 } },
      );
    }
  });
  const signed = (v: number | null) => (v == null ? "no baseline" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtInt(Math.abs(v)));
  return {
    animation: false,
    grid: compact ? { left: 44, right: 8, top: 16, bottom: 22 } : { left: 62, right: 14, top: 46, bottom: 56 },
    // a scrolling legend stays on one line (it wrapped onto a second row on a phone and was drawn over the axis and the ATM label)
    legend: compact ? { show: false } : { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string }[];
        const k = Number(ps[0]?.axisValue);
        const line = (side: "CE" | "PE", name: string) => {
          const x = row(k, side);
          return x ? `${name}: OI ${x.oi == null ? "—" : fmtInt(x.oi)} · change ${signed(x.change)}` : `${name}: no contract`;
        };
        return `<b>Strike ${fmtInt(k)}</b><br/>${[showCalls ? line("CE", "Call") : "", showPuts ? line("PE", "Put") : ""].filter(Boolean).join("<br/>")}`;
      } },
    xAxis: { type: "category", data: strikes.map(String), axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    dataZoom: compact ? [{ type: "inside", filterMode: "none" }] : [{ type: "inside", filterMode: "none" }, { type: "slider", height: 14, bottom: 6, borderColor: c.rule, textStyle: { color: c.muted } }],
    series,
  };
}

export type OiSeriesKind = "pcr" | "change" | "total" | "volume";

/**
 * PCR, OI change or total OI through time, with NIFTY as a dotted line on the left axis (StockMojo style).
 * Calls and puts use the same fixed strikes at every point; a missing value is a gap.
 */
export function oiSeriesOption(res: OiSeries, kind: OiSeriesKind, c: ChartColors, showCalls = true, showPuts = true): EChartsCoreOption {
  const x = res.times.map((v) => new Date(v).getTime());
  const line = (name: string, color: string, vals: (number | null)[], yAxisIndex: number, dotted = false) => ({
    name, type: "line", yAxisIndex, showSymbol: false, itemStyle: { color }, connectNulls: false,
    lineStyle: { color, width: dotted ? 1 : 1.8, type: dotted ? "dotted" : "solid" },
    data: x.map((t, i) => [t, vals[i] ?? null]),
  });
  const fmt = (name: string, v: number) => (name === "NIFTY" ? fmtPrice(v) : kind === "pcr" ? v.toFixed(3) : (v < 0 ? "−" : kind === "change" && v > 0 ? "+" : "") + compactIN(Math.abs(v)));
  const main =
    kind === "pcr"
      ? [{
          ...line("Put-call ratio", c.info, res.pcr, 1),
          areaStyle: fade(c.info, 0.12),
          // 1.0 = as many put contracts open as call contracts; a reference, not a signal
          markLine: { symbol: "none", silent: true, lineStyle: { color: c.muted, type: "dashed" },
            label: { formatter: "PCR 1.0", color: c.muted, fontSize: 10, position: "insideEndTop" }, data: [{ yAxis: 1 }] },
        }]
      : kind === "volume"
        ? [
            ...(showCalls ? [line("Call volume", c.up, res.ce_volume ?? res.times.map(() => null), 1)] : []),
            ...(showPuts ? [line("Put volume", c.down, res.pe_volume ?? res.times.map(() => null), 1)] : []),
          ]
        : [
          ...(showCalls ? [line(kind === "change" ? "Call OI change" : "Call OI", c.up, kind === "change" ? res.ce_change : res.ce_oi, 1)] : []),
          ...(showPuts ? [line(kind === "change" ? "Put OI change" : "Put OI", c.down, kind === "change" ? res.pe_change : res.pe_oi, 1)] : []),
        ];
  const axis = (opposite: boolean, f: (v: number) => string) => ({
    type: "value", scale: true, position: opposite ? "right" : "left", axisLabel: { ...axisText(c), formatter: f },
    splitLine: { show: !opposite, lineStyle: { color: c.rule, opacity: 0.5 } },
  });
  const base = tsBase(c, () => "");
  return {
    ...base,
    grid: { left: 58, right: 58, top: 34, bottom: 44 },
    tooltip: { ...base.tooltip, formatter: (params: unknown) => {
      const ps = params as { axisValue: number; seriesName: string; value: [number, number | null] }[];
      return `<b>${fmtDateTimeIST(new Date(ps[0]!.axisValue).toISOString())}</b><br/>` +
        ps.map((p) => `${p.seriesName}: ${p.value[1] == null ? "—" : fmt(p.seriesName, p.value[1])}`).join("<br/>");
    } },
    yAxis: [axis(false, (v) => fmtInt(v)), axis(true, (v) => (kind === "pcr" ? v.toFixed(2) : compactIN(v)))],
    series: [line("NIFTY", c.muted, res.spot, 0, true), ...main],
  };
}

export type FuturesKind = "oi" | "change" | "volume" | "basis";

/**
 * NIFTY current-month future through a session. OI, OI change and volume follow the option charts' layout (the
 * future's price as a dotted line on the left axis, the quantity on the right). "basis" draws the index and the
 * future on one price axis, with the gap between them (future minus index, in points) as an area on the right axis
 * and a corner readout of the latest gap, its percentage, the carry it implies per year and the financing-only fair value.
 * A value that was not recorded is a gap, never zero.
 */
export function futuresOption(res: FuturesSeries, kind: FuturesKind, c: ChartColors): EChartsCoreOption {
  const x = res.times.map((v) => new Date(v).getTime());
  const sign = (v: number, plus = false) => (v < 0 ? "−" : plus && v > 0 ? "+" : "");
  const line = (name: string, color: string, vals: (number | null)[], yAxisIndex: number, o: Record<string, unknown> = {}) => ({
    name, type: "line", yAxisIndex, showSymbol: false, itemStyle: { color }, connectNulls: false,
    lineStyle: { color, width: 1.8, ...(o.dotted ? { type: "dotted", width: 1 } : {}) }, data: x.map((t, i) => [t, vals[i] ?? null]),
    ...(o.area ? { areaStyle: fade(color, 0.14) } : {}), ...(o.extra as object ?? {}),
  });
  const axis = (opposite: boolean, f: (v: number) => string, extra: Record<string, unknown> = {}) => ({
    type: "value", scale: true, position: opposite ? "right" : "left", axisLabel: { ...axisText(c), formatter: f },
    splitLine: { show: !opposite, lineStyle: { color: c.rule, opacity: 0.5 } }, ...extra,
  });
  const base = tsBase(c, () => "");
  const tip = (fmt: (n: string, v: number) => string) => ({
    ...base.tooltip, formatter: (params: unknown) => {
      const ps = params as { axisValue: number; seriesName: string; value: [number, number | null] }[];
      return `<b>${fmtDateTimeIST(new Date(ps[0]!.axisValue).toISOString())}</b><br/>` + ps.map((p) => `${p.seriesName}: ${p.value[1] == null ? "—" : fmt(p.seriesName, p.value[1])}`).join("<br/>");
    },
  });
  if (kind === "basis") {
    const L = res.latest;
    const corner = L == null ? "Gap: not available" : [
      `Gap ${sign(L.basis, true)}${Math.abs(L.basis).toFixed(1)} pts${L.basis_pct == null ? "" : ` (${sign(L.basis_pct, true)}${Math.abs(L.basis_pct).toFixed(2)}%)`}`,
      L.carry_pct == null ? "" : `carry ${L.carry_pct.toFixed(2)}% p.a.`,
      L.fair_basis == null ? "" : `fair ${sign(L.fair_basis, true)}${Math.abs(L.fair_basis).toFixed(1)} · vs fair ${sign(L.vs_fair ?? 0, true)}${Math.abs(L.vs_fair ?? 0).toFixed(1)}`,
    ].filter(Boolean).join("\n");
    return {
      ...base,
      grid: { left: 62, right: 52, top: 62, bottom: 44 },
      graphic: [{ type: "text", right: 58, top: 26, silent: true, style: { text: corner, fill: c.paper, font: "600 11px sans-serif", textAlign: "right", lineHeight: 15, backgroundColor: c.slate, padding: [3, 6], borderRadius: 3 } }],
      tooltip: tip((n, v) => (n.startsWith("Gap") ? `${sign(v, true)}${Math.abs(v).toFixed(2)} pts` : fmtPrice(v))),
      yAxis: [axis(false, (v) => fmtInt(Math.round(v))), axis(true, (v) => `${sign(v, true)}${Math.abs(v).toFixed(0)}`)],
      series: [
        line("NIFTY spot", c.info, res.spot, 0),
        line("NIFTY future", c.brass, res.future, 0),
        line("Gap (future − spot)", c.muted, res.basis, 1, { area: true, extra: { lineStyle: { color: c.muted, width: 1, opacity: 0.8 }, markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } } } }),
      ],
    };
  }
  const main =
    kind === "oi" ? [line("Open interest", c.info, res.oi, 1, { area: true })]
    : kind === "change" ? [{
        // OI added (+) or removed (-) in each minute: the running change since the previous close is the same curve as OI shifted by a
        // constant, so it is shown as a number in the corner instead of a second identical line
        name: "OI per minute", type: "bar", yAxisIndex: 1, barMaxWidth: 5,
        data: x.map((t, i) => [t, res.oi_per_min[i] ?? null]),
        itemStyle: { color: (p: { value: [number, number | null] }) => ((p.value[1] ?? 0) >= 0 ? c.up : c.down) },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } },
      }]
    : [
        { name: "Volume per minute", type: "bar", yAxisIndex: 2, data: x.map((t, i) => [t, res.volume_per_min[i] ?? null]), itemStyle: { color: c.muted, opacity: 0.45 }, barMaxWidth: 4 },
        line("Volume today", c.info, res.volume, 1, { area: true }),
      ];
  const fmt = (n: string, v: number) => (n === "NIFTY future" ? fmtPrice(v) : `${sign(v, kind === "change")}${compactIN(Math.abs(v))}`);
  const lastChange = [...res.oi_change].reverse().find((v) => v != null) ?? null;
  const corner = kind === "change" && lastChange != null && res.oi_baseline
    ? `Since ${res.oi_baseline.kind}${res.oi_baseline.day ? ` (${res.oi_baseline.day})` : ""}: ${sign(lastChange, true)}${compactIN(Math.abs(lastChange))}` : "";
  // open interest axis in crore with three decimals (1.375 Cr), so neighbouring ticks never read the same
  const oiAxis = kind === "oi" ? (v: number) => `${(v / 1e7).toFixed(3)} Cr` : (v: number) => `${sign(v)}${compactIN(Math.abs(v))}`;
  return {
    ...base,
    grid: { left: 58, right: kind === "oi" ? 76 : 62, top: 34, bottom: 44 },
    tooltip: tip(fmt),
    ...(corner ? { graphic: [{ type: "text", left: 64, top: 8, silent: true, style: { text: corner, fill: c.paper, font: "600 11px sans-serif", backgroundColor: c.slate, padding: [3, 6], borderRadius: 3 } }] } : {}),
    yAxis: [axis(false, (v) => fmtInt(Math.round(v))), axis(true, oiAxis), { type: "value", show: false, scale: false, min: 0 }],
    series: [line("NIFTY future", c.muted, res.future, 0, { dotted: true }), ...main],
  };
}

export interface PayoffSeries {
  expiry: { s: number; pnl: number }[];
  /** model estimate on another date: null points are gaps where a leg could not be valued */
  target: { s: number; pnl: number | null }[] | null;
  targetLabel: string;
  spot: number;
  breakevens: number[];
  /** +-1 and 2 standard deviations at expiry (model) */
  bands: { m2: number; m1: number; p1: number; p2: number } | null;
  /** open interest per strike drawn faintly behind the payoff */
  oi: { strike: number; call: number | null; put: number | null }[] | null;
  /** "oi": open interest from zero up; "change": change in OI, bars may go below the zero line */
  oiMode?: "oi" | "change";
  /** NIFTY levels where a leg is modelled to hit its target or stop (estimates) */
  levels?: { s: number; kind: "target" | "stop" | "whatif"; label: string }[];
}

const lerp = (pts: { s: number; pnl: number | null }[], x: number): number | null => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (x >= a.s && x <= b.s) {
      if (a.pnl == null || b.pnl == null) return null;
      return b.s === a.s ? b.pnl : a.pnl + ((b.pnl - a.pnl) * (x - a.s)) / (b.s - a.s);
    }
  }
  return null;
};

/**
 * Payoff diagram: exact P&L at expiry (profit green, loss red), an optional dashed model estimate for another date,
 * markers for the spot, breakevens and standard deviations, and faint open-interest bars. Profit and loss are separate
 * series with the exact breakeven points inserted, not a visualMap: a piecewise visualMap on this series makes ECharts
 * throw ("reading 'coord'"), which once blanked the whole page.
 */
/** Visible price window of the payoff chart. */
export interface PayoffView { lo: number; hi: number; fullLo: number; fullHi: number; focus: number; canIn: boolean; canOut: boolean }

/** Zoom steps in and out from the profit-zone window; each step changes the window width by a factor of 0.7. */
export const PAYOFF_ZOOM = { min: -4, max: 6, factor: 0.7 };

/**
 * The window the payoff chart shows. At step 0 it frames the profit zone (between the breakevens, or around the
 * breakeven when the profit is open-ended) with the current price included and a margin. Zooming in narrows the
 * window around the CENTRE OF THE PROFIT ZONE, zooming out widens it up to the whole computed range. Edges snap to
 * whole 10s so the axis does not move with every tick.
 */
export function payoffView(curve: { s: number }[], breakevens: number[], spot: number, strikes: number[], step: number): PayoffView | null {
  if (curve.length < 2) return null;
  const fullLo = curve[0]!.s, fullHi = curve[curve.length - 1]!.s;
  const bes = [...breakevens].sort((a, b) => a - b);
  const anchors = [...bes, spot];
  const focus = bes.length >= 2 ? (bes[0]! + bes[bes.length - 1]!) / 2 : bes.length === 1 ? (bes[0]! + spot) / 2 : spot;
  if (bes.length === 0) anchors.push(...strikes);
  const span = Math.max(...anchors) - Math.min(...anchors);
  const baseHalf = Math.max((span / 2) * 1.35, spot * 0.012);
  const fullHalf = Math.max(focus - fullLo, fullHi - focus);
  const half = Math.min(fullHalf, Math.max(spot * 0.002, baseHalf * Math.pow(PAYOFF_ZOOM.factor, step)));
  const snap = (v: number) => Math.round(v / 10) * 10;
  const lo = Math.max(fullLo, snap(focus - half)), hi = Math.min(fullHi, snap(focus + half));
  return { lo, hi, fullLo, fullHi, focus, canIn: step < PAYOFF_ZOOM.max, canOut: lo > fullLo || hi < fullHi };
}

export function payoffOption(p: PayoffSeries, c: ChartColors, view?: { lo: number; hi: number } | null, compact = false): EChartsCoreOption {
  const pts = [...p.expiry, ...p.breakevens.map((b) => ({ s: b, pnl: 0 }))].sort((x, y) => x.s - y.s);
  const line = (label: string, color: string, keep: (v: number) => boolean) => ({
    name: label, type: "line", showSymbol: false, itemStyle: { color }, lineStyle: { width: 2.6, color }, z: 3,
    areaStyle: { color, opacity: 0.14 }, data: pts.map((x) => [x.s, keep(x.pnl) ? x.pnl : null]),
  });
  // y scale: fit the shape that matters. A side that runs off to a huge loss or profit is clipped at 3x the other
  // side, so the peak and the breakevens stay readable.
  const inView = view ? pts.filter((x) => x.s >= view.lo && x.s <= view.hi) : pts;
  const edge = view ? [lerp(pts, view.lo), lerp(pts, view.hi)].filter((v): v is number => v != null) : [];
  const vals = [...inView.map((x) => x.pnl), ...edge];
  const peak = Math.max(0, ...vals), trough = Math.min(0, ...vals);
  let top = peak, bottom = trough;
  if (peak > 0 && trough < 0) { if (-trough > 3 * peak) bottom = -3 * peak; else if (peak > -trough * 3) top = -trough * 3; }
  const pad = Math.max(top - bottom, 1) * 0.12;
  const yMax = top + pad, yMin = bottom - pad;
  const money = (v: number) => (v < 0 ? "−" : "") + "₹" + (Math.abs(v) >= 1e5 ? `${(Math.abs(v) / 1e5).toFixed(1)}L` : Math.abs(v) >= 1e3 ? `${(Math.abs(v) / 1e3).toFixed(Math.abs(v) >= 1e4 ? 0 : 1)}K` : `${Math.round(Math.abs(v))}`);
  const mk = (xAxis: number, name: string, color: string, text: string, type: "dashed" | "dotted", where: "top" | "bottom" | "mid", width = 1.2) => ({
    xAxis, name, lineStyle: { color, type, width },
    label: { formatter: text, color, fontSize: 10, rotate: where === "top" ? 0 : 90, position: where === "top" ? "end" : where === "bottom" ? "insideEndTop" : "insideStartBottom",
      backgroundColor: where === "top" ? c.slate : undefined, padding: [1, 3], borderRadius: 2 },
  });
  const marks = [
    { yAxis: 0, lineStyle: { color: c.muted, type: "solid", width: 1 }, label: { show: false } },
    { ...mk(p.spot, "Spot", c.brass, `Current price: ${fmtPrice(p.spot)}`, "dashed", "top", 1.6), label: { formatter: `Current price: ${fmtPrice(p.spot)}`, color: c.paper, fontSize: 11, position: "end", distance: 6, backgroundColor: c.slate, borderColor: c.rule, borderWidth: 1, padding: [3, 6], borderRadius: 3 } },
    ...p.breakevens.map((b) => mk(b, "BE", c.info, `BE ${fmtInt(Math.round(b))}`, "dotted", "bottom")),
    ...(p.bands ? ([["−2σ", p.bands.m2], ["−1σ", p.bands.m1], ["+1σ", p.bands.p1], ["+2σ", p.bands.p2]] as [string, number][]).map(([t, x]) => ({
      ...mk(x, "SD", c.muted, t, "dotted", "mid"), label: { show: true, formatter: t.replace("σ", "SD"), color: c.muted, fontSize: 11, position: "end", distance: 6 } })) : []),
    ...(p.levels ?? []).map((l) => mk(l.s, l.kind, l.kind === "target" ? c.up : l.kind === "stop" ? c.down : c.info, `${l.kind === "target" ? "Target" : l.kind === "stop" ? "Stop" : "What-if"} ${l.label} ${fmtInt(Math.round(l.s))}`.replace("  ", " "), "dashed", "bottom", 1.4)),
  ];
  const areas = p.bands ? [
    [{ xAxis: p.bands.m2, itemStyle: { color: c.brass, opacity: 0.05 } }, { xAxis: p.bands.p2 }],
    [{ xAxis: p.bands.m1, itemStyle: { color: c.info, opacity: 0.08 } }, { xAxis: p.bands.p1 }],
  ] : [];
  const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
  const maxOi = Math.max(1, ...(p.oi ?? []).filter((o) => !view || (o.strike >= view.lo && o.strike <= view.hi)).map((o) => Math.max(Math.abs(o.call ?? 0), Math.abs(o.put ?? 0))));
  // the right axis shares its zero with the P&L axis, so open interest stands on the zero line and change in OI can go below it
  const oiTop = maxOi * 1.35, oiBottom = yMax > 0 ? (yMin / yMax) * oiTop : -oiTop;
  const oiAt = (x: number) => { const o = (p.oi ?? []).reduce<{ strike: number; call: number | null; put: number | null } | null>((b, r) => (b == null || Math.abs(r.strike - x) < Math.abs(b.strike - x) ? r : b), null); return o && Math.abs(o.strike - x) <= 25 ? o : null; };
  const xs = pts.map((x) => x.s);
  return {
    animation: false,
    grid: compact ? { left: 50, right: 12, top: 40, bottom: 26 } : { left: 62, right: 58, top: 44, bottom: 30 },
    tooltip: { trigger: "axis", axisPointer: { type: "cross", lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } },
      backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const x = (params as { axisValue: number }[])[0]!.axisValue;
        const est = p.target ? `<br/><span style="color:${c.info}">${p.targetLabel}</span>: ${signed(lerp(p.target, x))}` : "";
        const oiRow = oiAt(x), oiTxt = oiRow ? `<br/>${p.oiMode === "change" ? "OI change" : "OI"} at ${fmtInt(oiRow.strike)}: <span style="color:${c.up}">Call ${oiRow.call == null ? "—" : compactIN(oiRow.call)}</span> · <span style="color:${c.down}">Put ${oiRow.put == null ? "—" : compactIN(oiRow.put)}</span>` : "";
        const sd = p.bands ? (x >= p.bands.m1 && x <= p.bands.p1 ? "<br/>inside ±1σ (about 68%, model)" : x >= p.bands.m2 && x <= p.bands.p2 ? "<br/>inside ±2σ (about 95%, model)" : "<br/>outside ±2σ (model)") : "";
        return `<b>NIFTY ${fmtInt(Math.round(x))}</b> (${(((x / p.spot) - 1) * 100).toFixed(2)}%)<br/>At expiry: <b>${signed(lerp(pts, x))}</b>${est}${sd}${oiTxt}`;
      } },
    xAxis: { type: "value", min: view?.lo ?? Math.min(...xs), max: view?.hi ?? Math.max(...xs), axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(Math.round(v)), hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: [
      { type: "value", min: yMin, max: yMax, splitNumber: 4, axisLabel: { ...axisText(c), formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.35 } } },
      { type: "value", show: !compact, min: oiBottom, max: oiTop, position: "right", splitLine: { show: false }, axisLabel: { ...axisText(c), formatter: (v: number) => (v === 0 ? "0" : v < 0 ? (p.oiMode === "change" ? "−" + compactIN(Math.abs(v)) : "") : compactIN(v)) }, name: p.oiMode === "change" ? "Change in OI" : "Open interest", nameLocation: "middle", nameGap: 42, nameTextStyle: { color: c.muted, fontSize: 10 } },
    ],
    series: [
      ...(p.oi ? [
        { name: "Call OI", type: "bar", yAxisIndex: 1, barWidth: 5, barGap: "0%", silent: true, tooltip: { show: false }, itemStyle: { color: c.up, opacity: 0.4 }, z: 0, data: p.oi.map((o) => [o.strike, o.call]) },
        { name: "Put OI", type: "bar", yAxisIndex: 1, barWidth: 5, barGap: "0%", silent: true, tooltip: { show: false }, itemStyle: { color: c.down, opacity: 0.4 }, z: 0, data: p.oi.map((o) => [o.strike, o.put]) },
      ] : []),
      line("Profit", c.up, (v) => v >= 0),
      line("Loss", c.down, (v) => v <= 0),
      ...(p.target ? [{ name: p.targetLabel, type: "line", showSymbol: false, itemStyle: { color: c.info }, lineStyle: { color: c.info, width: 2.6 }, z: 4, connectNulls: false, data: p.target.map((x) => [x.s, x.pnl]) }] : []),
      { name: "Markers", type: "line", silent: true, showSymbol: false, data: [],
        markArea: areas.length ? { silent: true, data: areas } : undefined,
        markLine: { symbol: "none", silent: true, animation: false, data: marks } },
    ],
  };
}

/** Implied-volatility smile: out-of-the-money puts (left) and calls (right) against strike, from the stored prices. */
export function ivSmileOption(rows: { strike: number; side: string; iv: number | null }[], atm: number | null, c: ChartColors): EChartsCoreOption {
  const pts = (side: string) => rows.filter((r) => r.side === side && r.iv != null).sort((a, b) => a.strike - b.strike).map((r) => [r.strike, r.iv as number]);
  const ser = (name: string, side: string, color: string) => ({ name, type: "line", showSymbol: true, symbolSize: 5, itemStyle: { color }, lineStyle: { color, width: 2 }, data: pts(side),
    ...(side === "CE" && atm != null ? { markLine: { silent: true, symbol: "none", lineStyle: { color: c.brass, type: "dashed" }, label: { formatter: `ATM ${atm}`, color: c.brass, fontSize: 10 }, data: [{ xAxis: atm }] } } : {}) });
  return {
    animation: false, grid: { left: 44, right: 12, top: 18, bottom: 26 },
    tooltip: { trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => `${Number(v).toFixed(2)}%` },
    xAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(Math.round(v)) }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    series: [ser("Puts", "PE", c.down), ser("Calls", "CE", c.up)],
  };
}

/** Diverging horizontal bars, largest first: sector returns, global moves. */
export function divergingBarOption(rows: { name: string; value: number }[], c: ChartColors, unit = "%"): EChartsCoreOption {
  const sorted = [...rows].sort((a, b) => a.value - b.value); // category axis draws bottom-up
  // Room beyond the longest bars on both sides, so the value label never runs into the names or off the chart.
  const lo = Math.min(0, ...rows.map((r) => r.value)), hi = Math.max(0, ...rows.map((r) => r.value));
  const pad = (hi - lo || 1) * 0.24;
  return {
    animation: false, grid: { left: 168, right: 12, top: 6, bottom: 6, containLabel: false },
    tooltip: { trigger: "item", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: unknown) => { const q = p as { name: string; value: number }; return `${q.name}: ${q.value >= 0 ? "+" : "−"}${Math.abs(q.value).toFixed(2)}${unit}`; } },
    xAxis: { type: "value", show: false, min: lo < 0 ? lo - pad : 0, max: hi > 0 ? hi + pad : 0 },
    yAxis: { type: "category", data: sorted.map((r) => r.name), axisLine: { show: false, onZero: false }, axisTick: { show: false }, axisLabel: { color: c.paper, fontSize: 11, width: 156, overflow: "truncate" } },
    series: [{ type: "bar", barMaxWidth: 14, data: sorted.map((r) => ({ value: r.value, itemStyle: { color: r.value >= 0 ? c.up : c.down, borderRadius: r.value >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] }, label: { position: r.value >= 0 ? "right" : "left" } })),
      label: { show: true, position: "right", color: c.muted, fontSize: 10, formatter: (p: unknown) => { const v = (p as { value: number }).value; return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}${unit}`; } } }],
  };
}

/**
 * Keep a time-series chart inside the trading session: points taken outside 09:15 to the close (overnight, weekends)
 * are dropped, a gap is left between days instead of a line across the night, and for the Session range the axis is
 * fixed to that session. Works on any series whose data are [timeMs, value] pairs; other series are untouched.
 */
/**
 * Right edge of a session chart: the session close once the day is done, but while it is still running only a
 * little past the newest sample, so a morning's data fills the chart instead of hugging the left edge.
 */
function fitMax(bounds: { min: number; max: number }, series: { data?: unknown }[]): number {
  let last = -Infinity;
  for (const s of series) {
    if (!Array.isArray(s.data)) continue;
    for (const d of s.data as unknown[]) if (Array.isArray(d) && typeof d[0] === "number" && d[1] != null && d[0] > last) last = d[0];
  }
  if (!Number.isFinite(last) || last >= bounds.max) return bounds.max;
  return Math.min(bounds.max, last + Math.max(10 * 60_000, (last - bounds.min) * 0.1));
}

export function sessionize(option: EChartsCoreOption, bounds: { min: number; max: number } | null): EChartsCoreOption {
  const o = option as { series?: { data?: unknown }[]; xAxis?: Record<string, unknown> };
  if (!Array.isArray(o.series)) return option;
  const clip = (data: unknown): unknown => {
    if (!Array.isArray(data) || !data.every((d) => Array.isArray(d) && typeof d[0] === "number")) return data;
    const out: unknown[] = [];
    let lastDay: string | null = null;
    for (const d of data as [number, unknown][]) {
      if (!isSessionMs(d[0])) continue;
      const day = new Date(d[0] + 330 * 60_000).toISOString().slice(0, 10);
      if (lastDay != null && day !== lastDay) out.push([d[0] - 1, null]);
      lastDay = day;
      out.push(d);
    }
    return out;
  };
  const clipped = o.series.map((s) => ({ ...s, data: clip(s.data) }));
  // A labelled divider at the first sample of every later day, so a multi-day range reads as separate sessions.
  const firsts = new Map<string, number>();
  for (const d of (clipped[0]?.data as [number, unknown][] | undefined) ?? []) {
    if (!Array.isArray(d) || typeof d[0] !== "number" || d[1] == null) continue;
    const day = new Date(d[0] + 330 * 60_000).toISOString().slice(0, 10);
    if (!firsts.has(day)) firsts.set(day, d[0]);
  }
  const dividers = [...firsts.entries()].slice(1).map(([day, x]) => ({
    xAxis: x, label: { show: true, formatter: day.slice(8) + "/" + day.slice(5, 7), color: "#8a8f98", fontSize: 10, position: "insideStartTop" },
  }));
  if (dividers.length && clipped[0]) {
    const own = (clipped[0] as { markLine?: { data?: unknown[] } }).markLine;
    (clipped[0] as Record<string, unknown>).markLine = {
      symbol: "none", silent: true, lineStyle: { color: "#8a8f98", type: "dotted", opacity: 0.7 }, ...own,
      data: [...(own?.data ?? []), ...dividers],
    };
  }
  return {
    ...(option as object),
    ...(bounds && o.xAxis ? { xAxis: { ...o.xAxis, min: bounds.min, max: fitMax(bounds, clipped) } } : {}),
    series: clipped,
  } as EChartsCoreOption;
}

/** Grouped bars per session (oldest first): FII and DII net flows, participant positions. Missing values are gaps, not zeros. */
export function groupedBarsOption(categories: string[], series: { name: string; color: string; values: (number | null)[] }[], c: ChartColors, fmt: (v: number) => string = (v) => v.toLocaleString("en-IN")): EChartsCoreOption {
  return {
    animation: false, grid: { left: 62, right: 12, top: 30, bottom: 26 },
    legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (v == null ? "—" : fmt(Number(v))) },
    xAxis: { type: "category", data: categories, axisLabel: { ...axisText(c), formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    series: series.map((s) => ({ name: s.name, type: "bar", barMaxWidth: 18, itemStyle: { color: s.color, borderRadius: 2 }, data: s.values })),
  };
}

// ----------------------------------------------------------------- Smart OI
const upTxt = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${compactIN(Math.abs(v))}`);

/** Spot candles (top), Smart OI zero-baseline candles (middle) and option volume per candle (bottom) on one shared time axis. */
export function smartOiOption(r: SmartOiResult, c: ChartColors): EChartsCoreOption {
  const cs = r.candles;
  const labels = cs.map((x) => x.label);
  const axis = (i: number, show: boolean) => ({
    type: "category", gridIndex: i, data: labels, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: c.rule } }, axisLabel: { show, ...axisText(c), hideOverlap: true, showMaxLabel: true }, splitLine: { show: false },
    axisPointer: { show: true, label: { show: show, backgroundColor: c.paper, color: c.slate } },
  });
  const val = (i: number, extra: object = {}) => ({
    type: "value", gridIndex: i, scale: true, splitNumber: 3, axisLabel: axisText(c),
    splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } }, axisLine: { show: false }, ...extra,
  });
  return {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: c.muted, type: "dashed" } },
    tooltip: {
      trigger: "axis", confine: true, axisPointer: { type: "cross" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? -1;
        const k = cs[i];
        if (!k) return "";
        const sp = k.spot ? `O ${fmtPrice(k.spot.open)} H ${fmtPrice(k.spot.high)} L ${fmtPrice(k.spot.low)} C ${fmtPrice(k.spot.close)}` : "—";
        return `<b>${k.label}</b> (${r.timeframe} min)<br/>NIFTY ${sp}<br/>Call OI ${fmtInt(k.ceOi)} · Put OI ${fmtInt(k.peOi)}<br/>` +
          (k.p == null ? "Baseline candle: no change yet" :
            `ΔPut ${upTxt(k.dPe)} · ΔCall ${upTxt(k.dCe)}<br/><b>Smart OI ${upTxt(k.p)}</b> ${k.p >= 0 ? "(puts added faster)" : "(calls added faster)"}` +
            (k.span > 1 ? `<br/>spans ${k.span} candles: samples missing in between` : "") +
            (k.strikesChanged ? "<br/>⚠ the number of strikes behind the totals changed, so this bar is not like for like" : ""));
      },
    },
    // panel titles sit inside the top-left of each panel so the three charts read without a legend
    title: [
      { text: cs.length > 0 && cs.every((k) => k.spotFromBars || !k.spot) ? "NIFTY (1-minute bars from the live index feed)" : cs.some((k) => k.spotFromBars) ? "NIFTY (1-minute index bars where recorded, stored samples before)" : "NIFTY (from stored 1-min samples: no real highs and lows)", left: 66, top: "1%", textStyle: { color: c.muted, fontSize: 11, fontWeight: "normal" } },
      { text: "Smart OI = ΔPut − ΔCall per candle", left: 66, top: "51%", textStyle: { color: c.muted, fontSize: 11, fontWeight: "normal" } },
      { text: "Option volume per candle (put green, call red)", left: 66, top: "76%", textStyle: { color: c.muted, fontSize: 11, fontWeight: "normal" } },
    ],
    grid: [
      { left: 60, right: 12, top: "5%", height: "42%" },
      { left: 60, right: 12, top: "55%", height: "17%" },
      { left: 60, right: 12, top: "80%", height: "11%" },
    ],
    xAxis: [axis(0, false), axis(1, false), axis(2, true)],
    yAxis: [
      val(0, { axisLabel: { ...axisText(c), formatter: (v: number) => v.toLocaleString("en-IN") } }),
      val(1, { scale: false, axisLabel: { ...axisText(c), formatter: (v: number) => upTxt(v) } }),
      val(2, { scale: false, splitNumber: 2, axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) } }),
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none" }],
    series: [
      {
        name: "NIFTY", type: "candlestick", xAxisIndex: 0, yAxisIndex: 0,
        data: cs.map((k) => (k.spot ? [k.spot.open, k.spot.close, k.spot.low, k.spot.high] : "-")),
        itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down },
      },
      {
        name: "Smart OI", type: "candlestick", xAxisIndex: 1, yAxisIndex: 1,
        // open is always 0: the bar starts on the zero line and ends at ΔPE − ΔCE; the baseline candle has no bar.
        data: cs.map((k) => (k.p == null ? "-" : [0, k.p, Math.min(0, k.p), Math.max(0, k.p)])),
        itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down },
        markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, width: 1 }, data: [{ yAxis: 0 }] },
      },
      { name: "Put volume", type: "bar", stack: "v", xAxisIndex: 2, yAxisIndex: 2, data: cs.map((k) => k.peVolDelta), itemStyle: { color: c.up, opacity: 0.7 } },
      { name: "Call volume", type: "bar", stack: "v", xAxisIndex: 2, yAxisIndex: 2, data: cs.map((k) => k.ceVolDelta), itemStyle: { color: c.down, opacity: 0.7 } },
    ],
  };
}

/** Day change lines (put, call, put − call since the first candle) and the two ratios, as two small charts. */
export function smartOiDayOption(r: SmartOiResult, c: ChartColors): EChartsCoreOption {
  const cs = r.candles;
  const line = (name: string, color: string, data: (number | null)[]) => ({ name, type: "line", data, showSymbol: false, lineStyle: { width: 1.8, color }, itemStyle: { color } });
  return {
    animation: false, grid: { left: 58, right: 14, top: 30, bottom: 24 },
    legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "line", lineStyle: { color: c.muted, type: "dashed" }, label: { show: true, backgroundColor: c.paper, color: c.slate } }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (typeof v === "number" ? upTxt(v) : "—") },
    xAxis: { type: "category", data: cs.map((k) => k.label), axisLabel: { ...axisText(c), hideOverlap: true, showMaxLabel: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => upTxt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [line("Put OI day chg", c.up, cs.map((k) => k.peDay)), line("Call OI day chg", c.down, cs.map((k) => k.ceDay)), line("PE−CE day chg", c.info, cs.map((k) => k.diffDay))],
  };
}

export function smartOiRatioOption(r: SmartOiResult, c: ChartColors): EChartsCoreOption {
  const cs = r.candles;
  const line = (name: string, color: string, data: (number | null)[]) => ({ name, type: "line", data, showSymbol: false, lineStyle: { width: 1.8, color }, itemStyle: { color } });
  return {
    animation: false, grid: { left: 46, right: 14, top: 30, bottom: 24 },
    legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "line", lineStyle: { color: c.muted, type: "dashed" }, label: { show: true, backgroundColor: c.paper, color: c.slate } }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (typeof v === "number" ? v.toFixed(3) : "—") },
    xAxis: { type: "category", data: cs.map((k) => k.label), axisLabel: { ...axisText(c), hideOverlap: true, showMaxLabel: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => v.toFixed(2) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [line("OI PCR", c.info, cs.map((k) => k.pcr)), line("Volume PCR", c.brass, cs.map((k) => k.volPcr))],
  };
}


const volTxt = (v: unknown) => (typeof v === "number" ? `${v < 0 ? "−" : ""}${compactIN(Math.abs(v))}` : "—");

/** Cumulative put and call volume traded today, one line each (units, the same strikes in every candle). */
export function smartOiVolumeOption(r: SmartOiResult, c: ChartColors): EChartsCoreOption {
  const cs = r.candles;
  const line = (name: string, color: string, data: (number | null)[]) => ({ name, type: "line", data, showSymbol: false, lineStyle: { width: 1.8, color }, itemStyle: { color } });
  return {
    animation: false, grid: { left: 58, right: 14, top: 30, bottom: 24 },
    legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "line", lineStyle: { color: c.muted, type: "dashed" }, label: { show: true, backgroundColor: c.paper, color: c.slate } }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: volTxt },
    xAxis: { type: "category", data: cs.map((k) => k.label), axisLabel: { ...axisText(c), hideOverlap: true, showMaxLabel: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [line("Put volume (day)", c.up, cs.map((k) => k.peVol)), line("Call volume (day)", c.down, cs.map((k) => k.ceVol))],
  };
}

/** Put minus call: cumulative volume today (line) and the change in each candle (bars; green = puts traded more). */
export function smartOiDiffOption(r: SmartOiResult, c: ChartColors): EChartsCoreOption {
  const cs = r.candles;
  const cum = cs.map((k) => (k.peVol != null && k.ceVol != null ? k.peVol - k.ceVol : null));
  const per = cs.map((k) => (k.peVolDelta != null && k.ceVolDelta != null ? k.peVolDelta - k.ceVolDelta : null));
  return {
    animation: false, grid: { left: 58, right: 58, top: 30, bottom: 24 },
    legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "line", lineStyle: { color: c.muted, type: "dashed" }, label: { show: true, backgroundColor: c.paper, color: c.slate } }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: volTxt },
    xAxis: { type: "category", data: cs.map((k) => k.label), axisLabel: { ...axisText(c), hideOverlap: true, showMaxLabel: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: [
      { type: "value", scale: true, axisLabel: { ...axisText(c), formatter: (v: number) => volTxt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
      { type: "value", scale: true, position: "right", axisLabel: { ...axisText(c), formatter: (v: number) => volTxt(v) }, splitLine: { show: false } },
    ],
    series: [
      { name: "PE − CE per candle", type: "bar", yAxisIndex: 1, data: per.map((v) => (v == null ? null : { value: v, itemStyle: { color: v >= 0 ? c.up : c.down, opacity: 0.55 } })) },
      { name: "PE − CE volume (day)", type: "line", data: cum, showSymbol: false, lineStyle: { width: 1.8, color: c.info }, itemStyle: { color: c.info }, markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, width: 1 }, data: [{ yAxis: 0 }] } },
    ],
  };
}
