import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import type { BacktestResult, BacktestSide } from "../lib/types";
import { MethodologyPanel } from "./MethodologyPanel";

const f = (v: number | null | undefined, d = 3) => (v == null ? MISSING : v.toFixed(d));
const ci = (c: [number, number] | null | undefined, d = 3) => (c == null ? MISSING : `${c[0].toFixed(d)} to ${c[1].toFixed(d)}`);

/** Worked example from the first test that has an out-of-sample result: its own numbers, step by step. */
export function backtestExample(tests: BacktestResult[]): string[] {
  const t = tests.find((x) => x.out_of_sample.net_return_pct && x.out_of_sample.net_return_pct.n > 0) ?? tests.find((x) => x.out_of_sample.difference?.diff != null);
  if (!t) return [];
  const o = t.out_of_sample;
  if (o.net_return_pct && o.net_return_pct.n > 0) {
    const s = o.net_return_pct;
    return [
      `${t.title}: ${t.rule}`,
      `Out-of-sample sessions: ${t.sessions.out_of_sample.join(", ")} (all later than the in-sample sessions)`,
      `Each event: ${t.side > 0 ? "+" : "−"}(NIFTY return over the next 30 min) − ${(t.cost_bps / 100).toFixed(2)} % cost; ${s.n} non-overlapping events`,
      `Mean = total / n = ${f(s.total, 3)} / ${s.n} = ${f(s.mean, 4)} %; 95% interval ${ci(s.ci95, 4)}; win rate ${f(s.win_rate, 1)}%; max drawdown ${f(s.max_drawdown, 3)} %`,
    ];
  }
  const d = o.difference!;
  return [`${t.title}: ${t.rule}`, `Mean target when the event holds ${f(d.mean_event, 4)}, otherwise ${f(d.mean_other, 4)}: difference ${f(d.diff, 4)} (95% interval ${ci(d.ci95, 4)})`];
}

function Side({ s, directional }: { s: BacktestSide; directional: boolean }) {
  return (
    <>
      <td className="num px-2 py-1.5 text-right">{s.events}<span className="text-muted"> / {s.others}</span></td>
      {directional && s.net_return_pct ? (
        <>
          <td className="num px-2 py-1.5 text-right">{f(s.net_return_pct.win_rate, 1)}%</td>
          <td className={`num px-2 py-1.5 text-right ${(s.net_return_pct.mean ?? 0) >= 0 ? "text-up" : "text-down"}`}>{f(s.net_return_pct.mean, 4)}%</td>
          <td className="num px-2 py-1.5 text-right text-muted">{ci(s.net_return_pct.ci95, 3)}</td>
          <td className="num px-2 py-1.5 text-right">{f(s.net_return_pct.max_drawdown, 2)}%</td>
          <td className="num px-2 py-1.5 text-right">{f(s.net_return_pct.risk_reward, 2)}</td>
        </>
      ) : (
        <>
          <td className="px-2 py-1.5 text-right text-muted">—</td>
          <td className="num px-2 py-1.5 text-right">{f(s.difference?.diff, 4)}</td>
          <td className="num px-2 py-1.5 text-right text-muted">{ci(s.difference?.ci95, 3)}</td>
          <td className="px-2 py-1.5 text-right text-muted">—</td><td className="px-2 py-1.5 text-right text-muted">—</td>
        </>
      )}
    </>
  );
}

export function SignalBacktestBody({ expiry }: { expiry: string | null }) {
  const [sessions, setSessions] = useState(15);
  const [cost, setCost] = useState(5);
  const q = useQuery({ queryKey: ["backtest", expiry, sessions, cost], queryFn: () => api.intradayBacktest(expiry!, sessions, cost), enabled: !!expiry, staleTime: 120_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading (the test reads every stored chain of the sessions: it can take a while)" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The backtest could not be run: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const d = q.data;
  const th = "px-2 py-1.5 text-right font-normal";
  return (
    <div className="flex flex-col gap-3" data-testid="bt-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span>Expiry {d.expiry} · {d.sessions.length} stored sessions · {d.snapshots} five-minute snapshots · horizon {d.horizon_minutes} min · last {Math.round(d.oos_share * 100)}% of sessions out-of-sample</span>
          <label className="flex items-center gap-1">Sessions<select aria-label="Sessions" value={sessions} onChange={(e) => setSessions(Number(e.target.value))} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-1 text-paper">{[5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="flex items-center gap-1">Round-trip cost (bps of NIFTY)<select aria-label="Cost" value={cost} onChange={(e) => setCost(Number(e.target.value))} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-1 text-paper">{[0, 2, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        <p className="mt-2 text-xs text-warn" data-testid="bt-note">{d.note}</p>
        {d.status !== "ok" && <p className="mt-2 text-sm text-muted" data-testid="bt-empty">{d.status}.</p>}
      </div>
      {d.tests.length > 0 && (
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-xs" data-testid="bt-table">
              <thead>
                <tr className="text-[11px] text-muted"><th rowSpan={2} className="px-2 py-1.5 text-left font-normal">Hypothesis (fixed rule)</th><th colSpan={6} className="border-l border-rule/50 px-2 py-1 text-center font-normal">Out-of-sample (the result)</th><th colSpan={6} className="border-l border-rule/50 px-2 py-1 text-center font-normal">In-sample (description only)</th></tr>
                <tr className="text-[11px] text-muted">{[0, 1].map((k) => ["Events / others", "Win rate", "Mean net return or difference", "95% interval", "Max drawdown", "Risk/reward"].map((h) => <th key={`${k}${h}`} className={th}>{h}</th>))}</tr>
              </thead>
              <tbody>
                {d.tests.map((t) => (
                  <tr key={t.id} className="border-t border-rule/50 align-top" data-testid="bt-row">
                    <td className="px-2 py-1.5 text-left"><div className="text-paper">{t.title}</div><div className="text-[11px] text-muted">{t.rule}</div>{t.status !== "ok" && <div className="text-[11px] text-warn" data-testid="bt-status">{t.status}</div>}</td>
                    <Side s={t.out_of_sample} directional={t.side !== 0} /><Side s={t.in_sample} directional={t.side !== 0} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted">Returns are percent of NIFTY. A row with fewer than {d.min_events} out-of-sample events is marked insufficient: its numbers are shown but do not support a conclusion.</p>
        </div>
      )}
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Not testable with the data stored today</h2>
        <ul className="list-disc pl-5 text-xs text-muted" data-testid="bt-untestable">{d.not_testable.map((n) => <li key={n.id}><span className="text-paper">{n.title}</span>: {n.reason}</li>)}</ul>
        <MethodologyPanel metrics={[METRICS.backtest_construction!, METRICS.backtest_metrics!]} example={backtestExample(d.tests)}
          freshness={{ updatedAt: d.sessions.length ? d.sessions[d.sessions.length - 1]! : null, session: d.sessions.length ? `${d.sessions[0]} to ${d.sessions[d.sessions.length - 1]}` : null, expiry: d.expiry, used: d.snapshots, missing: null, timeframe: `5-minute snapshots, ${d.horizon_minutes}-minute forward window, cost ${d.cost_bps} bps` }} />
      </div>
    </div>
  );
}
