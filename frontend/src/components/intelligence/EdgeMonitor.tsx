import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { type EdgeHorizon, type EdgeIndicator, type EdgeReport, pct, pts, STATUS_LABEL, STATUS_TONE } from "../../lib/edge";
import { fmtStamp } from "../../lib/swing";
import { EChart, useChartColors } from "../EChart";

const Panel = ({ title, hint, children, testid }: { title: string; hint?: string; children: React.ReactNode; testid?: string }) => (
  <section className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 md:p-4" data-testid={testid}>
    <h2 className="text-sm font-semibold text-paper">{title}{hint && <span className="ml-2 font-normal text-muted">· {hint}</span>}</h2>
    <div className="mt-2">{children}</div>
  </section>
);

/** Progress toward the sessions needed before a label can mean anything (the fresh sessions for a pattern found in stored data). */
function Progress({ have, need, label }: { have: number; need: number; label: string }) {
  const w = Math.min(100, Math.round((have / need) * 100));
  return (
    <div className="mt-1" data-testid="edge-progress">
      <div className="flex justify-between text-[11px] text-muted"><span>{label}</span><span className="num">{have} / {need}</span></div>
      <div className="mt-0.5 h-1.5 rounded-full bg-slate-2" role="progressbar" aria-valuemin={0} aria-valuemax={need} aria-valuenow={have} aria-label={label}><div className="h-1.5 rounded-full bg-brass" style={{ width: `${w}%` }} /></div>
    </div>
  );
}

function Card({ i, need, selected, onSelect }: { i: EdgeIndicator; need: number; selected: boolean; onSelect: () => void }) {
  const h = i.horizons[String(i.primary)]!;
  const core = h.fresh ?? h;
  const fresh = h.fresh != null;
  return (
    <article className={`min-w-0 rounded-md border px-3 py-2 ${selected ? "border-brass bg-slate-2" : "border-rule"}`} data-testid={`edge-card-${i.id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-paper">{i.name}</h3>
        <span className={`shrink-0 text-xs font-semibold ${STATUS_TONE[i.status]}`} data-testid={`edge-status-${i.id}`}>{STATUS_LABEL[i.status]}</span>
      </div>
      <p className="text-xs text-muted">{i.claim}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-[11px] text-muted">{i.kind === "calm" ? "Calm" : "Right"}</dt><dd className="num font-semibold text-paper">{pct(h.hit_rate, 0)}</dd></div>
        <div><dt className="text-[11px] text-muted">By luck</dt><dd className="num text-paper">{pct(h.baseline_drift, 0)}</dd></div>
        <div><dt className="text-[11px] text-muted">Edge</dt><dd className={`num font-semibold ${(h.edge_drift ?? 0) > 0 ? "text-up" : (h.edge_drift ?? 0) < 0 ? "text-down" : "text-paper"}`}>{pts(h.edge_drift)}</dd></div>
      </dl>
      <p className="mt-1 text-[11px] text-muted">{h.calls} decided calls over {h.sessions} sessions ({i.primary}-minute window){h.edge_drift_ci ? ` · interval ${pts(h.edge_drift_ci[0])} to ${pts(h.edge_drift_ci[1])}` : ""}</p>
      <p className="mt-1 text-xs text-paper" data-testid={`edge-text-${i.id}`}>{i.status_text}</p>
      {fresh
        ? <Progress have={core.sessions} need={need} label={`fresh sessions since ${h.tuned_through} (the rule was found in the sessions before)`} />
        : <Progress have={h.sessions} need={need} label="sessions scored" />}
      <button type="button" onClick={onSelect} aria-pressed={selected} className="mt-2 min-h-8 rounded-sm border border-rule px-2 text-xs text-paper hover:border-brass">{selected ? "Shown below" : "Show session by session"}</button>
    </article>
  );
}

function HorizonTable({ i }: { i: EdgeIndicator }) {
  const rows = Object.entries(i.horizons).sort((a, b) => Number(a[0]) - Number(b[0]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="edge-horizons">
        <thead><tr className="text-left text-muted"><th className="px-2 py-1">Window</th><th className="px-2 py-1">Calls</th><th className="px-2 py-1">Right</th><th className="px-2 py-1">By luck</th><th className="px-2 py-1">Edge over drift</th><th className="px-2 py-1">Interval</th><th className="px-2 py-1">Timing edge (vs the day&apos;s own drift)</th></tr></thead>
        <tbody>{rows.map(([k, h]: [string, EdgeHorizon]) => (
          <tr key={k} className="border-t border-rule/50">
            <td className="px-2 py-1">{k} min</td><td className="num px-2 py-1">{h.calls}</td><td className="num px-2 py-1">{pct(h.hit_rate, 0)}</td><td className="num px-2 py-1">{pct(h.baseline_drift, 0)}</td>
            <td className="num px-2 py-1">{pts(h.edge_drift)}</td><td className="num px-2 py-1">{h.edge_drift_ci ? `${pts(h.edge_drift_ci[0])} to ${pts(h.edge_drift_ci[1])}` : "—"}</td>
            <td className="num px-2 py-1">{pts(h.edge_timing)}{h.edge_timing_ci ? ` (${pts(h.edge_timing_ci[0])} to ${pts(h.edge_timing_ci[1])})` : ""}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function RunningChart({ h }: { h: EdgeHorizon }) {
  const c = useChartColors();
  const option = useMemo(() => {
    const x = h.series.map((p) => p.session.slice(5));
    const pctv = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 10);
    return {
      grid: { left: 44, right: 12, top: 28, bottom: 28 }, tooltip: { trigger: "axis", valueFormatter: (v: number | null) => (v == null ? "—" : `${v}%`) },
      legend: { top: 0, textStyle: { color: c.muted } }, xAxis: { type: "category", data: x, axisLabel: { color: c.muted } },
      yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule } } },
      series: [
        { name: "Right so far", type: "line", data: h.series.map((p) => pctv(p.cum_hit_rate)), showSymbol: true, lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } },
        { name: "Luck would give", type: "line", data: h.series.map((p) => pctv(p.cum_baseline)), showSymbol: false, lineStyle: { color: c.muted, type: "dashed", width: 1.5 }, itemStyle: { color: c.muted } },
      ],
    };
  }, [c, h]);
  if (h.series.length < 2) return <p className="text-sm text-muted" role="status" data-testid="edge-chart-empty">The running line appears after the second scored session.</p>;
  return <EChart ariaLabel="Share of calls that were right, running over the scored sessions, against what luck would give" option={option} className="h-60 w-full" />;
}

function SessionTable({ h }: { h: EdgeHorizon }) {
  const rows = [...h.series].reverse();
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs" data-testid="edge-sessions">
        <thead className="sticky top-0 bg-slate"><tr className="text-left text-muted"><th className="px-2 py-1">Session</th><th className="px-2 py-1">Decided calls</th><th className="px-2 py-1">Right</th><th className="px-2 py-1">That day vs luck</th><th className="px-2 py-1">Running right</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.session} className="border-t border-rule/50"><td className="px-2 py-1">{p.session}</td><td className="num px-2 py-1">{p.calls}</td><td className="num px-2 py-1">{pct(p.hit_rate, 0)}</td>
            <td className={`num px-2 py-1 ${(p.edge_drift ?? 0) > 0 ? "text-up" : (p.edge_drift ?? 0) < 0 ? "text-down" : ""}`}>{pts(p.edge_drift)}</td><td className="num px-2 py-1">{pct(p.cum_hit_rate, 0)}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

function JobStatus({ r }: { r: EdgeReport }) {
  const j = r.job;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" data-testid="edge-job">
      <span className={j.enabled ? "text-up" : "text-down"}>{j.enabled ? "Scoring job running" : "Scoring job switched off"}</span>
      <span>last pass {j.last_run ? fmtStamp(j.last_run) : "not yet since the last restart"}</span>
      <span>{j.pending.length ? `${j.pending.length} finished session(s) waiting to be scored` : "nothing waiting"}</span>
      <span>{j.runs}</span>
      {j.last_error && <span role="alert" className="text-down" data-testid="edge-job-error">last error: {j.last_error}</span>}
    </div>
  );
}

/** The Edge monitor: is any indicator doing better than luck, scored automatically every night against what price then did. */
export function EdgeMonitor() {
  const q = useQuery({ queryKey: ["edge-report"], queryFn: () => api.edgeReport(), refetchInterval: 300_000, retry: false });
  const [sel, setSel] = useState("verdict");
  if (q.isPending) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading the edge monitor" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The edge monitor could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}</p>;
  const r = q.data;
  const cur = r.indicators.find((i) => i.id === sel) ?? r.indicators[0];
  const h = cur ? cur.horizons[String(cur.primary)] : undefined;
  return (
    <div className="flex flex-col gap-3" data-testid="edge-monitor">
      <Panel title="Do the indicators have an edge?" hint={`${r.sessions_scored} sessions scored${r.first_session ? `, ${r.first_session} to ${r.last_session}` : ""}`} testid="edge-headline">
        <p className="text-sm text-paper" data-testid="edge-headline-text">{r.headline}</p>
        <div className="mt-2"><JobStatus r={r} /></div>
        {r.sessions_scored === 0 && <p className="mt-2 text-sm text-muted" role="status" data-testid="edge-empty">Nothing has been scored yet: the first pass runs after the next close, or a minute after the server starts if finished sessions are stored.</p>}
      </Panel>
      {r.sessions_scored > 0 && (
        <>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="edge-cards">
            {r.indicators.map((i) => <Card key={i.id} i={i} need={r.min_sessions} selected={cur?.id === i.id} onSelect={() => setSel(i.id)} />)}
          </div>
          {cur && h && (
            <Panel title={`${cur.name}: session by session`} hint={`${cur.primary}-minute window`} testid="edge-detail">
              {h.in_sample_text && <p className="mb-2 text-xs text-brass" data-testid="edge-insample">{h.in_sample_text}</p>}
              <RunningChart h={h} />
              <div className="mt-2 grid gap-3 xl:grid-cols-2"><HorizonTable i={cur} /><SessionTable h={h} /></div>
            </Panel>
          )}
        </>
      )}
      <Panel title="How this is measured" testid="edge-method"><ul className="list-disc space-y-1 pl-5 text-xs text-muted">{r.method.map((m) => <li key={m}>{m}</li>)}</ul></Panel>
    </div>
  );
}
