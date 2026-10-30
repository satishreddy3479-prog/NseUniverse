// Pure builders for ECharts options. They contain all plotting decisions so tests can assert exactly
// what each chart shows. Missing values become gaps (null), never zero.
import type { EChartsCoreOption } from "echarts/core";
import { compactIN, isSessionMs, type Totals } from "./analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice, fmtTimeIST } from "./format";
import type { IntradayScoreRow, Observation, OiChange, OiHeatmap, OiSeries, OptionChainRow, PremiumDecay } from "./types";

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

function timeAxis(c: ChartColors) {
  return { type: "time", axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: false } };
}

function tsBase(c: ChartColors, valueFormatter: (v: number) => string) {
  return {
    animation: false,
    grid: { left: 58, right: 16, top: 34, bottom: 44 },
    legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      axisPointer: { type: "cross", label: { backgroundColor: c.slate } },
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
  const line = (name: string, color: string, pick: (o: Observation) => number | null) => ({
    name, type: "line", showSymbol: obs.length <= 80, symbolSize: 6, itemStyle: { color }, lineStyle: { color, width: 2 },
    data: obs.map((o) => [t(o), pick(o)]),
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
    name, type: "line", showSymbol: times.length <= 80, symbolSize: 5, itemStyle: { color }, lineStyle: { color, width: 1.5 },
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
      name: "NIFTY 50 at snapshot", type: "line", showSymbol: obs.length <= 80, symbolSize: 7, itemStyle: { color: c.info }, lineStyle: { color: c.info, width: 2 },
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
      name: "ATM straddle", type: "line", showSymbol: obs.length <= 80, symbolSize: 6, itemStyle: { color: c.brass }, lineStyle: { color: c.brass, width: 2 },
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
  const x = rows.map((r) => fmtTimeIST(r.sample_utc));
  return {
    animation: false,
    grid: { left: 40, right: 56, top: 28, bottom: 24 },
    legend: { top: 0, textStyle: axisText(c), data: ["Sentiment score", "NIFTY (sampled)"] },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: x, axisLabel: axisText(c), axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [
      { type: "value", min: -1, max: 1, name: "score", nameTextStyle: axisText(c), axisLabel: axisText(c), splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      { type: "value", scale: true, name: "INR", nameTextStyle: axisText(c), axisLabel: { ...axisText(c), formatter: (v: number) => fmtPrice(v) }, splitLine: { show: false } },
    ],
    series: [
      { name: "Sentiment score", type: "line", data: rows.map((r) => r.score), connectNulls: false, showSymbol: false,
        lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass },
        markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } } },
      { name: "NIFTY (sampled)", type: "line", yAxisIndex: 1, data: rows.map((r) => r.spot), showSymbol: false,
        lineStyle: { color: c.info, width: 1 }, itemStyle: { color: c.info } },
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
    grid: compact ? { left: 44, right: 8, top: 16, bottom: 22 } : { left: 62, right: 14, top: 34, bottom: 56 },
    legend: compact ? { show: false } : { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
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

export type OiSeriesKind = "pcr" | "change" | "total";

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
      ? [line("Put-call ratio", c.info, res.pcr, 1)]
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
export function payoffOption(p: PayoffSeries, c: ChartColors): EChartsCoreOption {
  const pts = [...p.expiry, ...p.breakevens.map((b) => ({ s: b, pnl: 0 }))].sort((x, y) => x.s - y.s);
  const line = (label: string, color: string, keep: (v: number) => boolean) => ({
    name: label, type: "line", showSymbol: false, itemStyle: { color }, lineStyle: { width: 2.6, color }, z: 3,
    areaStyle: { color, opacity: 0.14 }, data: pts.map((x) => [x.s, keep(x.pnl) ? x.pnl : null]),
  });
  // y scale: fit the shape that matters. A side that runs off to a huge loss or profit is clipped at 3x the other
  // side, so the peak and the breakevens stay readable.
  const vals = pts.map((x) => x.pnl);
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
  const maxOi = Math.max(1, ...(p.oi ?? []).map((o) => Math.max(Math.abs(o.call ?? 0), Math.abs(o.put ?? 0))));
  // the right axis shares its zero with the P&L axis, so open interest stands on the zero line and change in OI can go below it
  const oiTop = maxOi * 1.35, oiBottom = yMax > 0 ? (yMin / yMax) * oiTop : -oiTop;
  const oiAt = (x: number) => { const o = (p.oi ?? []).reduce<{ strike: number; call: number | null; put: number | null } | null>((b, r) => (b == null || Math.abs(r.strike - x) < Math.abs(b.strike - x) ? r : b), null); return o && Math.abs(o.strike - x) <= 25 ? o : null; };
  const xs = pts.map((x) => x.s);
  return {
    animation: false,
    grid: { left: 62, right: 58, top: 44, bottom: 30 },
    tooltip: { trigger: "axis", axisPointer: { type: "cross", lineStyle: { color: c.muted, type: "dashed" }, label: { show: false } },
      backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 },
      formatter: (params: unknown) => {
        const x = (params as { axisValue: number }[])[0]!.axisValue;
        const est = p.target ? `<br/><span style="color:${c.info}">${p.targetLabel}</span>: ${signed(lerp(p.target, x))}` : "";
        const oiRow = oiAt(x), oiTxt = oiRow ? `<br/>${p.oiMode === "change" ? "OI change" : "OI"} at ${fmtInt(oiRow.strike)}: <span style="color:${c.up}">Call ${oiRow.call == null ? "—" : compactIN(oiRow.call)}</span> · <span style="color:${c.down}">Put ${oiRow.put == null ? "—" : compactIN(oiRow.put)}</span>` : "";
        const sd = p.bands ? (x >= p.bands.m1 && x <= p.bands.p1 ? "<br/>inside ±1σ (about 68%, model)" : x >= p.bands.m2 && x <= p.bands.p2 ? "<br/>inside ±2σ (about 95%, model)" : "<br/>outside ±2σ (model)") : "";
        return `<b>NIFTY ${fmtInt(Math.round(x))}</b> (${(((x / p.spot) - 1) * 100).toFixed(2)}%)<br/>At expiry: <b>${signed(lerp(pts, x))}</b>${est}${sd}${oiTxt}`;
      } },
    xAxis: { type: "value", min: Math.min(...xs), max: Math.max(...xs), axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(Math.round(v)), hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: [
      { type: "value", min: yMin, max: yMax, splitNumber: 4, axisLabel: { ...axisText(c), formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.35 } } },
      { type: "value", min: oiBottom, max: oiTop, position: "right", splitLine: { show: false }, axisLabel: { ...axisText(c), formatter: (v: number) => (v === 0 ? "0" : v < 0 ? (p.oiMode === "change" ? "−" + compactIN(Math.abs(v)) : "") : compactIN(v)) }, name: p.oiMode === "change" ? "Change in OI" : "Open interest", nameLocation: "middle", nameGap: 42, nameTextStyle: { color: c.muted, fontSize: 10 } },
    ],
    dataZoom: [{ type: "inside", filterMode: "none" }],
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
  return {
    animation: false, grid: { left: 130, right: 56, top: 6, bottom: 6, containLabel: false },
    tooltip: { trigger: "item", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: unknown) => { const q = p as { name: string; value: number }; return `${q.name}: ${q.value >= 0 ? "+" : "−"}${Math.abs(q.value).toFixed(2)}${unit}`; } },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", data: sorted.map((r) => r.name), axisLine: { show: false, onZero: false }, axisTick: { show: false }, axisLabel: { color: c.paper, fontSize: 11, width: 120, overflow: "truncate" } },
    series: [{ type: "bar", barMaxWidth: 14, data: sorted.map((r) => ({ value: r.value, itemStyle: { color: r.value >= 0 ? c.up : c.down, borderRadius: r.value >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] }, label: { position: r.value >= 0 ? "right" : "left" } })),
      label: { show: true, position: "right", color: c.muted, fontSize: 10, formatter: (p: unknown) => { const v = (p as { value: number }).value; return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}${unit}`; } } }],
  };
}

/**
 * Keep a time-series chart inside the trading session: points taken outside 09:15 to the close (overnight, weekends)
 * are dropped, a gap is left between days instead of a line across the night, and for the Session range the axis is
 * fixed to that session. Works on any series whose data are [timeMs, value] pairs; other series are untouched.
 */
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
  return {
    ...(option as object),
    ...(bounds && o.xAxis ? { xAxis: { ...o.xAxis, min: bounds.min, max: bounds.max } } : {}),
    series: o.series.map((s) => ({ ...s, data: clip(s.data) })),
  } as EChartsCoreOption;
}
