import { Link } from "react-router-dom";
import { fmtTimeIST, MISSING } from "../../lib/format";
import type { Intelligence, MlDigest } from "../../lib/intelligence";

const f = (v: number | null | undefined, d = 4) => (v == null ? MISSING : v.toFixed(d));
const LABEL: Record<string, string> = { majority: "Majority class", momentum: "Momentum state", opening_range: "Opening-range state", vwap: "VWAP state", logistic: "Logistic model (all features)", logistic_price: "Logistic model (price only)" };

/** What the intraday model research is and where it stands. It is a research pipeline: it never feeds the sentiment score and shows no probability until its gate passes. */
export function IntradayMlPanel({ d }: { d: Intelligence }) {
  const ml: MlDigest | null | undefined = d.intraday_ml;
  if (!ml) {
    return <section aria-label="Intraday model" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="ml-panel">Intraday ML research: the research service did not answer, so nothing is shown. It is not part of the score.</section>;
  }
  const st = ml.status, ev = ml.last_evaluation, gate = ev?.gate;
  const rows = ev ? Object.entries(ev.models) : [];
  return (
    <section aria-label="Intraday model" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="ml-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Intraday ML model <span className="font-normal text-muted">· research only, not part of the sentiment score</span></h2>
        <Link to="/analysis" className="text-xs text-info hover:underline">Open the intraday analysis →</Link>
      </div>
      <p className="mt-1 text-xs text-muted" data-testid="ml-what">
        What it does: every finished session is turned into labelled rows (the state of price, options, volatility, futures flow, breadth and breakouts at each minute, and whether NIFTY next touched an up barrier, a down barrier or neither within 15 minutes). A regularised logistic model is then tested against simple baselines on <em>later</em> sessions only. No probability is shown anywhere until it beats the baselines on enough sessions with calibrated probabilities.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <div className="rounded-sm bg-slate-2 px-2.5 py-2"><div className="text-[11px] text-muted">Stage</div><div className="text-[15px] font-semibold text-paper" data-testid="ml-stage">{st.stage_name}</div><div className="text-[10px] text-muted">{st.next ? `next: ${st.next.name} at ${st.next.at_sessions} sessions (${st.next.sessions_to_go} to go)` : "final stage"}</div></div>
        <div className="rounded-sm bg-slate-2 px-2.5 py-2"><div className="text-[11px] text-muted">Labelled sessions</div><div className="num text-[15px] font-semibold text-paper">{st.labelled_sessions}</div><div className="text-[10px] text-muted">{st.complete_sessions} complete sessions stored</div></div>
        <div className="rounded-sm bg-slate-2 px-2.5 py-2"><div className="text-[11px] text-muted">Verdict</div><div className={`text-[15px] font-semibold ${gate?.show_probabilities ? "text-up" : "text-warn"}`} data-testid="ml-verdict">{ev ? (gate?.show_probabilities ? "Validated" : ev.status === "experimental" ? "Experimental" : "Insufficient data") : "Not evaluated yet"}</div><div className="text-[10px] text-muted">{gate?.show_probabilities ? "probabilities may be shown" : "no probability is shown"}</div></div>
        <div className="rounded-sm bg-slate-2 px-2.5 py-2"><div className="text-[11px] text-muted">Last evaluation</div><div className="num text-[15px] font-semibold text-paper">{ev ? fmtTimeIST(ev.computed_at) : MISSING}</div><div className="text-[10px] text-muted">{ml.computing ? "running now" : ml.next_run}</div></div>
      </div>
      {ev && rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[30rem] text-xs" data-testid="ml-table">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Model (horizon {ev.horizon_minutes} min, barrier {ev.barrier_k}×)</th><th className="py-1 text-right font-normal">Log loss (lower is better)</th><th className="py-1 text-right font-normal">Brier</th><th className="py-1 text-right font-normal">Calibration error</th><th className="py-1 text-right font-normal">Rows</th></tr></thead>
          <tbody>{rows.map(([k, m]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{LABEL[k] ?? k}</td><td className="num py-1 text-right">{f(m.log_loss)}</td><td className="num py-1 text-right">{f(m.brier)}</td><td className="num py-1 text-right">{f(m.ece, 3)}</td><td className="num py-1 text-right text-muted">{m.n ?? MISSING}</td></tr>)}</tbody></table>
          <p className="mt-1 text-xs text-muted" data-testid="ml-gain">Best baseline {f(ev.best_baseline_log_loss)}; the logistic model is {ev.model_log_loss_gain == null ? "not comparable" : ev.model_log_loss_gain > 0 ? `${f(ev.model_log_loss_gain)} better` : `${f(-ev.model_log_loss_gain)} worse`} per row, tested on {ev.test_sessions ?? 0} later session(s) of {ev.sessions ?? 0}. Rows within a session overlap, so the gate counts sessions, not rows.</p>
        </div>
      ) : <p className="mt-3 text-xs text-muted" data-testid="ml-none">{ev ? `The last evaluation had too little data: ${ev.reason ?? "no test predictions"}.` : `No evaluation has been stored yet. It runs once a session day after 15:45 IST, never in market hours.`}</p>}
      {gate && gate.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-warn" data-testid="ml-reasons">{gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {ev?.feature_groups && Object.keys(ev.feature_groups).length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid="ml-groups">Does each group add to price alone? (change in log loss; negative = helps): {Object.entries(ev.feature_groups).map(([g, v]) => `${g} ${v.delta_vs_price_only >= 0 ? "+" : "−"}${Math.abs(v.delta_vs_price_only).toFixed(4)}`).join(" · ")}.</p>
      )}
      <p className="mt-2 text-[11px] text-muted">Stages: {st.stages.map((s) => `${s.name} (${s.from_sessions}+ sessions)`).join(" → ")}. Until the last stage is reached and the gate passes, the intraday sentiment you see is rules-based, not machine learning.</p>
    </section>
  );
}
