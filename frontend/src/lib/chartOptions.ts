// Pure builders for ECharts options. They contain all plotting decisions so tests can assert exactly
// what each chart shows. Missing values become gaps (null), never zero.
import type { EChartsCoreOption } from "echarts/core";
import { compactIN, type Totals } from "./analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice, fmtTimeIST } from "./format";
import type { Observation, OiChange, OiHeatmap, OptionChainRow } from "./types";

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
    name, type: "line", showSymbol: true, symbolSize: 6, itemStyle: { color }, lineStyle: { color, width: 2 },
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

/** Change in total premium relative to the first stored observation (the baseline). */
export function decaySeries(obs: Observation[]): { baselineAt: string | null; ce: (number | null)[]; pe: (number | null)[] } {
  const base = obs.find((o) => o.total_ce_premium != null && o.total_pe_premium != null);
  if (!base) return { baselineAt: null, ce: obs.map(() => null), pe: obs.map(() => null) };
  const d = (v: number | null, b: number | null) => (v == null || b == null ? null : v - b);
  return {
    baselineAt: base.retrieved_at,
    ce: obs.map((o) => d(o.total_ce_premium, base.total_ce_premium)),
    pe: obs.map((o) => d(o.total_pe_premium, base.total_pe_premium)),
  };
}

export function decayOption(obs: Observation[], c: ChartColors, showCalls = true, showPuts = true): EChartsCoreOption {
  const s = decaySeries(obs);
  const area = (name: string, color: string, vals: (number | null)[]) => ({
    name, type: "line", showSymbol: true, symbolSize: 5, itemStyle: { color }, lineStyle: { color, width: 1.5 },
    areaStyle: { color, opacity: 0.25 }, data: obs.map((o, i) => [t(o), vals[i]]),
    markLine: { symbol: "none", silent: true, lineStyle: { color: c.muted, type: "dashed" }, label: { show: false }, data: [{ yAxis: 0 }] },
  });
  return {
    ...tsBase(c, (v) => `${v >= 0 ? "+" : "−"}${fmtPrice(Math.abs(v))}`),
    yAxis: { type: "value", scale: true, minInterval: 1, axisLabel: { ...axisText(c), formatter: (v: number) => fmtInt(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      ...(showCalls ? [area("CE premium change", c.up, s.ce)] : []),
      ...(showPuts ? [area("PE premium change", c.down, s.pe)] : []),
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
      name: "NIFTY 50 at snapshot", type: "line", showSymbol: true, symbolSize: 7, itemStyle: { color: c.info }, lineStyle: { color: c.info, width: 2 },
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
      name: "ATM straddle", type: "line", showSymbol: true, symbolSize: 6, itemStyle: { color: c.brass }, lineStyle: { color: c.brass, width: 2 },
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
