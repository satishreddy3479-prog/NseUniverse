import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import type { EChartsCoreOption } from "echarts/core";
import { EChart, useChartColors } from "../components/EChart";
import { LayoutBar } from "../components/LayoutBar";
import { Loading } from "../components/Loading";
import { api } from "../lib/api";
import type { ChartColors } from "../lib/chartOptions";
import { gexLevels, gexProfile, regimeFor } from "../lib/gammaAnalysis";
import { hhmmIST } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { marketClockMs } from "../lib/session";
import { barSeries, candles, labelColor, line, multiPanelOption, regimeAreas, type PanelSpec } from "../lib/trendCharts";
import { TREND_VIEWS, type TrendViewId } from "../lib/trendViews";
import { BANDS, forwardCheck, fromIndexBars, regimeSeries, regimeSummary, SCALES, type RegimeLabel, type RegimeSeries } from "../lib/trendRegime";
import {
  atr, istMinute, openingRange, rangeUsed, runningMean, runningRange, runningStd, runningVwapBands, sessionTrend, structure, varianceRatio, type RBar,
} from "../lib/trendStats";
import type { DailyRegime, FuturesSeries } from "../lib/types";
import { useViewLayout } from "../lib/viewLayout";

const TFS = [1, 3, 5, 15] as const;
const SESSION_MIN = 375; // 09:15 to 15:30

const f = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const pts = (v: number, d = 0) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

const Stat = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div><div className="text-[11px] text-muted">{label}</div><div className={`num text-lg font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="max-w-[16rem] text-[11px] text-muted">{sub}</div>}</div>
);
const Note = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) => <p className={`text-[11px] ${tone === "warn" ? "text-warn" : "text-muted"}`}>{children}</p>;
const Card = ({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) => (
  <section className="rounded-sm border border-rule bg-slate p-3" data-testid={testid}><h2 className="mb-2 text-sm font-semibold text-paper">{title}</h2>{children}</section>
);
const Chart = ({ option, height, label }: { option: EChartsCoreOption; height: number; label: string }) => (
  <div className="w-full" style={{ height }}><EChart option={option} ariaLabel={label} className="h-full w-full" /></div>
);

/** Shown on every intraday view: what these figures are and are not. */
const DESCRIPTIVE = "Descriptive and not validated: these figures say how the session has behaved so far, they do not forecast it. Only the daily regime has a validation study on the stored history.";

interface Ctx {
  c: ChartColors; day: string | null; bars: RBar[]; tf: number; reg: RegimeSeries; fut: FuturesSeries | null; futSameDay: boolean;
  L: ReturnType<typeof useViewLayout>; newest: boolean;
}
const timeLabels = (bars: RBar[]) => bars.map((b) => hhmmIST(new Date(b.t).toISOString()));
const toneOf = (l: string) => (l.includes("up") || l.includes("Trending up") ? "text-up" : l.includes("down") ? "text-down" : "text-paper");

// ---- Market Regime

function ScoreGauge({ score }: { score: number | null }) {
  return (
    <div className="mt-1" data-testid="regime-gauge" aria-label={score == null ? "no trend score yet" : `trend score ${Math.round(score * 100)} of 100`}>
      <div className="relative flex h-3 w-full max-w-md overflow-hidden rounded-sm border border-rule">
        <div className="bg-info/40" style={{ width: `${BANDS.mixed * 100}%` }} /><div className="bg-muted/30" style={{ width: `${(BANDS.weak - BANDS.mixed) * 100}%` }} />
        <div className="bg-brass/25" style={{ width: `${(BANDS.trend - BANDS.weak) * 100}%` }} /><div className="bg-brass/60" style={{ width: `${(1 - BANDS.trend) * 100}%` }} />
        {score != null && <div className="absolute top-0 h-full w-[3px] bg-paper" style={{ left: `calc(${score * 100}% - 1px)` }} />}
      </div>
      <div className="flex max-w-md justify-between text-[10px] text-muted"><span>0 range-bound</span><span>30 mixed</span><span>45 weak</span><span>65 trending</span><span>100</span></div>
    </div>
  );
}

function MarketRegimeView({ ctx, stored }: { ctx: Ctx; stored: RegimeSeries[] }) {
  const { c, reg, bars } = ctx;
  const p = reg.points;
  const last = p[p.length - 1];
  const x = timeLabels(reg.bars);
  const closes = reg.bars.map((b) => b.c);
  const sum = regimeSummary(p);
  const st = sessionTrend(closes);
  const or = openingRange(bars, 15);
  const twap = runningMean(closes);
  const check = useMemo(() => {
    const r = stored.map((s) => forwardCheck(s));
    const merge = (k: "trending" | "weak" | "range" | "mixed") => {
      const n = r.reduce((a, v) => a + v[k].n, 0);
      return { n, mean: n ? r.reduce((a, v) => a + (v[k].meanForwardEr ?? 0) * v[k].n, 0) / n : null };
    };
    return { sessions: stored.length, rows: [["Trending", merge("trending")], ["Weak trend", merge("weak")], ["Range-bound", merge("range")], ["Mixed", merge("mixed")]] as const };
  }, [stored]);
  const chart = useMemo(() => {
    const panels: PanelSpec[] = [
      { title: `NIFTY ${reg.params.tf}-minute candles with the regime shaded, the session mean (dashed) and the opening range`, height: 300,
        series: [candles("NIFTY", reg.bars, c), line("Session mean", twap, c.brass, { lineStyle: { width: 1.4, color: c.brass, type: "dashed" } })],
        guides: or ? [{ y: or.high, label: "OR high" }, { y: or.low, label: "OR low" }] : [] },
      { title: "Trend score (0-100): the mean of the four readings' ramps", height: 110, y: { min: 0, max: 100, scale: false, fmt: (v) => String(Math.round(v)) },
        series: [line("Trend score", p.map((q) => (q.score == null ? null : +(q.score * 100).toFixed(1))), c.paper)],
        zones: [{ from: 0, to: BANDS.mixed * 100, color: c.info, opacity: 0.12 }, { from: BANDS.trend * 100, to: 100, color: c.brass, opacity: 0.14, label: "trending" }],
        guides: [BANDS.mixed, BANDS.weak, BANDS.trend].map((v) => ({ y: v * 100 })) },
      { title: "ADX (strength) with +DI and −DI (direction)", height: 110, y: { min: 0 },
        series: [line("ADX", p.map((q) => q.metrics.adx), c.paper), line("+DI", p.map((q) => q.metrics.plusDi), c.up), line("−DI", p.map((q) => q.metrics.minusDi), c.down)] },
    ];
    return multiPanelOption(c, x, panels, regimeAreas(p.map((q) => q.label), x, c));
  }, [c, reg, p, x, twap, or]);
  if (!last) return <Note>No bars for this day yet.</Note>;
  const lbl = last.label;
  const readings: [string, string, number | null, string][] = [
    ["Efficiency ratio", f(last.metrics.er), last.scores.er, `0 at ${SCALES.er[0]} · full at ${SCALES.er[1]}`],
    ["ADX", f(last.metrics.adx, 1), last.scores.adx, `0 at ${SCALES.adx[0]} · full at ${SCALES.adx[1]}`],
    ["R² of a straight line", f(last.metrics.r2), last.scores.r2, `0 at ${SCALES.r2[0]} · full at ${SCALES.r2[1]}`],
    ["Choppiness index", f(last.metrics.chop, 1), last.scores.chop, `0 at ${SCALES.chop[0]} · full at ${SCALES.chop[1]} (low = trending)`],
  ];
  const total = p.length || 1;
  const order: RegimeLabel[] = ["Trending up", "Trending down", "Weak uptrend", "Weak downtrend", "Range-bound", "Mixed", "Warming up"];
  return (
    <div className="flex flex-col gap-3">
      <Card title="Now" testid="regime-now">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div><div className="text-[11px] text-muted">Regime ({reg.params.tf}-minute bars)</div>
            <div className={`text-2xl font-semibold ${toneOf(lbl)}`} data-testid="regime-label">{lbl}</div>
            {lbl !== last.raw && <div className="text-[11px] text-muted">this bar alone reads {last.raw}; a new label must hold {reg.params.minDwell} bars</div>}</div>
          <div><div className="text-[11px] text-muted">Trend score</div><div className="num text-2xl font-semibold text-paper">{last.score == null ? "—" : Math.round(last.score * 100)}<span className="text-sm text-muted"> / 100</span></div><ScoreGauge score={last.score} /></div>
          <Stat label="Agreement" value={last.agreement ? `${last.agreement.agree} of ${last.agreement.of}` : "—"} sub={last.agreement ? "readings on the label's side of the midpoint (a count, not a probability)" : "no label side: the readings are mixed or not ready"} />
          <Stat label="Label changes today" value={String(sum.changes)} sub="many changes = no clear regime" />
        </div>
        {st && (
          <p className="mt-3 text-sm text-paper" data-testid="regime-session">
            Session so far: <b className={st.net < 0 ? "text-down" : "text-up"}>{pts(st.net, 1)} points</b> from the first bar's close; the day's efficiency ratio is <b>{f(st.er)}</b> ({st.er != null && st.er >= 0.3 ? "mostly one-directional" : "a lot of back and forth"}; 1 = a straight line).
          </p>
        )}
        <table className="num mt-3 w-full max-w-2xl text-xs" data-testid="regime-readings"><thead><tr className="text-left text-muted"><th>Reading</th><th className="text-right">Value</th><th className="pl-3">Trend score</th><th className="pl-3">Scale</th></tr></thead>
          <tbody>{readings.map(([n, v, s, scale]) => (
            <tr key={n} className="border-t border-rule/50"><td className="py-1">{n}</td><td className="text-right">{v}</td>
              <td className="pl-3"><div className="h-2 w-24 rounded-sm bg-rule/40"><div className="h-2 rounded-sm" style={{ width: `${(s ?? 0) * 100}%`, background: labelColor(c, "Trending up") }} /></div></td><td className="pl-3 text-muted">{scale}</td></tr>))}</tbody></table>
        <Note>{DESCRIPTIVE} Each reading is a ramp between a "no trend" and a "full trend" level (conventional values, none fitted to data), averaged; the label has a 0.05 margin at each boundary and needs {reg.params.minDwell} bars to change. Look-back {last.window} bars, {bars.length} one-minute bars of the session.</Note>
      </Card>
      <Card title="The session on one time axis" testid="regime-chart">
        <Chart option={chart.option} height={chart.height} label="NIFTY candles, trend score and ADX on one time axis with the regime shaded" />
        <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
          {(["Trending up", "Trending down", "Weak uptrend", "Weak downtrend", "Range-bound", "Mixed"] as const).map((l) => <span key={l}><span className="mr-1 inline-block size-2 rounded-sm" style={{ background: labelColor(c, l), opacity: l.startsWith("Weak") || l === "Mixed" ? 0.5 : 1 }} />{l}</span>)}
        </div>
      </Card>
      <Card title="Time in each regime today" testid="regime-time">
        <div className="flex h-4 w-full overflow-hidden rounded-sm border border-rule" role="img" aria-label="Share of the session's bars in each regime">
          {order.map((l) => (sum.counts[l] ? <div key={l} title={`${l}: ${sum.counts[l]} bars`} style={{ width: `${((sum.counts[l] ?? 0) / total) * 100}%`, background: labelColor(c, l), opacity: l === "Warming up" ? 0.2 : l.startsWith("Weak") || l === "Mixed" ? 0.45 : 0.9 }} /> : null))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">{order.map((l) => <Stat key={l} label={l} value={`${sum.counts[l] ?? 0} bars`} />)}</div>
      </Card>
      <Card title="What followed each label in the stored sessions" testid="regime-check">
        {check.sessions === 0 ? <Note>No stored sessions to check.</Note> : (
          <table className="num w-full text-xs"><thead><tr className="text-left text-muted"><th>Label</th><th className="text-right">Bars</th><th className="text-right">Mean efficiency ratio of the next 12 bars</th></tr></thead>
            <tbody>{check.rows.map(([n, v]) => <tr key={n} className="border-t border-rule/50"><td>{n}</td><td className="text-right">{v.n}</td><td className="text-right">{f(v.mean)}</td></tr>)}</tbody></table>
        )}
        <Note>Across {check.sessions} stored session{check.sessions === 1 ? "" : "s"} at {reg.params.tf}-minute bars. The windows overlap and the sample is a few days, so this is a look, not a test: no significance is claimed. The daily regime page has the full study.</Note>
      </Card>
    </div>
  );
}

// ---- Trend strength, choppiness, variance ratio

function TrendStrengthView({ ctx }: { ctx: Ctx }) {
  const { c, reg } = ctx;
  const p = reg.points;
  const x = timeLabels(reg.bars);
  const last = p[p.length - 1]?.metrics;
  const chart = useMemo(() => multiPanelOption(c, x, [
    { title: `Efficiency ratio of the last ${reg.params.window} bars (1 = a straight line)`, height: 130, y: { min: 0, max: 1, scale: false },
      series: [line("Efficiency ratio", p.map((q) => q.metrics.er), c.brass)], zones: [{ from: SCALES.er[1], to: 1, color: c.brass, opacity: 0.12, label: "trend" }, { from: 0, to: SCALES.er[0], color: c.info, opacity: 0.1, label: "no trend" }], guides: [{ y: SCALES.er[0] }, { y: SCALES.er[1] }] },
    { title: `ADX (Wilder ${reg.params.adxN}) with +DI and −DI`, height: 130, y: { min: 0 },
      series: [line("ADX", p.map((q) => q.metrics.adx), c.paper), line("+DI", p.map((q) => q.metrics.plusDi), c.up), line("−DI", p.map((q) => q.metrics.minusDi), c.down)],
      zones: [{ from: SCALES.adx[1], to: 100, color: c.brass, opacity: 0.1, label: "strong" }], guides: [{ y: SCALES.adx[0] }, { y: SCALES.adx[1] }] },
    { title: "R² of a straight-line fit", height: 130, y: { min: 0, max: 1, scale: false },
      series: [line("R²", p.map((q) => q.metrics.r2), c.info)], zones: [{ from: SCALES.r2[1], to: 1, color: c.brass, opacity: 0.12, label: "one clean line" }, { from: 0, to: SCALES.r2[0], color: c.info, opacity: 0.1 }], guides: [{ y: SCALES.r2[0] }, { y: SCALES.r2[1] }] },
    { title: "Slope of the fitted line (points per bar)", height: 100, series: [barSeries("Slope", p.map((q) => q.metrics.slope), (v) => (v >= 0 ? c.up : c.down))], guides: [{ y: 0 }] },
  ], regimeAreas(p.map((q) => q.label), x, c)), [c, reg, p, x]);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Trend strength through the session" testid="strength-chart"><Chart option={chart.option} height={chart.height} label="Efficiency ratio, ADX with directional lines, R squared and slope on one time axis" /></Card>
      <Card title="Now">
        <div className="flex flex-wrap gap-6"><Stat label="Efficiency ratio" value={f(last?.er)} /><Stat label="ADX" value={f(last?.adx, 1)} /><Stat label="+DI / −DI" value={`${f(last?.plusDi, 1)} / ${f(last?.minusDi, 1)}`} /><Stat label="R²" value={f(last?.r2)} /><Stat label="Slope" value={last?.slope == null ? "—" : `${pts(last.slope, 2)} pts/bar`} /></div>
        <Note>Dashed lines are the "no trend" and "full trend" levels of each ramp; the regime is shaded behind. {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

function ChopVarianceView({ ctx }: { ctx: Ctx }) {
  const { c, reg } = ctx;
  const p = reg.points;
  const x = timeLabels(reg.bars);
  const closes = reg.bars.map((b) => b.c);
  const qs = [2, 3, 4, 5, 6, 8, 10].map((q) => ({ q, v: varianceRatio(closes, q) }));
  const chop = useMemo(() => multiPanelOption(c, x, [
    { title: `Choppiness index of the last ${reg.params.window} bars (high = choppy, low = trending)`, height: 150, y: { min: 0, max: 100, scale: false },
      series: [line("Choppiness", p.map((q) => q.metrics.chop), c.brass)], zones: [{ from: SCALES.chop[0], to: 100, color: c.info, opacity: 0.12, label: "choppy" }, { from: 0, to: SCALES.chop[1], color: c.brass, opacity: 0.12, label: "trending" }], guides: [{ y: SCALES.chop[1] }, { y: SCALES.chop[0] }] },
  ], regimeAreas(p.map((q) => q.label), x, c)), [c, reg, p, x]);
  const vrOpt = useMemo(() => ({
    animation: false, grid: { left: 52, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: qs.map(({ q }) => `${q} bars`), axisLabel: { color: c.muted }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{ name: "Variance ratio", type: "bar", data: qs.map(({ v }) => (v == null ? null : { value: +v.vr.toFixed(3), itemStyle: { color: Math.abs(v.zRobust) >= 1.96 ? (v.vr > 1 ? c.up : c.down) : c.muted, opacity: 0.85 } })), markLine: { silent: true, symbol: "none", lineStyle: { color: c.paper, type: "dashed" }, label: { color: c.muted, formatter: "1 = random walk" }, data: [{ yAxis: 1 }] } }],
  }), [c, qs]);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Choppiness through the session"><Chart option={chop.option} height={chop.height} label="Choppiness index through the session with the regime shaded" /></Card>
      <Card title="Variance ratio of the session so far" testid="vr-table">
        <Chart option={vrOpt} height={190} label="Variance ratio by horizon; coloured bars are significant at 5 percent" />
        <table className="num mt-2 w-full text-xs"><thead><tr className="text-left text-muted"><th>Horizon (bars)</th><th className="text-right">VR</th><th className="text-right">z</th><th className="text-right">robust z*</th><th className="pl-3">Reading (by z*)</th></tr></thead>
          <tbody>{qs.map(({ q, v }) => (
            <tr key={q} className="border-t border-rule/50"><td>{q}</td><td className="text-right">{f(v?.vr)}</td><td className="text-right">{f(v?.z)}</td><td className="text-right">{f(v?.zRobust)}</td>
              <td className="pl-3">{v == null ? `needs ${3 * q + 1} bars` : !Number.isFinite(v.zRobust) || Math.abs(v.zRobust) < 1.96 ? "not distinguishable from a random walk" : v.vr > 1 ? "trending (returns persist)" : "mean reverting (returns reverse)"}</td></tr>
          ))}</tbody></table>
        <Note>Lo–MacKinlay variance ratio of the session's {reg.params.tf}-minute closes: above 1 means moves tend to continue, below 1 that they tend to reverse. Intraday returns do not have constant variance, so the reading uses the heteroskedasticity-robust z*; the plain z is shown for comparison and overstates significance when volatility clusters. Bars are coloured only when |z*| reaches 1.96 (5 %). A short session gives wide uncertainty. {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

// ---- Session structure

function SessionStructureView({ ctx }: { ctx: Ctx }) {
  const { c, reg, fut, futSameDay } = ctx;
  const closes = reg.bars.map((b) => b.c);
  const x = timeLabels(reg.bars);
  const twap = runningMean(closes);
  const sd = runningStd(closes);
  const vw = useMemo(() => (fut && futSameDay ? { t: fut.times.map((s) => Date.parse(s)), v: runningVwapBands(fut.future, fut.volume_per_min) } : null), [fut, futSameDay]);
  const basis = fut && vw ? (() => { const i = fut.future.length - 1; return fut.spot[i] != null && fut.future[i] != null ? fut.future[i]! - fut.spot[i]! : null; })() : null;
  const vwapAt = (t: number) => {
    if (!vw) return { vwap: null as number | null, sd: null as number | null };
    let r = { vwap: null as number | null, sd: null as number | null };
    for (let i = 0; i < vw.t.length && vw.t[i]! <= t; i++) r = vw.v[i]!;
    return r;
  };
  const vAt = reg.bars.map((b) => vwapAt(b.t + (reg.params.tf - 1) * 60_000));
  const vwap = vAt.map((v) => (v.vwap == null || basis == null ? null : v.vwap - basis));
  const atrs = reg.bars.map((_, i) => atr(reg.bars.slice(0, i + 1), 14));
  const dist = closes.map((v, i) => (atrs[i] ? (v - twap[i]!) / atrs[i]! : null));
  const sT = structure(closes, twap);
  const sV = structure(closes, vwap);
  const lastAtr = atrs[atrs.length - 1] ?? null;
  const chart = useMemo(() => multiPanelOption(c, x, [
    { title: "NIFTY close with its session mean, ±1σ band and the future's VWAP", height: 280,
      series: [line("NIFTY close", closes, c.paper), line("Session mean (TWAP)", twap, c.brass), line("TWAP +1σ", twap.map((m, i) => m + sd[i]!), c.brass, { lineStyle: { width: 1, color: c.brass, type: "dotted", opacity: 0.8 } }),
        line("TWAP −1σ", twap.map((m, i) => m - sd[i]!), c.brass, { lineStyle: { width: 1, color: c.brass, type: "dotted", opacity: 0.8 } }),
        ...(vw ? [line("Future VWAP (index level)", vwap, c.info, { lineStyle: { width: 1.6, color: c.info, type: "dashed" } })] : [])] },
    { title: "Distance from the session mean in ATRs (14 bars)", height: 110, series: [barSeries("Distance (ATR)", dist.map((v) => (v == null ? null : +v.toFixed(2))), (v) => (v >= 0 ? c.up : c.down))], guides: [{ y: 1 }, { y: -1 }, { y: 0 }] },
  ], null), [c, x, closes, twap, sd, vw, vwap, dist]);
  return (
    <div className="flex flex-col gap-3">
      <Card title="NIFTY against its session mean" testid="structure-chart"><Chart option={chart.option} height={chart.height} label="NIFTY close, session mean with bands, future VWAP and distance in ATRs" /></Card>
      <Card title="Structure" testid="structure-stats">
        <div className="flex flex-wrap gap-6">
          <Stat label="Close above the session mean" value={sT ? `${sT.pctAbove.toFixed(0)} % of bars` : "—"} />
          <Stat label="Crossings of the mean" value={sT ? String(sT.crossings) : "—"} sub="many = rotating around it" />
          <Stat label="Longest stay on one side" value={sT ? `${sT.longestRun} bars ${sT.runSide > 0 ? "above" : "below"}` : "—"} />
          <Stat label="Distance now" value={sT ? `${pts(sT.distance, 1)} pts` : "—"} sub={sT && lastAtr ? `${pts(sT.distance / lastAtr, 2)} × the 14-bar ATR` : "ATR needs 15 bars"} />
          {sV && <Stat label="Against future VWAP" value={`${sV.pctAbove.toFixed(0)} % above · ${sV.crossings} crossings`} sub={`${pts(sV.distance, 1)} pts now`} />}
        </div>
        <Note>The session mean is the average of the {reg.params.tf}-minute closes and the band is one standard deviation of those closes around it (an index has no traded volume). {vw ? "The future's VWAP is volume weighted from the future's own minute volume and shifted to index level by the latest basis (future minus spot), so it approximates an index VWAP." : "Future VWAP is shown only for the newest session, when the future series is stored for that day."} {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

// ---- Opening range

function OpeningRangeView({ ctx }: { ctx: Ctx }) {
  const { c, reg, bars, L } = ctx;
  const [mins, setMins] = L.use("orMin", 15);
  const or = openingRange(bars, mins);
  const x = timeLabels(reg.bars);
  const out = reg.bars.map((b) => (!or || istMinute(b.t) - 555 < mins ? null : b.c > or.high ? +(b.c - or.high).toFixed(1) : b.c < or.low ? +(b.c - or.low).toFixed(1) : 0));
  const chart = useMemo(() => (or ? multiPanelOption(c, x, [
    { title: `NIFTY ${reg.params.tf}-minute candles with the first ${mins} minutes' range`, height: 280, series: [candles("NIFTY", reg.bars, c)],
      zones: [{ from: or.low, to: or.high, color: c.brass, opacity: 0.08, label: "opening range" }], guides: [{ y: or.high, label: "OR high" }, { y: or.low, label: "OR low" }] },
    { title: "Close beyond the range (points; zero = inside)", height: 110, series: [barSeries("Beyond the range", out, (v) => (v >= 0 ? c.up : c.down))], guides: [{ y: 0 }] },
  ], null) : null), [c, x, or, reg, mins, out]);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Opening range">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">Range length
          {[5, 15, 30].map((m) => <button key={m} type="button" onClick={() => setMins(m)} aria-pressed={mins === m} className={`min-h-8 rounded-sm border px-2 ${mins === m ? "border-brass text-paper" : "border-rule"}`}>{m} min</button>)}</div>
        {!or || !chart ? <Note>No bars yet.</Note> : (
          <>
            <Chart option={chart.option} height={chart.height} label="NIFTY candles with the opening range and the distance beyond it" />
            <div className="mt-2 flex flex-wrap gap-6" data-testid="or-stats">
              <Stat label="Range" value={`${or.low.toFixed(1)} – ${or.high.toFixed(1)}`} sub={`${(or.high - or.low).toFixed(1)} pts`} />
              <Stat label="Now" value={!or.ready ? "range still forming" : or.state === "inside" ? "inside" : `${or.state} the range`} tone={or.state === "above" ? "text-up" : or.state === "below" ? "text-down" : undefined} sub={or.extension ? `${pts(or.extension, 1)} pts beyond the edge` : undefined} />
              <Stat label="First break" value={or.firstBreak ? `${or.firstBreak.side} at ${hhmmIST(new Date(or.firstBreak.t).toISOString())}` : "none yet"} />
              <Stat label="Furthest excursion" value={`${or.maxExtension.toFixed(1)} pts`} sub="beyond either edge, by high or low" />
              <Stat label="Closes outside the range" value={String(or.barsOutside)} />
              <Stat label="Breakouts" value={String(or.breaks)} sub="inside to outside" />
              <Stat label="Failed breakouts" value={String(or.falseBreaks)} sub="closed back inside" />
            </div>
          </>
        )}
        <Note>The range is the high and low of the first {mins} minutes from 09:15; breaks are judged on {reg.params.tf}-minute closes. {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

// ---- Option-informed

function useChain(enabled: boolean) {
  const ex = useExpiries();
  const expiry = ex.data?.weekly ?? null;
  return useQuery({ queryKey: ["trend-chain", expiry], queryFn: () => api.optionChain(expiry!), enabled: enabled && !!expiry, refetchInterval: 15_000, retry: false });
}

function RangeUsedView({ ctx }: { ctx: Ctx }) {
  const chain = useChain(ctx.newest);
  const { c, bars, reg } = ctx;
  const snap = chain.data?.snapshot;
  const spot = bars.length ? bars[bars.length - 1]!.c : null;
  const prof = snap && spot != null ? gexProfile(snap.rows, snap.underlying_ltp ?? spot, snap.expiry, marketClockMs(Date.parse(snap.retrieved_at))) : null;
  const near = prof ? [...prof.rows].sort((a, b) => Math.abs(a.strike - prof.spot) - Math.abs(b.strike - prof.spot))[0] : undefined;
  const ivs = [near?.ceIv, near?.peIv].filter((v): v is number => v != null);
  const iv = ivs.length ? (100 * ivs.reduce((a, b) => a + b, 0)) / ivs.length : null;
  const sigma = iv == null || !prof ? null : (prof.spot * iv) / 100 / Math.sqrt(252);
  const x = timeLabels(reg.bars);
  const rr = runningRange(reg.bars);
  const expected = reg.bars.map((b) => (sigma == null ? null : 1.5958 * sigma * Math.sqrt(Math.min(1, Math.max(0.0001, (istMinute(b.t) + reg.params.tf - 555) / SESSION_MIN)))));
  const pace = rr.map((v, i) => (expected[i] ? +(v / expected[i]!).toFixed(3) : null));
  const chart = useMemo(() => (sigma == null ? null : multiPanelOption(c, x, [
    { title: "Range so far against the range a random walk with the option-implied volatility would have made by this time", height: 220,
      series: [line("Range so far (pts)", rr, c.paper), line("Expected range at this time (pts)", expected, c.brass, { lineStyle: { width: 1.5, color: c.brass, type: "dashed" } })] },
    { title: "Pace: range so far ÷ expected (1 = on the implied path)", height: 110, series: [line("Pace", pace, c.info)], guides: [{ y: 1 }], zones: [{ from: 1.25, to: 5, color: c.down, opacity: 0.08, label: "running hot" }, { from: 0, to: 0.75, color: c.info, opacity: 0.08, label: "quiet" }] },
  ], null)), [c, x, rr, expected, pace, sigma]);
  if (!ctx.newest) return <Note tone="warn">The implied move comes from today's live option chain, so this view is for the newest session only.</Note>;
  if (chain.isLoading) return <Loading label="Loading the option chain" />;
  if (!snap || !prof || bars.length === 0) return <Note tone="warn">Needs today's bars and the live option chain.</Note>;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  const used = rangeUsed(hi, lo, prof.spot, iv);
  return (
    <div className="flex flex-col gap-3">
      {chart && <Card title="Range used through the session" testid="range-chart"><Chart option={chart.option} height={chart.height} label="Range so far against the implied expected range, and the pace" /></Card>}
      <Card title="Range used against the implied move" testid="range-used">
        <div className="flex flex-wrap gap-6">
          <Stat label="Day's range so far" value={`${(hi - lo).toFixed(1)} pts`} sub={`${lo.toFixed(1)} – ${hi.toFixed(1)}`} />
          <Stat label="At-the-money IV" value={iv == null ? "—" : `${iv.toFixed(2)} %`} sub={`${snap.expiry}, strike ${near?.strike ?? "—"}`} />
          <Stat label="One-day move (1 σ)" value={sigma == null ? "—" : `${sigma.toFixed(1)} pts`} sub="spot × IV ÷ √252" />
          <Stat label="Range used" value={used == null ? "—" : `${(used * 100).toFixed(0)} %`} tone={used != null && used >= 1 ? "text-warn" : undefined} sub="range ÷ (1.5958 × 1 σ)" />
        </div>
        <Note>1.5958 = 2√(2/π) is the expected high-to-low range of a driftless random walk in units of its σ, so 100 % means a normal day's range is already used. The expected path scales with the square root of the time elapsed in the 375-minute session. The IV is the live at-the-money IV of the nearest weekly expiry now (not the open's), annualised on calendar time and applied per trading day on the 252-day basis: a stated approximation. A weekly expiry day's IV carries expiry-time effects. {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

function GammaRegimeView({ ctx }: { ctx: Ctx }) {
  const chain = useChain(ctx.newest);
  const { c } = ctx;
  const snap = chain.data?.snapshot;
  const prof = snap ? gexProfile(snap.rows, snap.underlying_ltp ?? 0, snap.expiry, marketClockMs(Date.parse(snap.retrieved_at))) : null;
  const lv = prof ? gexLevels(prof) : null;
  const rows = useMemo(() => (prof ? [...prof.rows].filter((r) => r.net != null).sort((a, b) => a.strike - b.strike).filter((r) => Math.abs(r.strike - prof.spot) <= 15 * 50) : []), [prof]);
  const nearest = (v: number) => rows.reduce<number | null>((b, r) => (b == null || Math.abs(r.strike - v) < Math.abs(b - v) ? r.strike : b), null);
  const opt = useMemo(() => (prof && lv && rows.length ? {
    animation: false, grid: { left: 56, right: 16, top: 30, bottom: 36 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: rows.map((r) => String(r.strike)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } }, name: "₹ crore / 1 %", nameTextStyle: { color: c.muted } },
    series: [{
      name: "Net GEX", type: "bar", data: rows.map((r) => ({ value: +(r.net ?? 0).toFixed(1), itemStyle: { color: (r.net ?? 0) >= 0 ? c.up : c.down, opacity: 0.85 } })),
      markLine: { silent: true, symbol: "none", lineStyle: { color: c.paper, type: "dashed" }, label: { color: c.paper, fontSize: 10 }, data: [{ xAxis: String(nearest(prof.spot)), name: "spot" }, ...(lv.flip != null ? [{ xAxis: String(nearest(lv.flip)), name: "flip" }] : [])] },
    }],
  } : null), [c, prof, lv, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx.newest) return <Note tone="warn">The gamma regime comes from today's live option chain, so this view is for the newest session only.</Note>;
  if (chain.isLoading) return <Loading label="Loading the option chain" />;
  if (!snap || !prof || !lv) return <Note tone="warn">The live option chain is not available.</Note>;
  const rg = regimeFor(lv);
  const dist = lv.flip != null ? ((lv.flip - lv.spot) / lv.spot) * 100 : null;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Gamma regime" testid="gamma-regime">
        <div className="flex flex-wrap gap-6">
          <Stat label="Regime" value={rg?.name ?? "—"} sub={rg?.volatility} />
          <Stat label="Net GEX" value={lv.netTotal == null ? "—" : `${lv.netTotal.toFixed(0)} ₹ crore / 1 %`} />
          <Stat label="Gamma flip" value={lv.flip == null ? "—" : lv.flip.toFixed(0)} sub={dist == null ? undefined : `${pts(dist, 2)} % (${pts(lv.flip! - lv.spot, 0)} pts) from spot`} />
          <Stat label="Call wall / put wall" value={`${lv.callWall ?? "—"} / ${lv.putWall ?? "—"}`} />
        </div>
        {rg && <p className="mt-2 text-xs text-paper">{rg.summary} {rg.expectation}</p>}
        <Note>From {snap.expiry}'s chain with Black-76 gamma and each contract's own IV. The sign is a convention (calls positive, puts negative), not an observed position, so this is a model reading. {DESCRIPTIVE}</Note>
      </Card>
      {opt && <Card title="Net GEX by strike (within 750 points of spot)" testid="gamma-chart"><Chart option={opt} height={240} label="Net gamma exposure by strike with spot and the gamma flip marked" /></Card>}
    </div>
  );
}

// ---- Daily regime

function DailyRegimeView({ c }: { c: ChartColors }) {
  const q = useQuery({ queryKey: ["regime-daily"], queryFn: api.intradayRegimeDaily, retry: false, staleTime: 300_000 });
  const d: DailyRegime | undefined = q.data;
  const s = d?.study;
  const ds = d?.series;
  const chart = useMemo(() => (ds ? multiPanelOption(c, ds.dates, [{ title: "NIFTY daily close with the daily regime shaded", height: 240, series: [line("NIFTY close", ds.close, c.paper)] }], regimeAreas(ds.label, ds.dates, c)) : null), [c, ds]);
  const groups = ["Trending up", "Trending down", "Range-bound", "Unclear"];
  const bars = useMemo(() => (s ? {
    animation: false, grid: { left: 52, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: groups.map((g) => `${g} (n=${s.groups[g]?.n ?? 0})`), axisLabel: { color: c.muted, interval: 0, fontSize: 10 }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", min: 0, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } }, name: "next-10-day efficiency ratio", nameTextStyle: { color: c.muted, fontSize: 10 } },
    series: [{ name: "Forward efficiency ratio", type: "bar", data: groups.map((g) => ({ value: s.groups[g]?.forward_er ?? null, itemStyle: { color: labelColor(c, g), opacity: 0.85 } })) }],
  } : null), [c, s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Loading label="Running the daily regime study on the stored history" />;
  if (q.isError || !d) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The daily regime could not be loaded.</p>;
  if (d.status !== "ok" || !s || !d.current || !ds) return <Note tone="warn">{d.status}</Note>;
  const ok = d.validated === true;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Daily regime now" testid="daily-now">
        <div className="flex flex-wrap gap-6">
          <Stat label={`As of ${d.as_of}`} value={d.current.label} />
          <Stat label="Efficiency ratio (20 d)" value={f(d.current.er)} /><Stat label="ADX" value={f(d.current.adx, 1)} /><Stat label="R²" value={f(d.current.r2)} /><Stat label="Choppiness" value={f(d.current.chop, 1)} />
        </div>
        <Note>Final closes of regular sessions through {d.as_of}; the daily history is published after the close, so today is not in it. The daily label uses the four-vote rule (3 of 4 readings past their line) that the study below tested; the intraday label uses the newer score, which has not been tested.</Note>
      </Card>
      <Card title={`Validation on ${d.bars?.toLocaleString("en-IN")} daily bars since ${d.from}`} testid="daily-study">
        <p className={`mb-2 text-sm font-semibold ${ok ? "text-up" : "text-warn"}`} data-testid="daily-verdict">{ok ? "Validated: after Trending days the next 10 days moved in straighter lines than after Range-bound days." : "Not validated: the Trending label did not predict a straighter next 10 days than the Range-bound label. It is shown as a description of the last 20 days only."}</p>
        {bars && <Chart option={bars} height={200} label="Mean efficiency ratio of the next 10 days after each daily label" />}
        <table className="num mt-2 w-full text-xs"><thead><tr className="text-left text-muted"><th>After a day labelled</th><th className="text-right">Samples</th><th className="text-right">Next-10-day efficiency ratio</th><th className="text-right">Next-10-day return</th><th className="text-right">Next-10-day realised vol</th></tr></thead>
          <tbody>{groups.map((k) => { const g = s.groups[k]; return g ? <tr key={k} className="border-t border-rule/50"><td>{k}</td><td className="text-right">{g.n}</td><td className="text-right">{f(g.forward_er)}</td><td className="text-right">{g.forward_return_pct == null ? "—" : `${g.forward_return_pct.toFixed(2)} %`}</td><td className="text-right">{g.forward_rv == null ? "—" : `${g.forward_rv.toFixed(1)} %`}</td></tr> : null; })}</tbody></table>
        <div className="mt-2 flex flex-wrap gap-6">
          <Stat label="Trending minus Range-bound (efficiency ratio)" value={f(s.claim.diff_forward_er, 3)} sub={`one-sided permutation p = ${f(s.claim.p_value, 3)}`} />
          <Stat label="Same difference by period" value={s.claim.thirds.map((t) => f(t.diff, 3)).join(" · ")} sub={s.claim.thirds.map((t) => `${t.from?.slice(0, 4)}–${t.to?.slice(0, 4)}`).join(" · ")} />
          <Stat label="Trending up minus down, next 10-day return" value={s.direction.diff_forward_return_pct == null ? "—" : `${s.direction.diff_forward_return_pct.toFixed(2)} %`} sub={`p = ${f(s.direction.p_value, 3)} · information only`} />
        </div>
        <Note>Criterion fixed before the study: {s.claim.criterion}. Thresholds are the textbook values (none tuned on this history); {s.samples} non-overlapping samples every {s.horizon_days} days from {s.from} to {s.to}; {s.permutations.toLocaleString("en-IN")} permutations, fixed seed. A failed test is reported as failed: nothing was adjusted to make it pass. The realised-volatility column is information, not a claim.</Note>
      </Card>
      {chart && <Card title="Last 250 days"><Chart option={chart.option} height={chart.height} label="NIFTY daily close with the regime shaded" /></Card>}
    </div>
  );
}

export function TrendRegime() {
  const { view } = useParams<{ view: string }>();
  const id = (TREND_VIEWS.some((v) => v.id === view) ? view : "market-regime") as TrendViewId;
  const spec = TREND_VIEWS.find((v) => v.id === id)!;
  const c = useChartColors();
  const L = useViewLayout(`trend-${id}`);
  const [tf, setTf] = L.use("tf", 5);
  const [dayPick, setDayPick] = L.use<string | null>("day", null);
  const daily = id === "daily-regime";
  const idx = useQuery({ queryKey: ["indexBars", dayPick], queryFn: () => api.indexBars(dayPick ?? undefined), refetchInterval: 60_000, retry: false, enabled: !daily });
  const days = idx.data?.days ?? [];
  const newest = days.length === 0 || idx.data?.day === days[days.length - 1];
  const fq = useQuery({ queryKey: ["trend-fut"], queryFn: () => api.futuresSeries(), refetchInterval: 60_000, retry: false, enabled: id === "session-structure" });
  const bars = useMemo(() => fromIndexBars(idx.data?.bars ?? []), [idx.data]);
  const reg = useMemo(() => regimeSeries(bars, { tf }), [bars, tf]);
  const needStored = id === "market-regime";
  const storedQs = useQueries({ queries: needStored ? days.map((d) => ({ queryKey: ["indexBars", d], queryFn: () => api.indexBars(d), staleTime: 600_000, retry: false })) : [] });
  const stored = useMemo(() => storedQs.flatMap((q) => (q.data?.bars.length ? [regimeSeries(fromIndexBars(q.data.bars), { tf })] : [])), [storedQs, tf]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx: Ctx = { c, day: idx.data?.day ?? null, bars, tf, reg, fut: fq.data ?? null, futSameDay: !!fq.data && fq.data.day === idx.data?.day, L, newest };
  return (
    <div className="flex flex-col gap-3" data-testid={`trend-${id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div><h1 className="text-lg font-semibold text-paper">{spec.label}</h1><p className="max-w-3xl text-xs text-muted">{spec.blurb}</p></div>
        <LayoutBar layout={L} />
      </header>
      {!daily && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span>Bars</span>{TFS.map((t) => <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)} className={`min-h-8 rounded-sm border px-2 ${tf === t ? "border-brass text-paper" : "border-rule"}`}>{t} min</button>)}
          {days.length > 1 && <label className="flex items-center gap-1">Session
            <select value={idx.data?.day ?? ""} onChange={(e) => setDayPick(e.target.value === days[days.length - 1] ? null : e.target.value)} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-1 text-paper">{days.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>}
          {idx.data?.day && <span>{idx.data.day} · {bars.length} one-minute bars{bars.length ? ` · last ${hhmmIST(new Date(bars[bars.length - 1]!.t).toISOString())} IST` : ""}</span>}
        </div>
      )}
      {!daily && idx.isLoading && <Loading label="Loading the index bars" />}
      {!daily && idx.isError && <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The index bars could not be loaded.</p>}
      {!daily && idx.data && bars.length === 0 && <p className="text-sm text-muted" data-testid="trend-empty">No one-minute index bars are stored for this session yet. {idx.data.note}</p>}
      {!daily && bars.length > 0 && (
        <>
          {id === "market-regime" && <MarketRegimeView ctx={ctx} stored={stored} />}
          {id === "trend-strength" && <TrendStrengthView ctx={ctx} />}
          {id === "chop-variance" && <ChopVarianceView ctx={ctx} />}
          {id === "session-structure" && <SessionStructureView ctx={ctx} />}
          {id === "opening-range" && <OpeningRangeView ctx={ctx} />}
          {id === "range-used" && <RangeUsedView ctx={ctx} />}
          {id === "gamma-regime" && <GammaRegimeView ctx={ctx} />}
        </>
      )}
      {daily && <DailyRegimeView c={c} />}
    </div>
  );
}
