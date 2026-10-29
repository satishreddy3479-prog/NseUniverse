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

const MONO = "font-mono text-[11px] uppercase tracking-wider text-muted";
const CARD = "rounded-2xl border border-rule bg-gradient-to-b from-slate-2/60 to-slate";

/** Probability split: up versus not-up, with the historical base rate marked. */
function SplitBar({ p, base }: { p: number; base: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between font-mono text-sm"><span className="text-up">Up: {pct(p)}</span><span className="text-down">Down: {pct(1 - p)}</span></div>
      <div className="relative h-3 overflow-hidden rounded-full bg-down" role="img" aria-label={`Probability of closing up ${pct(p)}; historical base rate ${pct(base)}`}>
        <div className="absolute inset-y-0 left-0 bg-up" style={{ width: `${p * 100}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-paper" style={{ left: `${base * 100}%` }} title={`Historical up-frequency ${pct(base)}`} />
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted">White tick = historical up-frequency {pct(base)}</p>
    </div>
  );
}

function Cone({ title, lo, hi, close }: { title: string; lo: number; hi: number; close: number }) {
  return (
    <div className="rounded-xl border border-rule bg-ink/50 p-3">
      <p className={MONO}>{title}</p>
      <p className="num mt-1 font-mono text-base font-semibold">₹{Math.round(close * (1 + lo)).toLocaleString("en-IN")} – ₹{Math.round(close * (1 + hi)).toLocaleString("en-IN")}</p>
      <p className="num font-mono text-[11px] text-muted">{sgn(lo)} to {sgn(hi)}</p>
    </div>
  );
}

function CallBanner({ calls, hz }: { calls: NonNullable<PredictionSummaryReady["forecasts"]["T1"]["calls"]>; hz: Hz }) {
  const up = calls.call === "up", down = calls.call === "down";
  return (
    <div className={`rounded-xl border px-3 py-2 ${up ? "border-up/60 bg-up/10" : down ? "border-down/60 bg-down/10" : "border-rule bg-ink/50"}`} data-testid={`call-${hz}`}>
      <p className="font-mono text-base font-bold">{up ? "CALL: UP" : down ? "CALL: DOWN" : "NO CALL"} <span className="text-sm font-normal text-muted">— {calls.reason}</span></p>
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
  const lean = !p ? "NO FORECAST" : p.p_up_model >= p.p_up_climatology + 0.03 ? "LEANING UP" : p.p_up_model <= p.p_up_climatology - 0.03 ? "LEANING DOWN" : "NEAR BASE RATE";
  const leanTone = lean === "LEANING UP" ? "text-up" : lean === "LEANING DOWN" ? "text-down" : "text-warn";
  const q = p?.return_quantiles_climatological;
  return (
    <section aria-label={`Forecast ${H[hz]}`} className={`flex-1 p-5 ${CARD}`} data-testid={`forecast-${hz}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-accent">{hz === "T1" ? "Horizon 1 · next session (T+1)" : "Horizon 2 · next 5 sessions (T+5)"}</span>
        {head && <Badge v={evOf(head)} />}
      </div>
      <h2 className="mt-2 text-lg font-semibold text-paper">{H[hz]}</h2>
      <p className="text-sm text-muted">{m ? `From the ${m.reference_session} close (₹${fmtPrice(m.reference_close)}). ${m.target_session ? `Target: ${m.target_session}` : m.reason ?? ""}` : "No forecast available."}</p>
      <p className="mt-1 text-xs text-muted">{SUB[hz]}</p>
      {preview && <p className="mt-2 rounded-lg border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`preview-${hz}`}>{m?.reason}. The number below is a preview and is not recorded.</p>}
      {p ? (
        <>
          <p className={`mt-3 font-mono text-3xl font-bold tracking-tight ${leanTone}`}>{lean}</p>
          <p className="mb-2 text-sm text-muted"><span className="num font-mono text-xl font-semibold text-paper">{pct(p.p_up_model)}</span> chance of closing up · {label(head!)} (calibrated)</p>
          <SplitBar p={p.p_up_model} base={p.p_up_climatology} />
          {f.calls && <div className="mt-3"><CallBanner calls={f.calls} hz={hz} /></div>}
          {p.event_risk && p.event_risk.length > 0 && (
            <p className="mt-2 rounded-lg border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`event-risk-${hz}`}>
              Event risk before the target close: {p.event_risk.map((e) => `${e.name} (${new Date(e.start_ist).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: e.all_day ? undefined : "2-digit", minute: e.all_day ? undefined : "2-digit" })}${e.all_day ? ", all day" : " IST"})`).join("; ")}.
            </p>
          )}
          <p className="mt-3 text-sm text-muted">{VERDICT[evOf(head!)].text}</p>
          {q && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Cone title="50% range (unconditional)" lo={q["0.25"]!} hi={q["0.75"]!} close={m!.reference_close} />
              <Cone title="90% range (unconditional)" lo={q["0.05"]!} hi={q["0.95"]!} close={m!.reference_close} />
            </div>
          )}
          <p className="mt-1 font-mono text-[11px] text-muted">Ranges come from the last 750 realised {hz === "T1" ? "1-day" : "5-day"} returns; they are not model-specific.</p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {entries.map(([name, mf]) => {
              const mv = evOf(name);
              return (
                <div key={name} className={`rounded-xl border p-2 ${name === head ? "border-accent/70 bg-accent/10" : "border-rule bg-ink/40"}`} data-testid={`chip-${hz}-${name}`}>
                  <p className={MONO}>{label(name)}</p>
                  <p className="num font-mono text-lg font-semibold">{mf.payload ? pct(mf.payload.p_up_model) : "—"}</p>
                  <span className={`inline-block size-2 rounded-full ${mv === "better" ? "bg-up" : mv === "promising" ? "bg-warn" : mv === "worse" ? "bg-down" : "bg-muted"}`} title={VERDICT[mv].badge} />
                  <span className="ml-1 text-[11px] text-muted">{VERDICT[mv].badge}</span>
                </div>
              );
            })}
          </div>
          {p.top_drivers.length > 0 && <p className="num mt-3 font-mono text-[11px] text-muted">BIGGEST INPUTS (logit all, log-odds): {p.top_drivers.map((d) => `${d.feature.replaceAll("_", " ")} ${d.log_odds >= 0 ? "+" : "−"}${Math.abs(d.log_odds).toFixed(3)}`).join(" · ")}</p>}
          <p className="mt-3 text-xs text-muted">{m!.recorded ? `Locked in the forward-test ledger before the target session opens (${m!.forecast_id}).` : `Not recorded: ${m!.reason ?? "unknown"}`}</p>
        </>
      ) : <p className="mt-3 text-sm text-muted">{m?.reason ?? "No forecast available."}</p>}
    </section>
  );
}

type Tile = { label: string; value: string; sub?: string; tone?: "up" | "down" | "warn" };
const TONE = { up: "text-up", down: "text-down", warn: "text-warn" } as const;
const sg = (v: number | undefined, d = 2) => (v == null ? "—" : sgn(v, d));
const tn = (v: number | undefined): Tile["tone"] => (v == null || v === 0 ? undefined : v > 0 ? "up" : "down");

/** What the models are looking at right now (values from the same rows the models use). */
function InputsPanel({ inputs, last }: { inputs: PredictionSummaryReady["data"]["inputs"]; last: string }) {
  const a = inputs?.T1 ?? {}, b = inputs?.T5 ?? {};
  const tiles: Tile[] = [
    { label: "NIFTY 1D / 5D", value: `${sg(a.nifty_ret_1d)} / ${sg(a.nifty_ret_5d)}`, sub: `20D ${sg(b.nifty_ret_20d)}`, tone: tn(a.nifty_ret_1d) },
    { label: "Trend vs 20D / 50D avg", value: `${sg(a.nifty_dist_sma20)} / ${sg(b.nifty_dist_sma50)}`, sub: `60D drawdown ${sg(b.nifty_drawdown_60d)}`, tone: tn(a.nifty_dist_sma20) },
    { label: "India VIX (level / 1D)", value: a.indiavix_ln != null ? `${Math.exp(a.indiavix_ln).toFixed(2)} / ${sg(a.indiavix_chg_1d)}` : "—", sub: `vs 60D avg ${sg(b.indiavix_vs_60d)}`, tone: a.indiavix_chg_1d != null && a.indiavix_chg_1d > 0 ? "down" : "up" },
    { label: "Sectors above 20D avg", value: b.sectors_above_sma20 != null ? `${b.sectors_above_sma20} of 8` : "—", sub: "bank, IT, auto, pharma, FMCG, metal, energy, realty", tone: b.sectors_above_sma20 == null ? undefined : b.sectors_above_sma20 >= 5 ? "up" : b.sectors_above_sma20 <= 3 ? "down" : "warn" },
    { label: "S&P 500 / Nasdaq (last US close)", value: `${sg(a.spx_ret)} / ${sg(a.ndx_ret)}`, sub: `S&P 5D ${sg(b.spx_ret_5d)}`, tone: tn(a.spx_ret) },
    { label: "US VIX (level / change)", value: a.usvix_ln != null ? `${Math.exp(a.usvix_ln).toFixed(1)} / ${sg(a.usvix_chg)}` : "—", tone: a.usvix_chg != null && a.usvix_chg > 0 ? "down" : "up" },
    { label: "Brent crude / Gold", value: `${sg(a.brent_ret)} / ${sg(a.gold_ret)}`, sub: `Brent 20D ${sg(b.brent_ret_20d)}`, tone: tn(a.gold_ret) },
    { label: "USD/INR · Dollar index", value: `${sg(a.usdinr_ret)} · ${sg(a.dxy_ret)}`, sub: `USD/INR 20D ${sg(b.usdinr_ret_20d)}`, tone: a.usdinr_ret != null && a.usdinr_ret > 0 ? "down" : "up" },
    { label: "US 10Y yield change (pts)", value: a.ust10y_chg != null ? `${a.ust10y_chg >= 0 ? "+" : "−"}${Math.abs(a.ust10y_chg).toFixed(2)}` : "—", sub: `5D ${b.ust10y_chg_5d != null ? b.ust10y_chg_5d.toFixed(2) : "—"}`, tone: a.ust10y_chg != null && a.ust10y_chg > 0 ? "down" : "up" },
    { label: "Asia: Nikkei / Hang Seng", value: `${sg(a.n225_ret)} / ${sg(a.hsi_ret)}`, tone: tn(a.n225_ret) },
    { label: "Europe: DAX / FTSE", value: `${sg(a.dax_ret)} / ${sg(a.ftse_ret)}`, tone: tn(a.dax_ret) },
    { label: "Today's gap / range", value: `${sg(a.nifty_gap_today)} / ${sg(a.nifty_range)}`, sub: "of the last session", tone: tn(a.nifty_gap_today) },
  ];
  return (
    <section aria-label="Model inputs" className={`${CARD} p-4`} data-testid="inputs-panel">
      <p className={MONO}>Model inputs · data up to {last}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-rule bg-ink/50 p-3">
            <p className={MONO}>{t.label}</p>
            <p className={`num mt-1 font-mono text-lg font-semibold ${t.tone ? TONE[t.tone] : ""}`}>{t.value}</p>
            {t.sub && <p className="num font-mono text-[11px] text-muted">{t.sub}</p>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Moves are the latest completed day (US and Europe: the session that closed before this morning). These are exactly the inputs the models see; nothing is added for display.</p>
    </section>
  );
}

function SummaryStrip({ d }: { d: PredictionSummaryReady }) {
  const t1 = d.evaluation.horizons.T1, t5 = d.evaluation.horizons.T5;
  const best = (e: HorizonEval) => (e.available && e.models && e.best_on_tuning ? e.models[e.best_on_tuning]?.holdout : undefined);
  const a = best(t1), b = best(t5);
  const tiles: Tile[] = [
    { label: "T+1 holdout hit rate", value: a ? pct(a.hit) : "—", sub: t1.calls?.hit != null ? `confident calls ${pct(t1.calls.hit)} on ${pct(t1.calls.coverage, 0)} of days` : undefined, tone: a && a.hit > 0.55 ? "up" : undefined },
    { label: "T+5 holdout hit rate", value: b ? pct(b.hit) : "—", sub: "always-up baseline " + (t5.base ? pct(t5.base.up_rate_holdout) : "—") },
    { label: "T+1 Brier skill vs base", value: a ? pct(a.skill, 2) : "—", sub: a ? `95% ${num(a.gain_ci95[0], 4)} to ${num(a.gain_ci95[1], 4)}` : undefined, tone: a && a.skill > 0 ? "up" : "warn" },
    { label: "Forward results so far", value: String(Object.values(d.ledger.scoreboard.T1).reduce((s, x) => s + x.n, 0)), sub: "resolved T+1 forecasts (all models)" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="summary-strip">
      {tiles.map((t) => (
        <div key={t.label} className={`${CARD} p-3`}>
          <p className={MONO}>{t.label}</p>
          <p className={`num mt-1 font-mono text-xl font-bold ${t.tone ? TONE[t.tone] : ""}`}>{t.value}</p>
          {t.sub && <p className="num font-mono text-[11px] text-muted">{t.sub}</p>}
        </div>
      ))}
    </div>
  );
}

function PostMortem({ rows }: { rows: (PredictionLedgerRow & { hz: "T1" | "T5" })[] }) {
  const done = rows.filter((r) => r.outcome && r.model === "ensemble").slice(0, 12);
  return (
    <Panel title="Post-mortem — what was right and wrong">
      {done.length === 0 ? (
        <p className="text-sm text-muted" data-testid="postmortem-empty">Nothing has resolved yet. After each target session closes, the ensemble forecast is compared with what happened here, with the inputs that pushed it at the time.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Post-mortem">
            <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Horizon</th><th className="text-left font-normal">Target</th><th className="text-right font-normal">Said up</th><th className="text-right font-normal">Actual</th><th className="pl-4 text-left font-normal">Verdict</th><th className="pl-4 text-left font-normal">Inputs that pushed it (not causes)</th></tr></thead>
            <tbody>
              {done.map((r) => {
                const up = r.outcome!.realized.positive;
                const right = (r.p_up_model ?? 0.5) > 0.5 === up;
                return (
                  <tr key={r.forecast_id} className="num border-t border-rule/50">
                    <td>{r.hz}</td><td>{r.target_session}</td><td className="text-right">{pct(r.p_up_model)}</td>
                    <td className={`text-right ${up ? "text-up" : "text-down"}`}>{up ? "Up" : "Not up"} {sgn(r.outcome!.realized.close_to_close ?? r.outcome!.realized.ret5 ?? 0)}</td>
                    <td className={`pl-4 font-medium ${right ? "text-up" : "text-down"}`}>{right ? "Right" : "Wrong"}</td>
                    <td className="pl-4 text-xs text-muted">{(r.drivers ?? []).slice(0, 3).map((d) => `${d.feature.replaceAll("_", " ")} ${d.log_odds >= 0 ? "+" : "−"}${Math.abs(d.log_odds).toFixed(2)}`).join(" · ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
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
        {q.data?.ready && (() => {
          const t1 = q.data.forecasts.T1.models[q.data.forecasts.T1.headline_model ?? ""] ?? Object.values(q.data.forecasts.T1.models)[0];
          const locked = !!t1?.recorded;
          return (
            <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-wider" data-testid="status-chips">
              <span className="rounded-md border border-accent/50 bg-accent/10 px-2 py-1 text-accent">NIFTY 50 · T+1 & T+5 forecast desk</span>
              <span className="rounded-md border border-info/40 px-2 py-1 text-info">For {t1?.target_session ?? "—"} · data up to {q.data.data.last}</span>
              <span className="rounded-md border border-info/40 px-2 py-1 text-info">Spot ₹{fmtPrice(q.data.data.reference_close)}</span>
              <span className={`rounded-md border px-2 py-1 ${locked ? "border-up/50 bg-up/10 text-up" : "border-warn/50 bg-warn/10 text-warn"}`}>{locked ? "Forecast locked in ledger" : "Preview · not recorded"}</span>
            </div>
          );
        })()}
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
              <SummaryStrip d={d} />
              <InputsPanel inputs={d.data.inputs} last={d.data.last} />
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
              <PostMortem rows={[...d.ledger.recent.T1.map((r) => ({ ...r, hz: "T1" as const })), ...d.ledger.recent.T5.map((r) => ({ ...r, hz: "T5" as const }))]} />
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
