import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Panel } from "../components/ui";
import { EventsNewsPanel } from "../components/EventsNewsPanel";
import { FlowsPanel } from "../components/FlowsPanel";
import { api } from "../lib/api";
import { fmtDateTimeIST, fmtPrice } from "../lib/format";
import type { CallStats, HorizonEval, ModelEval, PredictionLedgerRow, PredictionSummary, Verdict } from "../lib/types";

type PredictionSummaryReady = Extract<PredictionSummary, { ready: true }>;

const H = { T1: "T+1 · overnight model", T5: "T+5 · broad model", T5F: "T+5 · broad model with NSE positions" } as const;
type Hz = keyof typeof H;
const SUB = {
  T1: "Next session. Uses only what is known by 08:30 IST: the last Indian session, India VIX, the US, Europe and Asia closes, crude, gold, the dollar, USD/INR and the US 10-year yield.",
  T5: "Five sessions ahead. Adds NIFTY trend and volatility context, sector strength and breadth, and the 5-20 day trend of global markets, FX, crude and yields.",
  T5F: "Same as the broad model plus NSE F&O participant positions (FII, DII, Pro, Client). Evaluated on its own, shorter history.",
} as const;

export const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const sgn = (v: number, d = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(d)}%`;
const num = (v: number, d = 4) => v.toFixed(d);
const label = (m: string) => m.replace("-", " ");

export const VERDICT: Record<Verdict, { badge: string; text: string; cls: string }> = {
  better: { badge: "Edge confirmed", cls: "border-up/60 bg-up/15 text-up", text: "Beat the base rate on the untouched holdout, even after allowing for every model and horizon tried." },
  promising: { badge: "Promising, unconfirmed", cls: "border-warn/60 bg-warn/15 text-warn", text: "Beat the base rate at the usual 95% level, but not after allowing for the number of models tried. Only the forward test can confirm it." },
  no_difference: { badge: "No edge shown", cls: "border-rule bg-rule/30 text-muted", text: "Statistically indistinguishable from just quoting the historical up-frequency." },
  worse: { badge: "Worse than base rate", cls: "border-down/60 bg-down/15 text-down", text: "Did worse than just quoting the historical up-frequency." },
};

export function verdictText(v: string | undefined) {
  return VERDICT[(v as Verdict) in VERDICT ? (v as Verdict) : "no_difference"];
}

function Badge({ v }: { v: Verdict }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${VERDICT[v].cls}`}>{VERDICT[v].badge}</span>;
}

/** Semicircle gauge: needle = the model's probability of closing up, tick = historical base rate. */
function Gauge({ p, base }: { p: number; base: number }) {
  const pt = (f: number, r: number) => {
    const a = Math.PI * (1 - f);
    return [100 + r * Math.cos(a), 100 - r * Math.sin(a)] as const;
  };
  const arc = (f1: number, f2: number, r: number) => {
    const [x1, y1] = pt(f1, r), [x2, y2] = pt(f2, r);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const [nx, ny] = pt(p, 62), [bx1, by1] = pt(base, 70), [bx2, by2] = pt(base, 90);
  return (
    <svg viewBox="0 0 200 112" className="mx-auto w-full max-w-[280px]" role="img" aria-label={`Probability of closing up ${pct(p)}; base rate ${pct(base)}`}>
      <defs>
        <linearGradient id="gaugeGrad" x1="0" x2="1">
          <stop offset="0" stopColor="var(--down)" /><stop offset="0.5" stopColor="var(--warn)" /><stop offset="1" stopColor="var(--up)" />
        </linearGradient>
      </defs>
      <path d={arc(0, 1, 80)} stroke="var(--rule)" strokeWidth="14" fill="none" strokeLinecap="round" />
      <path d={arc(0, 1, 80)} stroke="url(#gaugeGrad)" strokeWidth="14" fill="none" strokeLinecap="round" opacity="0.85" />
      <line x1={bx1} y1={by1} x2={bx2} y2={by2} stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" />
      <line x1="100" y1="100" x2={nx} y2={ny} stroke="var(--paper)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="100" cy="100" r="6" fill="var(--paper)" />
      <text x="14" y="110" fontSize="8" fill="var(--muted)">0%</text>
      <text x="92" y="14" fontSize="8" fill="var(--muted)">50%</text>
      <text x="172" y="110" fontSize="8" fill="var(--muted)">100%</text>
    </svg>
  );
}

function RangeBar({ close, q }: { close: number; q: Record<string, number> }) {
  const lo = q["0.05"]!, hi = q["0.95"]!, a = q["0.25"]!, b = q["0.75"]!;
  const span = Math.max(Math.abs(lo), Math.abs(hi)) * 1.1;
  const x = (v: number) => 50 + (v / span) * 50;
  return (
    <div>
      <svg viewBox="0 0 100 14" className="w-full" role="img" aria-label="Typical return range">
        <rect x={x(lo)} y="4" width={x(hi) - x(lo)} height="6" rx="3" fill="var(--info)" opacity="0.35" />
        <rect x={x(a)} y="3" width={x(b) - x(a)} height="8" rx="4" fill="var(--accent)" opacity="0.85" />
        <line x1="50" x2="50" y1="0" y2="14" stroke="var(--paper)" strokeWidth="0.6" />
      </svg>
      <p className="num mt-1 text-sm">90%: {sgn(lo)} to {sgn(hi)} <span className="text-muted">({fmtPrice(close * (1 + lo))} – {fmtPrice(close * (1 + hi))})</span></p>
      <p className="num text-xs text-muted">50%: {sgn(a)} to {sgn(b)} · unconditional, last 750 sessions</p>
    </div>
  );
}

function CallBanner({ calls, hz }: { calls: NonNullable<PredictionSummaryReady["forecasts"]["T1"]["calls"]>; hz: Hz }) {
  const up = calls.call === "up", down = calls.call === "down";
  return (
    <div className={`rounded-sm border px-3 py-2 ${up ? "border-up/60 bg-up/10" : down ? "border-down/60 bg-down/10" : "border-rule bg-slate-2"}`} data-testid={`call-${hz}`}>
      <p className="text-base font-semibold">{up ? "Call: UP" : down ? "Call: DOWN" : "No call"} <span className="text-sm font-normal text-muted">— {calls.reason}</span></p>
      <p className="text-xs text-muted">A call is made only when the three base models agree and the signal is clearly away from the historical base rate.</p>
    </div>
  );
}

function ForecastCard({ hz, f, evs }: { hz: "T1" | "T5"; f: PredictionSummaryReady["forecasts"]["T1"]; evs: Record<Hz, HorizonEval> }) {
  const entries = Object.entries(f.models);
  const head = f.headline_model && f.models[f.headline_model] ? f.headline_model : entries[0]?.[0];
  const m = head ? f.models[head] : undefined;
  const p = m?.payload;
  const evOf = (name: string) => evs[name.endsWith("+flows") ? "T5F" : hz].models?.[name.replace("+flows", "")]?.holdout.verdict ?? "no_difference";
  const preview = m && !m.recorded && m.preview;
  return (
    <section aria-label={`Forecast ${H[hz]}`} className="flex-1 rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid={`forecast-${hz}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-paper">{H[hz]}</h2>
          <p className="text-sm text-muted">{m ? `From the ${m.reference_session} close (${fmtPrice(m.reference_close)}). ${m.target_session ? `Target: ${m.target_session}` : m.reason ?? ""}` : "No forecast available."}</p>
        </div>
        {head && <Badge v={evOf(head)} />}
      </div>
      <p className="mt-1 text-xs text-muted">{SUB[hz]}</p>
      {preview && <p className="mt-2 rounded-sm border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`preview-${hz}`}>{m?.reason}. The number below is a preview and is not recorded.</p>}
      {p ? (
        <>
          <Gauge p={p.p_up_model} base={p.p_up_climatology} />
          <p className="-mt-1 text-center">
            <span className="num bg-gradient-to-r from-accent to-info bg-clip-text text-4xl font-bold text-transparent">{pct(p.p_up_model)}</span>
            <span className="ml-2 text-sm text-muted">chance of closing up · {label(head!)} (calibrated)</span>
          </p>
          <p className="mt-1 text-center text-xs text-muted">Historical up-frequency {pct(p.p_up_climatology)} (last 750 sessions {pct(p.p_up_climatology_recent_750)}).</p>
          {f.calls && <div className="mt-3"><CallBanner calls={f.calls} hz={hz} /></div>}
          {p.event_risk && p.event_risk.length > 0 && (
            <p className="mt-2 rounded-sm border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`event-risk-${hz}`}>
              Event risk before the target close: {p.event_risk.map((e) => `${e.name} (${new Date(e.start_ist).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: e.all_day ? undefined : "2-digit", minute: e.all_day ? undefined : "2-digit" })}${e.all_day ? ", all day" : " IST"})`).join("; ")}.
            </p>
          )}
          <p className="mt-3 text-sm text-muted">{VERDICT[evOf(head!)].text}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {entries.map(([name, mf]) => {
              const mv = evOf(name);
              return (
                <div key={name} className={`rounded-sm border p-2 ${name === head ? "border-accent/70 bg-accent/10" : "border-rule bg-ink/40"}`} data-testid={`chip-${hz}-${name}`}>
                  <p className="text-xs text-muted">{label(name)}</p>
                  <p className="num text-lg font-semibold">{mf.payload ? pct(mf.payload.p_up_model) : "—"}</p>
                  <span className={`inline-block size-2 rounded-full ${mv === "better" ? "bg-up" : mv === "promising" ? "bg-warn" : mv === "worse" ? "bg-down" : "bg-muted"}`} title={VERDICT[mv].badge} />
                  <span className="ml-1 text-[11px] text-muted">{VERDICT[mv].badge}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-4"><RangeBar close={m!.reference_close} q={p.return_quantiles_climatological} /></div>
          {p.top_drivers.length > 0 && <p className="num mt-3 text-xs text-muted">Biggest inputs (logit all, log-odds): {p.top_drivers.map((d) => `${d.feature.replaceAll("_", " ")} ${d.log_odds >= 0 ? "+" : "−"}${Math.abs(d.log_odds).toFixed(3)}`).join(" · ")}</p>}
          <p className="mt-3 text-xs text-muted">{m!.recorded ? `Locked in the forward-test ledger before the target session opens (${m!.forecast_id}).` : `Not recorded: ${m!.reason ?? "unknown"}`}</p>
        </>
      ) : <p className="mt-3 text-sm text-muted">{m?.reason ?? "No forecast available."}</p>}
    </section>
  );
}

function CallsPanel({ c }: { c: CallStats }) {
  const v = c.verdict;
  return (
    <div className="rounded-sm border border-rule bg-ink/40 p-3 text-sm" data-testid="calls-stats">
      <p className="font-medium">Confident calls on the untouched holdout</p>
      {c.hit != null && c.hit_ci && c.always_up_hit != null && c.always_up_ci ? (
        <p className="num">
          {c.n_called} of {c.n_holdout} sessions ({pct(c.coverage)} coverage): right {pct(c.hit)} of the time ({pct(c.hit_ci[0])}–{pct(c.hit_ci[1])}); always guessing up on the same days: {pct(c.always_up_hit)} ({pct(c.always_up_ci[0])}–{pct(c.always_up_ci[1])}).{" "}
          <span className={v === "promising" ? "text-up" : "text-muted"}>{v === "promising" ? "Calls beat always-up (intervals do not overlap)." : "Calls did not beat always guessing up."}</span>
        </p>
      ) : <p className="text-muted">Only {c.n_called} confident calls in the holdout, too few to judge.</p>}
      <p className="text-xs text-muted">Rule: {c.rule}. The strength threshold was set on the tuning period only.</p>
    </div>
  );
}

function Leaderboard({ hz, ev, sel, onSel }: { hz: Hz; ev: HorizonEval; sel: string; onSel: (m: string) => void }) {
  if (!ev.available || !ev.models || !ev.base) return <Panel title={`Model comparison — ${H[hz]}`}><p className="text-sm text-muted" data-testid={`perf-${hz}-na`}>Not evaluated yet: {ev.reason}</p></Panel>;
  const rows = Object.entries(ev.models).sort((a, b) => b[1].holdout.gain - a[1].holdout.gain);
  return (
    <Panel title={`Model comparison — ${H[hz]} — untouched holdout ${ev.holdout_period?.[0]} → ${ev.holdout_period?.[1]}`}>
      <div className="space-y-3" data-testid={`perf-${hz}`}>
        <p className="text-sm text-muted">
          Settings and the probability calibration were fitted only on {ev.tuning_period?.[0]} → {ev.tuning_period?.[1]}; every figure below is from later data the tuning never saw ({rows[0]![1].holdout.n} predictions each).
          Base rate Brier: <span className="num text-paper">{num(ev.base.brier_holdout)}</span> (coin flip {num(ev.base.brier_coin_flip)}).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Metrics ${hz}`}>
            <thead className="text-xs text-muted">
              <tr><th className="text-left font-normal">Model</th><th className="text-left font-normal">Tuned setting</th><th className="text-right font-normal">Brier</th><th className="text-right font-normal">Gain vs base (95% interval)</th><th className="text-right font-normal">Hit rate</th><th className="text-right font-normal">Gain while tuning</th><th className="pl-4 text-left font-normal">Verdict</th></tr>
            </thead>
            <tbody>
              {rows.map(([name, m]) => (
                <tr key={name} className={`cursor-pointer border-t border-rule/50 hover:bg-accent/10 ${sel === name ? "bg-accent/10" : ""}`} onClick={() => onSel(name)}>
                  <td className="py-1.5 font-medium">{label(name)}{name === ev.best_on_tuning && <span className="ml-2 rounded-full bg-accent/20 px-1.5 text-[11px] text-accent">headline</span>}</td>
                  <td className="num text-muted">{m.params ? Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(", ") : "mean of two"}</td>
                  <td className="num text-right">{num(m.holdout.brier)}</td>
                  <td className="num text-right">{num(m.holdout.gain, 5)} <span className="text-muted">({num(m.holdout.gain_ci95[0], 5)} to {num(m.holdout.gain_ci95[1], 5)})</span></td>
                  <td className="num text-right">{pct(m.holdout.hit)}</td>
                  <td className="num text-right text-muted">{num(m.tuning.gain, 5)}</td>
                  <td className="pl-4"><Badge v={m.holdout.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">Gain = base-rate Brier minus model Brier (positive is better). {ev.method}. A model whose gain was larger while tuning than on the holdout was fitted to noise.</p>
        {ev.calls && <CallsPanel c={ev.calls} />}
        <ModelDetail hz={hz} name={sel in ev.models ? sel : rows[0]![0]} m={ev.models[sel in ev.models ? sel : rows[0]![0]]!} />
      </div>
    </Panel>
  );
}

function ModelDetail({ hz, name, m }: { hz: Hz; name: string; m: ModelEval }) {
  return (
    <div className="space-y-2 rounded-xl border border-rule bg-ink/40 p-3">
      <p className="text-sm font-medium">{label(name)}: {m.description}</p>
      <details>
        <summary className="cursor-pointer text-sm text-info">Reliability on the holdout (when it said X%, how often was it up?)</summary>
        <table className="mt-2 w-full text-sm" aria-label={`Calibration ${hz}`}>
          <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Said</th><th className="text-right font-normal">Cases</th><th className="text-right font-normal">Mean said</th><th className="text-right font-normal">Actually up</th></tr></thead>
          <tbody>{m.calibration.map((b) => (
            <tr key={b.low} className="num border-t border-rule/50"><td>{pct(b.low, 0)}–{pct(b.high, 0)}</td><td className="text-right">{b.n}</td><td className="text-right">{pct(b.predicted)}</td><td className="text-right">{pct(b.observed)}</td></tr>
          ))}</tbody>
        </table>
      </details>
      <details>
        <summary className="cursor-pointer text-sm text-info">By test window ({m.folds.length} windows)</summary>
        <table className="mt-2 w-full text-sm" aria-label={`Folds ${hz}`}>
          <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Window</th><th className="text-left font-normal">Phase</th><th className="text-right font-normal">Model Brier</th><th className="text-right font-normal">Base Brier</th></tr></thead>
          <tbody>{m.folds.map((f) => (
            <tr key={f.start} className={`num border-t border-rule/50 ${f.brier_model < f.brier_base ? "" : "text-muted"}`}><td>{f.start} → {f.end}</td><td>{f.phase}</td><td className="text-right">{num(f.brier_model)}</td><td className="text-right">{num(f.brier_base)}</td></tr>
          ))}</tbody>
        </table>
      </details>
    </div>
  );
}

function ForwardPanel({ board }: { board: PredictionSummaryReady["ledger"]["scoreboard"] }) {
  const rows = (["T1", "T5"] as const).flatMap((h) => Object.entries(board[h] ?? {}).map(([m, s]) => ({ h, m, s })));
  return (
    <Panel title="Forward scoreboard — real results of forecasts made before the outcome">
      {rows.length === 0 ? (
        <p className="text-sm text-muted" data-testid="forward-empty">No forecast has resolved yet. Each one is scored automatically after its target session closes; with few days the numbers say little, so read them only once dozens have accumulated.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Forward scoreboard">
            <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Horizon</th><th className="text-left font-normal">Model</th><th className="text-right font-normal">Resolved</th><th className="text-right font-normal">Brier</th><th className="text-right font-normal">Base-rate Brier</th><th className="text-right font-normal">Hit rate (95%)</th></tr></thead>
            <tbody>
              {rows.map(({ h, m, s }) => (
                <tr key={`${h}${m}`} className="num border-t border-rule/50">
                  <td>{h}</td><td>{label(m)}</td><td className="text-right">{s.n}</td>
                  <td className={`text-right ${s.brier < s.brier_base ? "text-up" : "text-down"}`}>{num(s.brier)}</td><td className="text-right text-muted">{num(s.brier_base)}</td>
                  <td className="text-right">{pct(s.hit)} <span className="text-muted">({pct(s.hit_ci[0])}–{pct(s.hit_ci[1])})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function LedgerTable({ hz, rows }: { hz: "T1" | "T5"; rows: PredictionLedgerRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted">{H[hz]}: nothing recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-sm font-medium">{H[hz]}</p>
      <table className="w-full text-sm" aria-label={`Ledger ${hz}`}>
        <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Model</th><th className="text-left font-normal">From</th><th className="text-left font-normal">Target</th><th className="text-right font-normal">Said up</th><th className="text-right font-normal">Result</th><th className="pl-4 text-left font-normal">Intact</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.forecast_id} className="num border-t border-rule/50">
              <td>{label(r.model)} v{r.model_version}</td><td>{r.reference_session}</td><td>{r.target_session}</td><td className="text-right">{pct(r.p_up_model)}</td>
              <td className="text-right">{r.outcome ? `${r.outcome.realized.positive ? "Up" : "Not up"} ${sgn(r.outcome.realized.close_to_close ?? r.outcome.realized.ret5 ?? 0)}` : <span className="text-muted">pending</span>}</td>
              <td className={`pl-4 ${r.intact ? "text-up" : "text-down"}`}>{r.intact ? "Yes" : "ALTERED"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Prediction() {
  const q = useQuery({
    queryKey: ["prediction-summary"], queryFn: api.predictionSummary, retry: false, staleTime: 60_000,
    refetchInterval: (query) => { const d = query.state.data; return d && !d.ready && d.computing ? 3000 : false; },
  });
  const [sel, setSel] = useState<Record<Hz, string>>({ T1: "", T5: "", T5F: "" });
  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Prediction</h1>
        <p className="mt-1 text-sm text-muted">Probability that NIFTY 50 closes up, judged against the plain historical up-frequency. Forecasts are recorded between 08:35 and 09:10 IST, once the overnight data is in. Research output, not trading advice.</p>
      </div>
      {q.isPending ? <p className="text-muted">Loading…</p>
        : q.error ? <p role="alert" className="text-sm text-down">Prediction is not available: {(q.error as Error).message}</p>
        : !q.data.ready ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="not-ready">
            {q.data.computing && <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
            <p className="text-sm text-muted">{q.data.reason}</p>
          </div>
        ) : (() => {
          const d = q.data;
          const evs = d.evaluation.horizons;
          const hzs: Hz[] = ["T1", "T5", "T5F"];
          return (
            <>
              <div className="flex flex-col gap-5 lg:flex-row">
                <ForecastCard hz="T1" f={d.forecasts.T1} evs={evs} />
                <ForecastCard hz="T5" f={d.forecasts.T5} evs={evs} />
              </div>
              <div className="flex flex-col gap-5">
                {hzs.map((h) => <Leaderboard key={h} hz={h} ev={evs[h]} sel={sel[h] || evs[h].best_on_tuning || ""} onSel={(m) => setSel((s) => ({ ...s, [h]: m }))} />)}
              </div>
              <Panel title="Forward-test ledger — forecasts locked before the outcome, never edited">
                <div className="space-y-4">
                  {(["T1", "T5"] as const).map((h) => <LedgerTable key={h} hz={h} rows={d.ledger.recent[h]} />)}
                  <p className="text-xs text-muted">Results fill in automatically after the target session closes and the price history is refreshed.</p>
                </div>
              </Panel>
              <EventsNewsPanel />
              <ForwardPanel board={d.ledger.scoreboard} />
              <FlowsPanel />
              <Panel title="Models and data">
                <div className="space-y-1 text-sm">
                  <p>Data: {d.data.symbol}; {d.data.bars} NIFTY 50 daily bars, {d.data.first} to {d.data.last}. Computed {fmtDateTimeIST(d.computed_at)} (version {d.model_version}).</p>
                  <p>Protocol: {d.evaluation.scheme}. First {d.evaluation.initial_train} sessions are training only; test windows of {d.evaluation.test_size}.</p>
                  <p className="text-muted">Not used yet: {d.excluded_inputs.join("; ")}.</p>
                  <p className="text-muted">T+1 inputs ({d.features.T1.version}): {d.features.T1.names.map((f) => f.replaceAll("_", " ")).join(", ")}.</p>
                  <p className="text-muted">T+5 inputs ({d.features.T5.version}): {d.features.T5.names.map((f) => f.replaceAll("_", " ")).join(", ")}.</p>
                </div>
              </Panel>
            </>
          );
        })()}
    </div>
  );
}
