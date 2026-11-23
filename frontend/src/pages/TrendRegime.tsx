import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { EChart, useChartColors } from "../components/EChart";
import { LayoutBar } from "../components/LayoutBar";
import { Loading } from "../components/Loading";
import { api } from "../lib/api";
import type { ChartColors } from "../lib/chartOptions";
import { gexLevels, gexProfile, regimeFor } from "../lib/gammaAnalysis";
import { hhmmIST } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { marketClockMs } from "../lib/session";
import { TREND_VIEWS, type TrendViewId } from "../lib/trendViews";
import { forwardCheck, regimeSeries, regimeSummary, THRESHOLDS, type RegimeLabel, type RegimeSeries } from "../lib/trendRegime";
import {
  atr, openingRange, rangeUsed, runningMean, runningVwap, structure, varianceRatio, type RBar,
} from "../lib/trendStats";
import type { DailyRegime, FuturesSeries, IndexBar } from "../lib/types";
import { useViewLayout } from "../lib/viewLayout";

const TFS = [1, 3, 5, 15] as const;

const f = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const labelColor = (c: ChartColors, l: string) => (l === "Trending up" ? c.up : l === "Trending down" ? c.down : l === "Range-bound" ? c.info : l === "Unclear" ? c.muted : c.rule);

const Stat = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div><div className="text-[11px] text-muted">{label}</div><div className={`num text-lg font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>
);
const Note = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) => <p className={`text-[11px] ${tone === "warn" ? "text-warn" : "text-muted"}`}>{children}</p>;
const Card = ({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) => (
  <section className="rounded-sm border border-rule bg-slate p-3" data-testid={testid}><h2 className="mb-2 text-sm font-semibold text-paper">{title}</h2>{children}</section>
);

/** Shown on every intraday view: what these figures are and are not. */
const DESCRIPTIVE = "Descriptive and not validated: these figures say how the session has behaved so far, they do not forecast it. Only the daily regime has a validation study on the stored history.";

interface Ctx {
  c: ChartColors; day: string | null; bars: RBar[]; tf: number; reg: RegimeSeries; fut: FuturesSeries | null; futSameDay: boolean;
  L: ReturnType<typeof useViewLayout>; newest: boolean;
}

const toRBar = (b: IndexBar): RBar => ({ t: Date.parse(b.at), o: b.o, h: b.h, l: b.l, c: b.c });
const timeLabels = (bars: RBar[]) => bars.map((b) => hhmmIST(new Date(b.t).toISOString()));

/** Contiguous runs of the same shown label, as shaded areas behind a chart. */
function segments(labels: string[], x: string[], c: ChartColors) {
  const out: [{ xAxis: string; itemStyle: { color: string; opacity: number } }, { xAxis: string }][] = [];
  let s = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i === labels.length || labels[i] !== labels[s]) {
      if (labels[s] !== "Warming up") out.push([{ xAxis: x[s]!, itemStyle: { color: labelColor(c, labels[s]!), opacity: 0.18 } }, { xAxis: x[i - 1]! }]);
      s = i;
    }
  }
  return out;
}

const base = (c: ChartColors, x: string[]) => ({
  animation: false, grid: { left: 52, right: 24, top: 28, bottom: 28 },
  tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
  legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
  xAxis: { type: "category", data: x, axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
});
const yAxis = (c: ChartColors, extra: object = {}) => ({ type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } }, ...extra });
const line = (name: string, data: (number | null)[], color: string, extra: object = {}) => ({ name, type: "line", data, showSymbol: false, lineStyle: { width: 1.5, color }, itemStyle: { color }, connectNulls: false, ...extra });
const guides = (c: ChartColors, ys: number[]) => ({ silent: true, symbol: "none", lineStyle: { color: c.muted, type: "dashed", opacity: 0.7 }, label: { color: c.muted, fontSize: 10 }, data: ys.map((y) => ({ yAxis: y })) });

// ---- views

function MarketRegimeView({ ctx, stored }: { ctx: Ctx; stored: RegimeSeries[] }) {
  const { c, reg, bars } = ctx;
  const pts = reg.points;
  const last = pts[pts.length - 1];
  const x = timeLabels(reg.bars);
  const sum = regimeSummary(pts);
  const check = useMemo(() => {
    const r = stored.map((s) => forwardCheck(s));
    const merge = (k: "trending" | "range" | "unclear") => {
      const n = r.reduce((a, v) => a + v[k].n, 0);
      return { n, mean: n ? r.reduce((a, v) => a + (v[k].meanForwardEr ?? 0) * v[k].n, 0) / n : null };
    };
    return { sessions: stored.length, trending: merge("trending"), range: merge("range"), unclear: merge("unclear") };
  }, [stored]);
  if (!last) return <Note>No bars for this day yet.</Note>;
  const option = {
    ...base(c, x), yAxis: yAxis(c),
    series: [{
      name: "NIFTY", type: "candlestick", data: reg.bars.map((b) => [b.o, b.c, b.l, b.h]), itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down },
      markArea: { silent: true, data: segments(pts.map((p) => p.label), x, c) },
    }],
  };
  const lbl = last.label;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Regime band on the NIFTY chart" testid="regime-chart">
        <EChart option={option} ariaLabel="NIFTY candles with the trend regime shaded behind them" className="h-[320px] w-full" />
        <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
          {(["Trending up", "Trending down", "Range-bound", "Unclear"] as const).map((l) => <span key={l}><span className="mr-1 inline-block size-2 rounded-sm" style={{ background: labelColor(c, l) }} />{l}</span>)}
        </div>
      </Card>
      <Card title="Now" testid="regime-now">
        <div className="flex flex-wrap gap-6">
          <Stat label="Regime (shown)" value={lbl} tone={lbl === "Trending up" ? "text-up" : lbl === "Trending down" ? "text-down" : "text-paper"} sub={lbl !== last.raw ? `this bar alone reads ${last.raw}; the shown label needs ${reg.params.minDwell} bars in a row` : undefined} />
          <Stat label="Confidence" value={last.confidence == null ? "—" : `${Math.round(last.confidence * 100)} %`} sub="share of the four readings that agree, times the share that could be read" />
          <Stat label="Label changes today" value={String(sum.changes)} sub="many changes = no clear regime" />
        </div>
        <ul className="mt-2 list-disc pl-5 text-xs text-paper" data-testid="regime-reasons">{last.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <Note>{DESCRIPTIVE} The thresholds are textbook values (efficiency ratio {THRESHOLDS.erTrend}/{THRESHOLDS.erRange}, ADX {THRESHOLDS.adxTrend}/{THRESHOLDS.adxRange}, R² {THRESHOLDS.r2Trend}/{THRESHOLDS.r2Range}, choppiness {THRESHOLDS.chopTrend}/{THRESHOLDS.chopRange}); none was tuned. {bars.length} one-minute bars, {reg.bars.length} bars of {reg.params.tf} min.</Note>
      </Card>
      <Card title="Time in each regime today" testid="regime-time">
        <div className="flex flex-wrap gap-6">{(["Trending up", "Trending down", "Range-bound", "Unclear", "Warming up"] as RegimeLabel[]).map((l) => <Stat key={l} label={l} value={`${sum.counts[l] ?? 0} bars`} />)}</div>
      </Card>
      <Card title="What followed each label in the stored sessions" testid="regime-check">
        {check.sessions === 0 ? <Note>No stored sessions to check.</Note> : (
          <table className="num w-full text-xs"><thead><tr className="text-left text-muted"><th>Label</th><th className="text-right">Bars</th><th className="text-right">Mean efficiency ratio of the next 12 bars</th></tr></thead>
            <tbody>{([["Trending", check.trending], ["Range-bound", check.range], ["Unclear", check.unclear]] as const).map(([n, v]) => <tr key={n} className="border-t border-rule/50"><td>{n}</td><td className="text-right">{v.n}</td><td className="text-right">{f(v.mean)}</td></tr>)}</tbody></table>
        )}
        <Note>Across {check.sessions} stored session{check.sessions === 1 ? "" : "s"} at {reg.params.tf}-minute bars. The windows overlap and the sample is a few days, so this is a look, not a test: no significance is claimed. The daily regime page has the full study.</Note>
      </Card>
    </div>
  );
}

function SeriesCharts({ ctx, defs }: { ctx: Ctx; defs: { title: string; series: { name: string; data: (number | null)[]; color: string }[]; guide?: number[]; y?: object }[] }) {
  const { c, reg } = ctx;
  const x = timeLabels(reg.bars);
  return (
    <div className="flex flex-col gap-3">
      {defs.map((d) => (
        <Card key={d.title} title={d.title}>
          <EChart ariaLabel={d.title} className="h-[200px] w-full" hoverGroup="trend" option={{ ...base(c, x), yAxis: yAxis(c, d.y), series: d.series.map((s, i) => line(s.name, s.data, s.color, i === 0 && d.guide ? { markLine: guides(c, d.guide) } : {})) }} />
        </Card>
      ))}
    </div>
  );
}

function TrendStrengthView({ ctx }: { ctx: Ctx }) {
  const { c, reg } = ctx;
  const m = reg.points.map((p) => p.metrics);
  const last = m[m.length - 1];
  return (
    <div className="flex flex-col gap-3">
      <SeriesCharts ctx={ctx} defs={[
        { title: `Efficiency ratio (last ${reg.params.window} bars): 1 = straight line, near 0 = going nowhere`, series: [{ name: "ER", data: m.map((v) => v.er), color: c.brass }], guide: [THRESHOLDS.erRange, THRESHOLDS.erTrend], y: { min: 0, max: 1 } },
        { title: `ADX and directional lines (Wilder, ${reg.params.adxN} bars)`, series: [{ name: "ADX", data: m.map((v) => v.adx), color: c.paper }, { name: "+DI", data: m.map((v) => v.plusDi), color: c.up }, { name: "−DI", data: m.map((v) => v.minusDi), color: c.down }], guide: [THRESHOLDS.adxRange, THRESHOLDS.adxTrend] },
        { title: `R² of a straight-line fit (last ${reg.params.window} bars)`, series: [{ name: "R²", data: m.map((v) => v.r2), color: c.info }], guide: [THRESHOLDS.r2Range, THRESHOLDS.r2Trend], y: { min: 0, max: 1 } },
      ]} />
      <Card title="Now">
        <div className="flex flex-wrap gap-6"><Stat label="Efficiency ratio" value={f(last?.er)} /><Stat label="ADX" value={f(last?.adx, 1)} /><Stat label="+DI / −DI" value={`${f(last?.plusDi, 1)} / ${f(last?.minusDi, 1)}`} /><Stat label="R²" value={f(last?.r2)} /><Stat label="Slope" value={last?.slope == null ? "—" : `${last.slope.toFixed(2)} pts/bar`} /></div>
        <Note>{DESCRIPTIVE} Dashed lines are the thresholds that turn each reading into a trend or range vote.</Note>
      </Card>
    </div>
  );
}

function ChopVarianceView({ ctx }: { ctx: Ctx }) {
  const { c, reg } = ctx;
  const closes = reg.bars.map((b) => b.c);
  const qs = [2, 5, 10].map((q) => ({ q, v: varianceRatio(closes, q) }));
  return (
    <div className="flex flex-col gap-3">
      <SeriesCharts ctx={ctx} defs={[{ title: `Choppiness index (last ${reg.params.window} bars): high = choppy, low = trending`, series: [{ name: "Choppiness", data: reg.points.map((p) => p.metrics.chop), color: c.brass }], guide: [THRESHOLDS.chopTrend, THRESHOLDS.chopRange], y: { min: 0, max: 100 } }]} />
      <Card title="Variance ratio of the session so far" testid="vr-table">
        <table className="num w-full text-xs"><thead><tr className="text-left text-muted"><th>Horizon (bars)</th><th className="text-right">VR</th><th className="text-right">z</th><th>Reading</th></tr></thead>
          <tbody>{qs.map(({ q, v }) => (
            <tr key={q} className="border-t border-rule/50"><td>{q}</td><td className="text-right">{f(v?.vr)}</td><td className="text-right">{f(v?.z)}</td>
              <td>{v == null ? `needs ${3 * q + 1} bars` : Math.abs(v.z) < 1.96 ? "not distinguishable from a random walk" : v.vr > 1 ? "trending (returns persist)" : "mean reverting (returns reverse)"}</td></tr>
          ))}</tbody></table>
        <Note>Lo–MacKinlay variance ratio of the session's {reg.params.tf}-minute closes: above 1 means moves tend to continue, below 1 that they tend to reverse; |z| under 1.96 means the session so far cannot be told from a random walk. A short session gives wide uncertainty, so read it with the z. {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

/** The VWAP of the NIFTY future (minute volume from the future series) at a time, from the last minute at or before it. */
function futureVwap(fut: FuturesSeries): { t: number[]; v: (number | null)[] } {
  const t = fut.times.map((s) => Date.parse(s));
  return { t, v: runningVwap(fut.future, fut.volume_per_min) };
}

function SessionStructureView({ ctx }: { ctx: Ctx }) {
  const { c, reg, fut, futSameDay } = ctx;
  const closes = reg.bars.map((b) => b.c);
  const x = timeLabels(reg.bars);
  const twap = runningMean(closes);
  const vw = useMemo(() => (fut && futSameDay ? futureVwap(fut) : null), [fut, futSameDay]);
  const vwapAt = (t: number): number | null => {
    if (!vw) return null;
    let v: number | null = null;
    for (let i = 0; i < vw.t.length && vw.t[i]! <= t; i++) v = vw.v[i] ?? v;
    return v;
  };
  const rawVwap = reg.bars.map((b) => vwapAt(b.t + (reg.params.tf - 1) * 60_000));
  const basis = vw && fut ? (() => { const i = fut.future.length - 1; return fut.spot[i] != null && fut.future[i] != null ? fut.future[i]! - fut.spot[i]! : null; })() : null;
  const sT = structure(closes, twap);
  const a = atr(reg.bars, 14);
  const vwap = rawVwap.map((v) => (v == null ? null : v - (basis ?? 0))); // the future's VWAP moved to index level by the latest basis
  const sV = structure(closes, vwap);
  return (
    <div className="flex flex-col gap-3">
      <Card title="NIFTY against its session mean" testid="structure-chart">
        <EChart ariaLabel="NIFTY close, session mean and future VWAP" className="h-[300px] w-full" option={{ ...base(c, x), yAxis: yAxis(c), series: [line("NIFTY close", closes, c.paper), line("Session mean (TWAP)", twap, c.brass), ...(vw ? [line("Future VWAP (at index level)", vwap, c.info, { lineStyle: { width: 1.5, color: c.info, type: "dashed" } })] : [])] }} />
      </Card>
      <Card title="Structure" testid="structure-stats">
        <div className="flex flex-wrap gap-6">
          <Stat label="Close above the session mean" value={sT ? `${sT.pctAbove.toFixed(0)} % of bars` : "—"} />
          <Stat label="Crossings of the mean" value={sT ? String(sT.crossings) : "—"} sub="many = rotating around it" />
          <Stat label="Longest stay on one side" value={sT ? `${sT.longestRun} bars ${sT.runSide > 0 ? "above" : "below"}` : "—"} />
          <Stat label="Distance now" value={sT ? `${sT.distance >= 0 ? "+" : ""}${sT.distance.toFixed(1)} pts` : "—"} sub={sT && a ? `${(sT.distance / a).toFixed(2)} × the 14-bar ATR` : "ATR needs 15 bars"} />
          {sV && <Stat label="Against future VWAP" value={`${sV.pctAbove.toFixed(0)} % above · ${sV.crossings} crossings`} sub={`${sV.distance >= 0 ? "+" : ""}${sV.distance.toFixed(1)} pts now`} />}
        </div>
        <Note>The session mean is the average of the {reg.params.tf}-minute closes (an index has no traded volume). {vw ? "The future's VWAP is volume weighted from the future's own minute volume and shifted to index level by the latest basis (future minus spot), so it is an approximation of an index VWAP." : "Future VWAP is shown only for the newest session, when the future series is stored for that day."} {DESCRIPTIVE}</Note>
      </Card>
    </div>
  );
}

function OpeningRangeView({ ctx }: { ctx: Ctx }) {
  const { c, reg, bars, L } = ctx;
  const [mins, setMins] = L.use("orMin", 15);
  const or = openingRange(bars, mins);
  const x = timeLabels(reg.bars);
  const closes = reg.bars.map((b) => b.c);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Opening range">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">Range length
          {[5, 15, 30].map((m) => <button key={m} type="button" onClick={() => setMins(m)} aria-pressed={mins === m} className={`min-h-8 rounded-sm border px-2 ${mins === m ? "border-brass text-paper" : "border-rule"}`}>{m} min</button>)}</div>
        {!or ? <Note>No bars yet.</Note> : (
          <>
            <EChart ariaLabel="NIFTY close with the opening range" className="h-[280px] w-full" option={{ ...base(c, x), yAxis: yAxis(c), series: [line("NIFTY close", closes, c.paper, { markLine: guides(c, [or.high, or.low]) })] }} />
            <div className="mt-2 flex flex-wrap gap-6" data-testid="or-stats">
              <Stat label="Range" value={`${or.low.toFixed(1)} – ${or.high.toFixed(1)}`} sub={`${(or.high - or.low).toFixed(1)} pts`} />
              <Stat label="Now" value={!or.ready ? "range still forming" : or.state === "inside" ? "inside" : `${or.state} the range`} tone={or.state === "above" ? "text-up" : or.state === "below" ? "text-down" : undefined} />
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

function useChain(enabled: boolean) {
  const ex = useExpiries();
  const expiry = ex.data?.weekly ?? null;
  return useQuery({ queryKey: ["trend-chain", expiry], queryFn: () => api.optionChain(expiry!), enabled: enabled && !!expiry, refetchInterval: 15_000, retry: false });
}

function RangeUsedView({ ctx }: { ctx: Ctx }) {
  const chain = useChain(ctx.newest);
  const { bars } = ctx;
  if (!ctx.newest) return <Note tone="warn">The implied move comes from today's live option chain, so this view is for the newest session only.</Note>;
  if (chain.isLoading) return <Loading label="Loading the option chain" />;
  const snap = chain.data?.snapshot;
  if (!snap || bars.length === 0) return <Note tone="warn">Needs today's bars and the live option chain.</Note>;
  const spot = bars[bars.length - 1]!.c;
  const prof = gexProfile(snap.rows, snap.underlying_ltp ?? spot, snap.expiry, marketClockMs(Date.parse(snap.retrieved_at)));
  const near = [...prof.rows].sort((a, b) => Math.abs(a.strike - prof.spot) - Math.abs(b.strike - prof.spot))[0];
  const ivs = [near?.ceIv, near?.peIv].filter((v): v is number => v != null);
  const iv = ivs.length ? (100 * ivs.reduce((a, b) => a + b, 0)) / ivs.length : null;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  const used = rangeUsed(hi, lo, prof.spot, iv);
  const sigma = iv == null ? null : (prof.spot * iv) / 100 / Math.sqrt(252);
  return (
    <Card title="Range used against the implied move" testid="range-used">
      <div className="flex flex-wrap gap-6">
        <Stat label="Day's range so far" value={`${(hi - lo).toFixed(1)} pts`} sub={`${lo.toFixed(1)} – ${hi.toFixed(1)}`} />
        <Stat label="At-the-money IV" value={iv == null ? "—" : `${iv.toFixed(2)} %`} sub={`${snap.expiry}, strike ${near?.strike ?? "—"}`} />
        <Stat label="One-day move (1 σ)" value={sigma == null ? "—" : `${sigma.toFixed(1)} pts`} sub="spot × IV ÷ √252" />
        <Stat label="Range used" value={used == null ? "—" : `${(used * 100).toFixed(0)} %`} tone={used != null && used >= 1 ? "text-warn" : undefined} sub="range ÷ (1.5958 × 1 σ)" />
      </div>
      <Note>1.5958 = 2√(2/π) is the expected high-to-low range of a driftless random walk in units of its σ, so 100 % means a normal day's range is already used. The IV is the live at-the-money IV of the nearest weekly expiry now (not the open's), annualised on calendar time and applied per trading day on the 252-day basis: a stated approximation. A weekly expiry day's IV carries expiry-time effects. {DESCRIPTIVE}</Note>
    </Card>
  );
}

function GammaRegimeView({ ctx }: { ctx: Ctx }) {
  const chain = useChain(ctx.newest);
  if (!ctx.newest) return <Note tone="warn">The gamma regime comes from today's live option chain, so this view is for the newest session only.</Note>;
  if (chain.isLoading) return <Loading label="Loading the option chain" />;
  const snap = chain.data?.snapshot;
  if (!snap) return <Note tone="warn">The live option chain is not available.</Note>;
  const prof = gexProfile(snap.rows, snap.underlying_ltp ?? 0, snap.expiry, marketClockMs(Date.parse(snap.retrieved_at)));
  const lv = gexLevels(prof);
  const rg = regimeFor(lv);
  const dist = lv.flip != null ? ((lv.flip - lv.spot) / lv.spot) * 100 : null;
  return (
    <Card title="Gamma regime" testid="gamma-regime">
      <div className="flex flex-wrap gap-6">
        <Stat label="Regime" value={rg?.name ?? "—"} sub={rg?.volatility} />
        <Stat label="Net GEX" value={lv.netTotal == null ? "—" : `${lv.netTotal.toFixed(0)} ₹ crore / 1 %`} />
        <Stat label="Gamma flip" value={lv.flip == null ? "—" : lv.flip.toFixed(0)} sub={dist == null ? undefined : `${dist >= 0 ? "+" : ""}${dist.toFixed(2)} % from spot`} />
        <Stat label="Call wall / put wall" value={`${lv.callWall ?? "—"} / ${lv.putWall ?? "—"}`} />
      </div>
      {rg && <p className="mt-2 text-xs text-paper">{rg.summary} {rg.expectation}</p>}
      <Note>From {snap.expiry}'s chain with Black-76 gamma and each contract's own IV. The sign is a convention (calls positive, puts negative), not an observed position, so this is a model reading. The full GEX profile is on the Gamma page. {DESCRIPTIVE}</Note>
    </Card>
  );
}

function DailyRegimeView({ c }: { c: ChartColors }) {
  const q = useQuery({ queryKey: ["regime-daily"], queryFn: api.intradayRegimeDaily, retry: false, staleTime: 300_000 });
  if (q.isLoading) return <Loading label="Running the daily regime study on the stored history" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The daily regime could not be loaded.</p>;
  const d: DailyRegime = q.data;
  if (d.status !== "ok" || !d.study || !d.current || !d.series) return <Note tone="warn">{d.status}</Note>;
  const s = d.study;
  const ok = d.validated === true;
  const x = d.series.dates;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Daily regime now" testid="daily-now">
        <div className="flex flex-wrap gap-6">
          <Stat label={`As of ${d.as_of}`} value={d.current.label} />
          <Stat label="Efficiency ratio (20 d)" value={f(d.current.er)} /><Stat label="ADX" value={f(d.current.adx, 1)} /><Stat label="R²" value={f(d.current.r2)} /><Stat label="Choppiness" value={f(d.current.chop, 1)} />
        </div>
        <Note>Final closes of regular sessions through {d.as_of}; the daily history is published after the close, so today is not in it.</Note>
      </Card>
      <Card title={`Validation on ${d.bars?.toLocaleString("en-IN")} daily bars since ${d.from}`} testid="daily-study">
        <p className={`mb-2 text-sm font-semibold ${ok ? "text-up" : "text-warn"}`} data-testid="daily-verdict">{ok ? "Validated: after Trending days the next 10 days moved in straighter lines than after Range-bound days." : "Not validated: the Trending label did not predict a straighter next 10 days than the Range-bound label. It is shown as a description of the last 20 days only."}</p>
        <table className="num w-full text-xs"><thead><tr className="text-left text-muted"><th>After a day labelled</th><th className="text-right">Samples</th><th className="text-right">Next-10-day efficiency ratio</th><th className="text-right">Next-10-day return</th><th className="text-right">Next-10-day realised vol</th></tr></thead>
          <tbody>{["Trending up", "Trending down", "Range-bound", "Unclear"].map((k) => { const g = s.groups[k]; return g ? <tr key={k} className="border-t border-rule/50"><td>{k}</td><td className="text-right">{g.n}</td><td className="text-right">{f(g.forward_er)}</td><td className="text-right">{g.forward_return_pct == null ? "—" : `${g.forward_return_pct.toFixed(2)} %`}</td><td className="text-right">{g.forward_rv == null ? "—" : `${g.forward_rv.toFixed(1)} %`}</td></tr> : null; })}</tbody></table>
        <div className="mt-2 flex flex-wrap gap-6">
          <Stat label="Trending minus Range-bound (efficiency ratio)" value={f(s.claim.diff_forward_er, 3)} sub={`one-sided permutation p = ${f(s.claim.p_value, 3)}`} />
          <Stat label="Same difference by period" value={s.claim.thirds.map((t) => f(t.diff, 3)).join(" · ")} sub={s.claim.thirds.map((t) => `${t.from?.slice(0, 4)}–${t.to?.slice(0, 4)}`).join(" · ")} />
          <Stat label="Trending up minus down, next 10-day return" value={s.direction.diff_forward_return_pct == null ? "—" : `${s.direction.diff_forward_return_pct.toFixed(2)} %`} sub={`p = ${f(s.direction.p_value, 3)} · information only`} />
        </div>
        <Note>Criterion fixed before the study: {s.claim.criterion}. Thresholds are the textbook values (none tuned on this history); {s.samples} non-overlapping samples every {s.horizon_days} days from {s.from} to {s.to}; {s.permutations.toLocaleString("en-IN")} permutations, fixed seed. A failed test is reported as failed: nothing was adjusted to make it pass. The realised-volatility column is information, not a claim.</Note>
      </Card>
      <Card title="Last 250 days">
        <EChart ariaLabel="NIFTY daily close with the regime shaded" className="h-[260px] w-full" option={{ ...base(c, x), yAxis: yAxis(c), series: [{ ...line("NIFTY close", d.series.close, c.paper), markArea: { silent: true, data: segments(d.series.label, x, c) } }] }} />
      </Card>
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
  const bars = useMemo(() => (idx.data?.bars ?? []).map(toRBar), [idx.data]);
  const reg = useMemo(() => regimeSeries(bars, { tf }), [bars, tf]);
  const needStored = id === "market-regime";
  const storedQs = useQueries({ queries: needStored ? days.map((d) => ({ queryKey: ["indexBars", d], queryFn: () => api.indexBars(d), staleTime: 600_000, retry: false })) : [] });
  const stored = useMemo(() => storedQs.flatMap((q) => (q.data?.bars.length ? [regimeSeries(q.data.bars.map(toRBar), { tf })] : [])), [storedQs, tf]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx: Ctx = { c, day: idx.data?.day ?? null, bars, tf, reg, fut: fq.data ?? null, futSameDay: !!fq.data && fq.data.day === idx.data?.day, L, newest };
  return (
    <div className="flex flex-col gap-3" data-testid={`trend-${id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div><h1 className="text-lg font-semibold text-paper">{spec.label}</h1><p className="max-w-3xl text-xs text-muted">{spec.blurb}</p></div>
        <LayoutBar layout={L} />
      </header>
      <nav className="flex flex-wrap gap-1 text-xs" aria-label="Trend and regime views">
        {TREND_VIEWS.map((v) => <Link key={v.id} to={`/trend/${v.id}`} aria-current={v.id === id ? "page" : undefined} className={`rounded-sm border px-2 py-1 ${v.id === id ? "border-brass text-paper" : "border-rule text-muted hover:text-paper"}`}>{v.label}</Link>)}
      </nav>
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
