import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../lib/api";
import { CLASS_ORDER, dayBoardChart, horizonName, pctOf, scoreTone, sgn, toneClass } from "../../lib/dayBoard";
import { fmtPrice, fmtTimeIST, hhmmIST, MISSING } from "../../lib/format";
import type { BucketStat, Outlook, OutlookPhase, Reliability, ScorecardRow } from "../../lib/intelligence";
import { EChart, useChartColors } from "../EChart";

const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div className="min-w-0 rounded-md bg-slate-2 px-3 py-2">
    <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
    <div className={`text-lg font-semibold leading-tight ${tone ?? "text-paper"}`}>{value}</div>
    {sub && <div className="text-xs leading-snug text-muted">{sub}</div>}
  </div>
);
const Panel = ({ title, hint, children, testid }: { title: string; hint?: string; children: React.ReactNode; testid?: string }) => (
  <section className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 md:p-4" data-testid={testid}>
    <h2 className="text-sm font-semibold text-paper">{title}{hint && <span className="ml-2 font-normal text-muted">· {hint}</span>}</h2>
    <div className="mt-2">{children}</div>
  </section>
);

/** Sentiment now, the session regime, the lean and the move the options market prices: four answers in a row, then the reading in plain sentences. */
function Header({ o }: { o: Outlook }) {
  const n = o.now;
  const e30 = o.expected.find((e) => e.minutes === 30);
  const tr = n.trend;
  return (
    <section aria-label="The day in four answers" data-testid="day-header">
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Tile label="Sentiment now" value={n.score == null ? "No verdict" : `${n.class} (${sgn(n.score)})`} tone={toneClass(scoreTone(n.score))}
          sub={n.score == null ? (n.reason ?? "not enough evidence") : `evidence quality ${n.confidence?.toFixed(0) ?? MISSING}/100 · ${pctOf(n.groups_bullish)} of the weight bullish, ${pctOf(n.groups_bearish)} bearish`} />
        <Tile label="Session regime" value={tr?.label ?? "Warming up"} tone={tr?.direction === 1 ? "text-up" : tr?.direction === -1 ? "text-down" : "text-paper"}
          sub={tr?.score == null ? "the first half hour has no regime yet" : `trend score ${Math.round(tr.score * 100)}/100${tr.agreement ? ` · ${tr.agreement.agree} of ${tr.agreement.of} readings agree` : ""}`} />
        <Tile label="Lean" value={n.lean.text} tone={n.lean.call === 1 ? "text-up" : n.lean.call === -1 ? "text-down" : "text-paper"} sub={n.lean.why} />
        <Tile label="Next 30 minutes priced at" value={e30?.sd_points == null ? (o.live ? MISSING : "Market closed") : `±${e30.sd_points.toFixed(0)} pts`}
          sub={e30?.low == null ? (o.live ? "needs the live ATM implied volatility" : `showing ${o.session}: nothing is priced after the close`) : `${fmtPrice(e30.low)} to ${fmtPrice(e30.high)} · one standard deviation, no direction`} />
      </div>
      <ul className="mt-2 space-y-1 rounded-md border border-rule bg-slate px-3 py-2 text-sm text-paper" data-testid="day-read">
        {o.read.map((l) => <li key={l} className="leading-snug">{l}</li>)}
      </ul>
    </section>
  );
}

function DayChart({ o }: { o: Outlook }) {
  const c = useChartColors();
  const chart = useMemo(() => dayBoardChart(c, o), [c, o]);
  if (o.path.length < 2) return <p className="text-sm text-muted" role="status" data-testid="day-chart-empty">No minutes have been recorded for {o.session} yet: the sentiment line appears as the session is recorded (one point a minute while the market is live).</p>;
  return <div className="w-full" style={{ height: chart.height }}><EChart option={chart.option} ariaLabel="NIFTY, the fused sentiment and the trend and regime group through the session, with the trend regime shaded" className="h-full w-full" /></div>;
}

const STATE = { past: "done", now: "now", future: "to come" } as const;
function PhaseCard({ p }: { p: OutlookPhase }) {
  const tone = toneClass(scoreTone(p.mean_score));
  return (
    <li className={`min-w-0 rounded-md border px-3 py-2 ${p.state === "now" ? "border-brass bg-slate-2" : "border-rule"}`} data-testid={`phase-${p.name}`}>
      <div className="flex items-baseline justify-between gap-2"><span className="text-sm font-semibold text-paper">{p.name}</span><span className="text-[11px] text-muted">{p.from}–{p.to} · {STATE[p.state]}</span></div>
      {p.state !== "future" && p.rows ? (
        <div className="mt-1 text-sm">
          <div className={tone}>{p.class ?? MISSING}{p.mean_score != null && ` (${sgn(p.mean_score)})`}</div>
          <div className="text-xs text-muted">{p.move_pct == null ? "no move recorded" : `NIFTY ${sgn(p.move_pct, 2)}%`}{p.trend ? ` · ${p.trend}` : ""}</div>
        </div>
      ) : p.state !== "future" ? <div className="mt-1 text-xs text-muted">{p.note ?? "nothing recorded"}</div> : null}
      {p.expected_sd_points != null && <div className="mt-1 text-xs text-muted">priced at about ±{p.expected_sd_points.toFixed(0)} pts{p.state === "now" ? ` for the ${p.expected_minutes} min left` : ""} (1σ)</div>}
    </li>
  );
}

function Expected({ o }: { o: Outlook }) {
  const cls = o.now.class ?? "";
  const hist = o.history.by_class[cls];
  const cell = (h: BucketStat | undefined) => (h == null ? MISSING : h.up_share == null ? <span className="text-muted" title={`${h.decided} decided snapshots: under ${o.history.min_decided}, no share is shown`}>too few ({h.decided})</span> : `${pctOf(h.up_share)} up`);
  return (
    <Panel title="Expected outcome" hint="what the evidence supports, not a forecast" testid="day-expected">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-2 text-xs text-muted"><tr><th className="px-2 py-1.5 text-left">Horizon</th><th className="px-2 py-1.5 text-right">Priced move (1σ)</th><th className="px-2 py-1.5 text-right">Band</th><th className="px-2 py-1.5 text-right" title={`After a ${cls} verdict in the stored sessions: the share of decided snapshots after which NIFTY was higher`}>After a {cls || "—"} verdict, history</th></tr></thead>
          <tbody>
            {o.expected.map((e) => (
              <tr key={e.label} className="border-t border-rule/50" data-testid={`expected-${e.minutes}`}>
                <td className="px-2 py-1.5 text-left text-paper">{horizonName(e.label, e.minutes)}</td>
                <td className="num px-2 py-1.5 text-right">{e.sd_points == null ? MISSING : `±${e.sd_points.toFixed(0)} pts`}</td>
                <td className="num px-2 py-1.5 text-right text-muted">{e.low == null ? MISSING : `${fmtPrice(e.low)} – ${fmtPrice(e.high)}`}</td>
                <td className="px-2 py-1.5 text-right text-muted">{["15", "30", "60"].includes(String(e.minutes)) ? cell(hist?.horizons[String(e.minutes)]) : MISSING}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted">The band is spot ± one standard deviation of a random walk with today's at-the-money implied volatility: about two times in three price stays inside it, and it says nothing about direction. The history column counts snapshots, which overlap{hist ? ` (${hist.sessions} session${hist.sessions === 1 ? "" : "s"})` : ""}.</p>
      {o.levels.length > 0 && (
        <div className="mt-3" data-testid="day-levels">
          <h3 className="text-[11px] uppercase tracking-wide text-muted">Levels that confirm or invalidate the lean, nearest first</h3>
          <ul className="mt-1 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            {o.levels.map((l) => (
              <li key={l.name} className="flex flex-wrap items-baseline justify-between gap-x-2" title={l.meaning}>
                <span className="text-paper">{l.name} <span className="num">{fmtPrice(l.price)}</span></span>
                <span className="num text-xs text-muted">{l.distance_points == null ? "" : `${sgn(l.distance_points, 0)} pts${l.distance_atr == null ? "" : ` · ${sgn(l.distance_atr, 1)} ATR`}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

const RESULT: Record<ScorecardRow["result"], string> = { hit: "text-up", miss: "text-down", flat: "text-muted", "no call": "text-muted", "no verdict": "text-muted", pending: "text-muted" };
function TrackRecord({ o }: { o: Outlook }) {
  const sc = o.scorecard;
  const rel: Reliability = o.reliability;
  const gradeTone = rel.grade === "Established" ? "text-up" : rel.grade === "Early" ? "text-warn" : "text-muted";
  return (
    <Panel title="Track record" hint="how the verdict has done, so you know how much to lean on it" testid="day-record">
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="flex items-baseline gap-2"><span className={`text-base font-semibold ${gradeTone}`} data-testid="day-grade">{rel.grade}</span><span className="text-xs text-muted">out of sample, 30-minute lean</span></div>
          <p className="mt-1 text-sm text-paper">{rel.text}.</p>
          {rel.session_rates && rel.session_rates.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1" aria-label="Hit rate of each test session">
              {rel.session_rates.map((s) => (
                <li key={s.session} className={`rounded-sm border border-rule px-1.5 py-0.5 text-[11px] ${s.hit_rate > 0.5 ? "text-up" : "text-down"}`} title={`${s.session}: ${s.decided} decided calls`}>{s.session.slice(5)} {pctOf(s.hit_rate)}</li>
              ))}
            </ul>
          )}
          {rel.note && <p className="mt-1 text-[11px] text-muted">{rel.note}</p>}
        </div>
        <div>
          <div className="text-sm text-paper" data-testid="day-score">Today so far: <b>{sc.hits}</b> of <b>{sc.decided}</b> decided 30-minute calls were right.</div>
          {sc.rows.length === 0 ? <p className="mt-1 text-xs text-muted">No calls recorded yet for this session.</p> : (
            <div className="mt-1 max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-2 text-muted"><tr><th className="px-2 py-1 text-left">Time</th><th className="px-2 py-1 text-left">Verdict</th><th className="px-2 py-1 text-right">Next 30 min</th><th className="px-2 py-1 text-right">Result</th></tr></thead>
                <tbody>
                  {sc.rows.map((r) => (
                    <tr key={r.at} className="border-t border-rule/50">
                      <td className="num px-2 py-1 text-left">{hhmmIST(r.at)}</td>
                      <td className={`px-2 py-1 text-left ${toneClass(scoreTone(r.score))}`}>{r.class ?? MISSING}{r.score != null && ` (${sgn(r.score)})`}</td>
                      <td className="num px-2 py-1 text-right text-muted">{r.forward_pct == null ? MISSING : `${sgn(r.forward_pct, 2)}%`}</td>
                      <td className={`px-2 py-1 text-right ${RESULT[r.result]}`}>{r.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <h3 className="mt-3 text-[11px] uppercase tracking-wide text-muted">What followed each verdict in the stored sessions ({o.history.sessions} session{o.history.sessions === 1 ? "" : "s"})</h3>
      <div className="mt-1 overflow-x-auto" data-testid="day-history">
        <table className="w-full text-sm">
          <thead className="bg-slate-2 text-xs text-muted"><tr><th className="px-2 py-1.5 text-left">Verdict</th><th className="px-2 py-1.5 text-right">Sessions</th><th className="px-2 py-1.5 text-right">15 min later</th><th className="px-2 py-1.5 text-right">30 min later</th><th className="px-2 py-1.5 text-right">60 min later</th><th className="px-2 py-1.5 text-right">Mean 30-min move</th></tr></thead>
          <tbody>
            {CLASS_ORDER.filter((k) => o.history.by_class[k]).map((k) => {
              const v = o.history.by_class[k]!;
              const cell = (m: string) => { const h = v.horizons[m]; return h == null ? MISSING : h.up_share == null ? `too few (${h.decided})` : `${pctOf(h.up_share)} up (${pctOf(h.up_ci95?.[0])}–${pctOf(h.up_ci95?.[1])})`; };
              const h30 = v.horizons["30"];
              return (
                <tr key={k} className={`border-t border-rule/50 ${k === o.now.class ? "bg-slate-2" : ""}`}>
                  <td className={`px-2 py-1.5 text-left ${toneClass(scoreTone(k.includes("Bull") ? 50 : k.includes("Bear") ? -50 : 0))}`}>{k}{k === o.now.class && <span className="ml-1 text-[11px] text-muted">(now)</span>}</td>
                  <td className="num px-2 py-1.5 text-right">{v.sessions}</td>
                  <td className="num px-2 py-1.5 text-right text-muted">{cell("15")}</td><td className="num px-2 py-1.5 text-right text-muted">{cell("30")}</td><td className="num px-2 py-1.5 text-right text-muted">{cell("60")}</td>
                  <td className="num px-2 py-1.5 text-right">{h30?.mean_pct == null ? MISSING : `${sgn(h30.mean_pct, 3)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted">{o.history.caution}</p>
    </Panel>
  );
}

/** The redesigned top of Market Intelligence: sentiment through the day, the five phases, the expected outcome and the track record. */
export function DayBoard({ why }: { why?: React.ReactNode }) {
  const q = useQuery({ queryKey: ["intelligence-outlook"], queryFn: () => api.intelligenceOutlook(), refetchInterval: 15_000, retry: false });
  if (q.isPending) return <div className="space-y-2" aria-label="Loading the day board"><div className="h-24 animate-pulse rounded-md border border-rule bg-slate" /><div className="h-72 animate-pulse rounded-md border border-rule bg-slate" />{why}</div>;
  if (q.isError || !q.data) return <div className="flex flex-col gap-3"><p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down" data-testid="day-error">The day board could not be loaded: {q.error instanceof Error ? q.error.message : "the server did not answer"}. The evidence below does not depend on it.</p>{why}</div>;
  const o = q.data;
  return (
    <div className="flex flex-col gap-3" data-testid="day-board">
      {!o.live && <p className="rounded-sm border border-warn/40 px-3 py-1.5 text-xs text-warn" role="status" data-testid="day-closed">The market is not live. Showing the recorded session of {o.session}{o.generated_at ? ` (read ${fmtTimeIST(o.generated_at)})` : ""}; nothing is priced for the minutes ahead.</p>}
      <Header o={o} />
      {why}
      <Panel title="Sentiment through the day" hint={`${o.session} · ${o.path.length} recorded points`} testid="day-chart"><DayChart o={o} /></Panel>
      <section aria-label="The session in phases">
        <ul className="grid gap-2 md:grid-cols-3 xl:grid-cols-5" data-testid="day-phases">{o.phases.map((p) => <PhaseCard key={p.name} p={p} />)}</ul>
      </section>
      <Expected o={o} />
      <TrackRecord o={o} />
      <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-muted" data-testid="day-limits">{o.limits.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

