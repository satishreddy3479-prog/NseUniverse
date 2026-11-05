import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { MISSING } from "../lib/format";
import { fmtDay, HV_WINDOWS, hvLabel, ivpReading, labelEvery, rankAt, RANGES, rollingRank } from "../lib/ivChart";
import { EChart, useChartColors } from "./EChart";

const pct = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v.toFixed(d)}%`);
const btn = (on: boolean) => `min-h-9 rounded-sm border px-3 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;

function Controls({ hv, setHv, range, setRange, rangeLabel = "IVR / IVP range" }: { hv: number; setHv: (n: number) => void; range?: string; setRange?: (r: string) => void; rangeLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
      <div className="flex items-center gap-1" role="group" aria-label="HV window"><span className="mr-1">HV window</span>
        {HV_WINDOWS.map((w) => <button key={w} type="button" aria-pressed={hv === w} className={btn(hv === w)} onClick={() => setHv(w)}>{hvLabel(w)}</button>)}
      </div>
      {range != null && setRange && <div className="flex items-center gap-1" role="group" aria-label={rangeLabel}><span className="mr-1">{rangeLabel}</span>
        {RANGES.map((r) => <button key={r.id} type="button" aria-pressed={range === r.id} className={btn(range === r.id)} onClick={() => setRange(r.id)}>{r.id}</button>)}
      </div>}
    </div>
  );
}

function useChart(hv: number) {
  return useQuery({ queryKey: ["ivChart", hv], queryFn: () => api.intradayIvChart(hv), refetchInterval: 300_000, retry: false });
}
function problem(q: ReturnType<typeof useChart>) {
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The daily volatility history could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  if (q.data.dates.length === 0) return <p className="text-sm text-muted" data-testid="ivchart-empty">No days with both a NIFTY close and an India VIX close are stored yet.</p>;
  return null;
}
const Stat = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
  <div><div className="text-[11px] text-muted">{label}</div><div className={`num text-lg font-semibold ${tone ?? "text-paper"}`}>{value}</div></div>
);
const Source = ({ text, last, prov }: { text: string; last: string; prov?: { date: string; close: number; note: string } | null }) => (
  <>
  {prov && <p className="mt-2 text-[11px] text-warn" data-testid="ivchart-provisional">{fmtDay(prov.date)} is provisional: {prov.note}. HV, RV and the NIFTY line include it (close {prov.close.toLocaleString("en-IN")}).</p>}
  <p className="mt-2 text-[11px] text-muted">Implied volatility here is {text}. India VIX is stored through {fmtDay(last)}. Our own at-the-money IV exists only for the sessions whose option chains were stored, so a long IV history, IVR and IVP come from India VIX, and that is what is plotted.</p>
  </>
);

/** IV (India VIX) against HV with IV rank and IV percentile, and NIFTY as the price line. */
export function IvChartBody() {
  const c = useChartColors();
  const [hv, setHv] = useState(21);
  const [range, setRange] = useState("1Y");
  const q = useChart(hv);
  const blocked = problem(q);
  if (blocked || !q.data) return <div className="flex flex-col gap-3" data-testid="ivchart-tool">{blocked}</div>;
  const d = q.data;
  const days = RANGES.find((r) => r.id === range)!.days;
  const rk = rollingRank(d.iv, days);
  const i = d.dates.length - 1; // newest day (may be provisional: no India VIX yet)
  const j = d.iv.reduce<number>((a, v, k) => (v != null ? k : a), -1); // newest day with an India VIX
  const now = rankAt(d.iv, j, days);
  const lo = d.dates.length - Math.min(d.dates.length, days); // the chart shows the chosen range, newest day last
  const x = d.dates.slice(lo);
  const every = labelEvery(x.length);
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } };
  const legend = { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 };
  const axisX = { type: "category", data: x, axisLabel: { color: c.muted, interval: (i: number) => every(i), formatter: fmtDay, alignMinLabel: "left", alignMaxLabel: "right", margin: 10 }, axisLine: { lineStyle: { color: c.rule } } };
  const top = {
    grid: { left: 46, right: 56, top: 40, bottom: 40 }, tooltip: tip, legend, xAxis: axisX,
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
      { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } },
    ],
    series: [
      { name: "IV (India VIX)", type: "line", showSymbol: false, data: d.iv.slice(lo), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } },
      { name: `HV ${hvLabel(d.window)}`, type: "line", showSymbol: false, data: d.hv.slice(lo), lineStyle: { color: c.info, width: 1.8 }, itemStyle: { color: c.info } },
      { name: `RV ${hvLabel(d.window)}`, type: "line", showSymbol: false, data: d.rv.slice(lo), lineStyle: { color: c.up, width: 1.5, type: "dashed" }, itemStyle: { color: c.up } },
      { name: "NIFTY 50 close", type: "line", yAxisIndex: 1, showSymbol: false, data: d.close.slice(lo), lineStyle: { color: c.muted, width: 1, opacity: 0.8 }, itemStyle: { color: c.muted } },
    ],
  };
  const bottom = {
    grid: { left: 46, right: 56, top: 32, bottom: 40 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : v.toFixed(1)) }, legend, xAxis: axisX,
    yAxis: { type: "value", min: 0, max: 100, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
    series: [
      { name: `IVR ${range}`, type: "line", showSymbol: false, data: rk.ivr.slice(lo), lineStyle: { color: c.up, width: 1.8 }, itemStyle: { color: c.up },
        markLine: { silent: true, symbol: "none", label: { color: c.muted, fontSize: 10 }, lineStyle: { color: c.muted, type: "dashed" }, data: [{ yAxis: 30 }, { yAxis: 70 }] } },
      { name: `IVP ${range}`, type: "line", showSymbol: false, data: rk.ivp.slice(lo), lineStyle: { color: c.down, width: 1.8 }, itemStyle: { color: c.down } },
    ],
  };
  const hvNow = d.hv[i] ?? null;
  const hvAtIv = d.hv[j] ?? null;
  const gap = hvAtIv == null || d.iv[j] == null ? null : d.iv[j]! - hvAtIv;
  return (
    <div className="flex flex-col gap-3" data-testid="ivchart-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <Controls hv={hv} setHv={setHv} range={range} setRange={setRange} />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6" data-testid="ivchart-cards">
          <Stat label={`IV (India VIX) ${j >= 0 ? fmtDay(d.dates[j]!) : ""}`} value={pct(d.iv[j])} tone="text-brass" />
          <Stat label={`HV ${hvLabel(d.window)}`} value={pct(hvNow)} />
          <Stat label={`RV ${hvLabel(d.window)}`} value={pct(d.rv[i] ?? null)} />
          <Stat label="IV − HV" value={gap == null ? MISSING : `${gap >= 0 ? "+" : "−"}${Math.abs(gap).toFixed(2)} pts`} />
          <Stat label={`IVR ${range}`} value={pct(now.ivr, 1)} />
          <Stat label={`IVP ${range}`} value={pct(now.ivp, 1)} />
        </div>
        <p className="mt-2 text-xs text-paper" data-testid="ivchart-reading">{ivpReading(now.ivp, range)}{now.low != null ? ` The ${range} range runs from ${pct(now.low)} to ${pct(now.high)}.` : ""}</p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">IV, HV and NIFTY</h2>
        <div style={{ height: 320 }} data-testid="ivchart-top"><EChart option={top} ariaLabel="India VIX against historical volatility with the NIFTY 50 close" /></div>
        <h2 className="mb-1 mt-3 text-sm font-semibold text-paper">IV rank and IV percentile</h2>
        <div style={{ height: 200 }} data-testid="ivchart-bottom"><EChart option={bottom} ariaLabel="IV rank and IV percentile through time" /></div>
        <p className="mt-1 text-[11px] text-muted">IVR = (IV − lowest) ÷ (highest − lowest) × 100 over the range. IVP = share of the range&apos;s days with a lower IV than that day. HV is the standard deviation of the window&apos;s daily log returns (divided by n) × √252; RV (dashed green) is the root mean square of the same returns × √252, so it counts the average move itself as volatility too. Both use closes only. Dashed lines at 30 and 70 are our reading thresholds. The first {range} of history has no rank (the range is not full yet); nothing is filled in.</p>
        <Source text={d.iv_source} last={d.dates[Math.max(0, d.iv.reduce<number>((a, v, k) => (v != null ? k : a), -1))]!} prov={d.provisional ?? null} />
      </div>
    </div>
  );
}

/** IV − HV by day as bars, with the NIFTY close as a line. */
export function IvMinusHvChart() {
  const c = useChartColors();
  const [hv, setHv] = useState(21);
  const [range, setRange] = useState("1Y");
  const q = useChart(hv);
  const blocked = problem(q);
  if (blocked || !q.data) return <div data-testid="ivminus-tool">{blocked}</div>;
  const d = q.data;
  const lo = d.dates.length - Math.min(d.dates.length, RANGES.find((r) => r.id === range)!.days);
  const every = labelEvery(d.dates.length - lo);
  const diff = d.iv.map((v, k) => (d.hv[k] == null || v == null ? null : +(v - d.hv[k]!).toFixed(2))).slice(lo);
  const valid = diff.filter((v): v is number => v != null);
  const above = valid.filter((v) => v > 0).length;
  const option = {
    grid: { left: 46, right: 56, top: 40, bottom: 40 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: d.dates.slice(lo), axisLabel: { color: c.muted, interval: (i: number) => every(i), formatter: fmtDay, alignMinLabel: "left", alignMaxLabel: "right", margin: 10 }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [
      { type: "value", axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
      { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } },
    ],
    series: [
      { name: `IV − HV ${hvLabel(d.window)} (pts)`, type: "bar", data: diff.map((v) => (v == null ? null : { value: v, itemStyle: { color: v >= 0 ? c.up : c.down } })) },
      { name: "NIFTY 50 close", type: "line", yAxisIndex: 1, showSymbol: false, data: d.close.slice(lo), lineStyle: { color: c.muted, width: 1.2 }, itemStyle: { color: c.muted } },
    ],
  };
  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="ivminus-tool">
      <Controls hv={hv} setHv={setHv} range={range} setRange={setRange} rangeLabel="Range" />
      <h2 className="mb-1 mt-3 text-sm font-semibold text-paper">IV − HV by day, {d.dates[lo]} to {d.dates[d.dates.length - 1]} ({d.dates.length - lo} days)</h2>
      <div style={{ height: 320 }} data-testid="ivminus-chart"><EChart option={option} ariaLabel="India VIX minus historical volatility by day with the NIFTY 50 close" /></div>
      <p className="mt-1 text-[11px] text-muted" data-testid="ivminus-note">{valid.length ? `IV was above HV on ${above} of ${valid.length} days (${((above / valid.length) * 100).toFixed(0)}%). ` : ""}Green bars: options priced above the realised move; red: below. It is context about how rich or cheap options are, not a signal.</p>
      <Source text={d.iv_source} last={d.dates[Math.max(0, d.iv.reduce<number>((a, v, k) => (v != null ? k : a), -1))]!} prov={d.provisional ?? null} />
    </div>
  );
}
