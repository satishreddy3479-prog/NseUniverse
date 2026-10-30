import { ConeBar, DotTimeline, GainBars, HitInterval, ModelDots, PairBar, ReliabilityPlot, ReturnBars, readingLines } from "../components/PredictionViz";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Panel } from "../components/ui";
import { MiniBar } from "../components/viz";
import { EventsNewsPanel } from "../components/EventsNewsPanel";
import { CashPanel } from "../components/CashPanel";
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

/** The line under the headline: the leading side of the forecast, written for this horizon and target date. */
export function chanceText(hz: "T1" | "T5", pUp: number, base: number, close: number, target: string | null, model: string): { number: string; text: string } {
  const up = pUp >= 0.5, lead = up ? pUp : 1 - pUp;
  const dt = target ? new Date(`${target}T00:00:00Z`) : null;
  const day = dt ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()]} ${dt.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getUTCMonth()]}` : null;
  const level = `₹${Math.round(close).toLocaleString("en-IN")}`;
  const when = hz === "T1" ? (day ? `on ${day}` : "next session") : (day ? `on ${day}` : "in 5 sessions");
  const what = up ? `NIFTY 50 closes above ${level} ${when}` : `NIFTY 50 does not close above ${level} ${when}`;
  const coin = Math.abs(pUp - 0.5) < 0.05 ? " · close to a coin flip" : "";
  const vs = ` · history says ${pct(base)} of the time it rises`;
  return { number: pct(lead), text: `chance ${what} · ${model} (calibrated)${vs}${coin}` };
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

type Busy = { mine: boolean; other: boolean; since: string | null; waiting: boolean };

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return null;
  const sec = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return <span className="num ml-1 tabular-nums">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}</span>;
}

function ComputeBar({ hz, runs, busy, onCompute }: { hz: "T1" | "T5"; runs: PredictionSummaryReady["runs"]; busy: Busy; onCompute: () => void }) {
  const r = runs?.[hz];
  const pill = "rounded-md border border-rule bg-ink/60 px-2.5 py-1";
  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-2.5 text-xs text-muted" data-testid={`compute-${hz}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy.mine || busy.other} onClick={onCompute} title="Retrain this model now with the data stored so far (allowed in market hours too)"
          className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-ink shadow-md transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
          <span aria-hidden="true" className={busy.mine ? "inline-block animate-spin" : "inline-block"}>⟳</span>
          {busy.mine ? <>Computing…<Elapsed since={busy.since} /></> : "Compute now"}
        </button>
        <span className={pill}>Last automatic run: <span className="num ml-1 text-paper">{r?.last_auto ? fmtDateTimeIST(r.last_auto.at) : "none yet"}</span></span>
        <span className={pill}>Last manual run: <span className="num ml-1 text-paper">{r?.last_manual ? fmtDateTimeIST(r.last_manual.at) : "none yet"}</span></span>
      </div>
      {busy.mine && <p className="mt-2" data-testid={`compute-note-${hz}`}>Training runs on the server and takes a few minutes. The numbers below stay as they were until it finishes; this page updates by itself.</p>}
      {!busy.mine && busy.other && <p className="mt-2">The other horizon is training; only one training runs at a time, so this button is back when it finishes.</p>}
      {!busy.mine && !busy.other && busy.waiting && <p className="mt-2" data-testid={`compute-wait-${hz}`}>New input data is still arriving; the models retrain automatically once it has stopped changing. Showing the previous report.</p>}
    </div>
  );
}

function ForecastCard({ hz, f, evs, runs, busy, onCompute }: { hz: "T1" | "T5"; f: PredictionSummaryReady["forecasts"]["T1"]; evs: Record<Hz, HorizonEval>; runs: PredictionSummaryReady["runs"]; busy: Busy; onCompute: () => void }) {
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
      <ComputeBar hz={hz} runs={runs} busy={busy} onCompute={onCompute} />
      <p className="text-sm text-muted">{m ? `From the ${m.reference_session} close (₹${fmtPrice(m.reference_close)}). ${m.target_session ? `Target: ${m.target_session}` : m.reason ?? ""}` : "No forecast available."}</p>
      <p className="mt-1 text-xs text-muted">{SUB[hz]}</p>
      {preview && <p className="mt-2 rounded-lg border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`preview-${hz}`}>{m?.reason}. The number below is a preview and is not recorded.</p>}
      {p ? (
        <>
          <p className={`mt-3 font-mono text-3xl font-bold tracking-tight ${leanTone}`}>{lean}</p>
          <p className="mb-2 text-sm text-muted" data-testid={`chance-${hz}`}>{(() => { const c = chanceText(hz, p.p_up_model, p.p_up_climatology, m!.reference_close, m!.target_session ?? null, label(head!)); return <><span className="num font-mono text-xl font-semibold text-paper">{c.number}</span> {c.text}</>; })()}</p>
          <SplitBar p={p.p_up_model} base={p.p_up_climatology} />
          <div className="mt-3 rounded-xl border border-info/30 bg-info/5 p-3" data-testid={`reading-${hz}`}>
            <p className={MONO}>Reading of this forecast</p>
            <ul className="mt-1 space-y-1 text-sm text-paper">
              {readingLines({ horizon: hz, model: head!, p: p.p_up_model, base: p.p_up_climatology, models: entries.filter(([, mf]) => mf.payload).map(([n, mf]) => ({ name: n, p: mf.payload!.p_up_model })), target: m!.target_session ?? null,
                call: f.calls ? { call: f.calls.call, reason: f.calls.reason } : null, close: m!.reference_close, q: q ?? null, events: (p.event_risk ?? []).map((e) => e.name) }).map((t) => <li key={t} className="flex gap-2"><span aria-hidden="true" className="text-info">▸</span><span>{t}</span></li>)}
            </ul>
          </div>
          {f.calls && <div className="mt-3"><CallBanner calls={f.calls} hz={hz} /></div>}
          {p.event_risk && p.event_risk.length > 0 && (
            <p className="mt-2 rounded-lg border border-warn/50 px-3 py-1.5 text-sm text-warn" data-testid={`event-risk-${hz}`}>
              Event risk before the target close: {p.event_risk.map((e) => `${e.name} (${new Date(e.start_ist).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: e.all_day ? undefined : "2-digit", minute: e.all_day ? undefined : "2-digit" })}${e.all_day ? ", all day" : " IST"})`).join("; ")}.
            </p>
          )}
          <p className="mt-3 text-sm text-muted">{VERDICT[evOf(head!)].text}</p>
          {q && (
            <div className="mt-3 rounded-xl border border-rule bg-ink/40 p-3"><p className={MONO}>Where the close could land (history)</p><ConeBar close={m!.reference_close} q={q} /></div>
          )}
          {q && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Cone title="50% range (unconditional)" lo={q["0.25"]!} hi={q["0.75"]!} close={m!.reference_close} />
              <Cone title="90% range (unconditional)" lo={q["0.05"]!} hi={q["0.95"]!} close={m!.reference_close} />
            </div>
          )}
          <p className="mt-1 font-mono text-[11px] text-muted">Ranges come from the last 750 realised {hz === "T1" ? "1-day" : "5-day"} returns; they are not model-specific.</p>
          <div className="mt-4 rounded-xl border border-rule bg-ink/40 p-3"><p className={MONO}>Models against the base rate</p><ModelDots models={entries.map(([n, mf]) => ({ name: n, p: mf.payload?.p_up_model ?? null }))} base={p.p_up_climatology} head={head} /></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
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

type Tile = { label: string; value: string; sub?: string; tone?: "up" | "down" | "warn"; bar?: { v: number | undefined; scale: number }; hit?: number; base?: number };
const TONE = { up: "text-up", down: "text-down", warn: "text-warn" } as const;
const sg = (v: number | undefined, d = 2) => (v == null ? "—" : sgn(v, d));
const tn = (v: number | undefined): Tile["tone"] => (v == null || v === 0 ? undefined : v > 0 ? "up" : "down");

/** What the models are looking at right now (values from the same rows the models use). */
function InputsPanel({ inputs, last }: { inputs: PredictionSummaryReady["data"]["inputs"]; last: string }) {
  const a = inputs?.T1 ?? {}, b = inputs?.T5 ?? {};
  if (!inputs?.T1) {
    return (
      <section aria-label="Model inputs" className={`${CARD} p-4`} data-testid="inputs-missing">
        <p className={MONO}>Model inputs</p>
        <p className="mt-1 text-sm text-muted">The stored report does not contain the input snapshot yet; it is recomputed automatically (about a minute). Refresh shortly.</p>
      </section>
    );
  }
  const tiles: Tile[] = [
    { label: "NIFTY 1D / 5D", value: `${sg(a.nifty_ret_1d)} / ${sg(a.nifty_ret_5d)}`, sub: `20D ${sg(b.nifty_ret_20d)}`, tone: tn(a.nifty_ret_1d), bar: { v: a.nifty_ret_1d, scale: 0.02 } },
    { label: "Trend vs 20D / 50D avg", value: `${sg(a.nifty_dist_sma20)} / ${sg(b.nifty_dist_sma50)}`, sub: `60D drawdown ${sg(b.nifty_drawdown_60d)}`, tone: tn(a.nifty_dist_sma20), bar: { v: a.nifty_dist_sma20, scale: 0.04 } },
    { label: "India VIX (level / 1D)", value: a.indiavix_ln != null ? `${Math.exp(a.indiavix_ln).toFixed(2)} / ${sg(a.indiavix_chg_1d)}` : "—", sub: `vs 60D avg ${sg(b.indiavix_vs_60d)}`, tone: a.indiavix_chg_1d != null && a.indiavix_chg_1d > 0 ? "down" : "up" },
    { label: "Sectors above 20D avg", value: b.sectors_above_sma20 != null ? `${b.sectors_above_sma20} of 8` : "—", sub: "bank, IT, auto, pharma, FMCG, metal, energy, realty", tone: b.sectors_above_sma20 == null ? undefined : b.sectors_above_sma20 >= 5 ? "up" : b.sectors_above_sma20 <= 3 ? "down" : "warn" },
    { label: "S&P 500 / Nasdaq (last US close)", value: `${sg(a.spx_ret)} / ${sg(a.ndx_ret)}`, sub: `S&P 5D ${sg(b.spx_ret_5d)}`, tone: tn(a.spx_ret), bar: { v: a.spx_ret, scale: 0.02 } },
    { label: "US VIX (level / change)", value: a.usvix_ln != null ? `${Math.exp(a.usvix_ln).toFixed(1)} / ${sg(a.usvix_chg)}` : "—", tone: a.usvix_chg != null && a.usvix_chg > 0 ? "down" : "up" },
    { label: "Brent crude / Gold", value: `${sg(a.brent_ret)} / ${sg(a.gold_ret)}`, sub: `Brent 20D ${sg(b.brent_ret_20d)}`, tone: tn(a.gold_ret), bar: { v: a.brent_ret, scale: 0.03 } },
    { label: "USD/INR · Dollar index", value: `${sg(a.usdinr_ret)} · ${sg(a.dxy_ret)}`, sub: `USD/INR 20D ${sg(b.usdinr_ret_20d)}`, tone: a.usdinr_ret != null && a.usdinr_ret > 0 ? "down" : "up" },
    { label: "US 10Y yield change (pts)", value: a.ust10y_chg != null ? `${a.ust10y_chg >= 0 ? "+" : "−"}${Math.abs(a.ust10y_chg).toFixed(2)}` : "—", sub: `5D ${b.ust10y_chg_5d != null ? b.ust10y_chg_5d.toFixed(2) : "—"}`, tone: a.ust10y_chg != null && a.ust10y_chg > 0 ? "down" : "up" },
    { label: "Asia: Nikkei / Hang Seng", value: `${sg(a.n225_ret)} / ${sg(a.hsi_ret)}`, tone: tn(a.n225_ret), bar: { v: a.n225_ret, scale: 0.02 } },
    { label: "Europe: DAX / FTSE", value: `${sg(a.dax_ret)} / ${sg(a.ftse_ret)}`, tone: tn(a.dax_ret), bar: { v: a.dax_ret, scale: 0.02 } },
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
            {t.bar && <div className="mt-1.5"><MiniBar value={t.bar.v ?? null} scale={t.bar.scale} className="w-full" /></div>}
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
    { label: "T+1 holdout hit rate", value: a ? pct(a.hit) : "—", sub: t1.calls?.hit != null ? `confident calls ${pct(t1.calls.hit)} on ${pct(t1.calls.coverage, 0)} of days` : undefined, tone: a && a.hit > 0.55 ? "up" : undefined, hit: a?.hit, base: t1.base?.up_rate_holdout },
    { label: "T+5 holdout hit rate", value: b ? pct(b.hit) : "—", sub: "always-up baseline " + (t5.base ? pct(t5.base.up_rate_holdout) : "—"), hit: b?.hit, base: t5.base?.up_rate_holdout },
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
          {t.hit != null && <div className="relative mt-2 h-1.5 rounded-full bg-rule/60" aria-hidden="true"><div className="absolute inset-y-0 left-0 rounded-full bg-info" style={{ width: `${t.hit * 100}%` }} />{t.base != null && <div className="absolute -inset-y-0.5 w-0.5 bg-paper" style={{ left: `${t.base * 100}%` }} />}</div>}
        </div>
      ))}
    </div>
  );
}

/** Every forecast day, including the ones that could not be recorded and why. A missed day keeps its number as a
 *  preview: shown with the outcome for learning, never counted in the forward test. */
function DayLogPanel({ days }: { days: NonNullable<PredictionSummaryReady["days"]> }) {
  return (
    <Panel title="Daily forward-test log — every forecast day, recorded or missed">
      {days.length > 0 && (() => {
        const asc = [...days].sort((a, b) => (a.target_session < b.target_session ? -1 : 1));
        const state = (d: (typeof days)[number]) => (d.status !== "recorded" ? "missed" as const : d.p_up == null || !d.actual ? "pending" as const : d.p_up > 0.5 === d.actual.positive ? "right" as const : "wrong" as const);
        const st = asc.map(state);
        const rec = asc.filter((d) => d.status === "recorded").length, right = st.filter((x) => x === "right").length, resolved = st.filter((x) => x === "right" || x === "wrong").length;
        return (
          <div className="mb-3 space-y-2 rounded-xl border border-rule bg-ink/40 p-3" data-testid="daylog-summary">
            <DotTimeline days={asc.map((d, i) => ({ label: `${d.target_session} ${d.horizon}`, state: st[i]!, counted: d.counts_in_forward_test }))} />
            <p className="num text-xs text-muted">{rec} of {asc.length} forecast days recorded · {resolved === 0 ? "none resolved yet" : `${right} of ${resolved} resolved were right`} · <span className="text-up">●</span> right <span className="text-down">●</span> wrong <span>●</span> pending <span className="text-warn">○</span> not recorded</p>
          </div>
        );
      })()}
      {days.length === 0 ? (
        <p className="text-sm text-muted" data-testid="daylog-empty">Nothing logged yet. Each weekday after 09:10 IST the page records whether the forecast was locked in the ledger and, if not, why.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Daily forward-test log">
            <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Target</th><th className="text-left font-normal">Horizon</th><th className="text-left font-normal">Status</th><th className="text-right font-normal">Said up</th><th className="text-right font-normal">Actual</th><th className="pl-4 text-left font-normal">Result</th><th className="pl-4 text-left font-normal">Why / note</th></tr></thead>
            <tbody>
              {days.map((d) => {
                const right = d.p_up == null || !d.actual ? null : d.p_up > 0.5 === d.actual.positive;
                return (
                  <tr key={`${d.horizon}-${d.target_session}`} className="num border-t border-rule/50" data-testid={`day-${d.horizon}-${d.target_session}`}>
                    <td>{d.target_session}</td><td>{d.horizon}</td>
                    <td className={d.status === "recorded" ? "text-up" : "text-warn"}>{d.status === "recorded" ? "Recorded" : "Not recorded"}</td>
                    <td className="text-right">{d.p_up == null ? "—" : `${pct(d.p_up)}${d.status === "recorded" ? "" : " (preview)"}`}</td>
                    <td className={`text-right ${d.actual ? (d.actual.positive ? "text-up" : "text-down") : ""}`}>{d.actual ? `${d.actual.positive ? "Up" : "Not up"} ${d.actual.return == null ? "" : sgn(d.actual.return)}` : "pending"}</td>
                    <td className={`pl-4 font-medium ${right == null ? "text-muted" : right ? "text-up" : "text-down"}`}>{right == null ? "—" : `${right ? "Right" : "Wrong"}${d.counts_in_forward_test ? "" : " · not counted"}`}</td>
                    <td className="pl-4 text-xs text-muted">{d.status === "recorded" ? "Locked before the open." : `${d.reason ?? "No forecast"}${d.stale.length ? ` Late series: ${d.stale.join(", ")}.` : ""}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">The forward test counts only forecasts locked before the outcome. A day that could not be locked stays in this log with its reason; its number is a preview and is never added to the scoreboard.</p>
    </Panel>
  );
}

function PostMortem({ rows }: { rows: (PredictionLedgerRow & { hz: "T1" | "T5" })[] }) {
  const done = rows.filter((r) => r.outcome && r.model === "ensemble").slice(0, 12);
  return (
    <Panel title="Post-mortem — what was right and wrong">
      {done.length === 0 ? (
        <p className="text-sm text-muted" data-testid="postmortem-empty">Nothing has resolved yet. After each target session closes, the ensemble forecast is compared with what happened here, with the inputs that pushed it at the time.</p>
      ) : (
        <>
        <div className="mb-3 rounded-xl border border-rule bg-ink/40 p-3">
          <p className="num mb-1 text-xs text-muted">{done.filter((r) => (r.p_up_model ?? 0.5) > 0.5 === r.outcome!.realized.positive).length} of {done.length} right · bar = what the market did, mark = whether the forecast pointed that way</p>
          <ReturnBars rows={[...done].reverse().map((r) => ({ label: r.target_session, ret: r.outcome!.realized.close_to_close ?? r.outcome!.realized.ret5 ?? 0, right: (r.p_up_model ?? 0.5) > 0.5 === r.outcome!.realized.positive }))} />
        </div>
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
        </>
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
        <div className="rounded-xl border border-rule bg-ink/40 p-3">
          <p className={MONO}>Gain over the base rate on the holdout (95% interval)</p>
          <GainBars rows={rows.map(([name, m]) => ({ name, gain: m.holdout.gain, lo: m.holdout.gain_ci95[0], hi: m.holdout.gain_ci95[1], head: name === ev.best_on_tuning }))} />
        </div>
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
        <div className="mt-2"><ReliabilityPlot bins={m.calibration} /></div>
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
                  <td className={`text-right ${s.brier < s.brier_base ? "text-up" : "text-down"}`}>{num(s.brier)}<PairBar model={s.brier} base={s.brier_base} /></td><td className="text-right text-muted">{num(s.brier_base)}</td>
                  <td className="text-right">{pct(s.hit)} <span className="text-muted">({pct(s.hit_ci[0])}–{pct(s.hit_ci[1])})</span><HitInterval hit={s.hit} ci={s.hit_ci as [number, number]} /></td>
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
              <td>{label(r.model)} v{r.model_version}</td><td>{r.reference_session}</td><td>{r.target_session}</td><td className="text-right"><span className="mr-2">{pct(r.p_up_model)}</span><span aria-hidden="true" className="relative inline-block h-1.5 w-14 rounded-full bg-down/50 align-middle"><span className="absolute inset-y-0 left-0 rounded-full bg-up" style={{ width: `${(r.p_up_model ?? 0) * 100}%` }} /></span></td>
              <td className="text-right">{r.outcome ? <span className={`rounded-full border px-2 py-0.5 text-xs ${r.outcome.realized.positive ? "border-up/50 bg-up/10 text-up" : "border-down/50 bg-down/10 text-down"}`}>{`${r.outcome.realized.positive ? "Up" : "Not up"} ${sgn(r.outcome.realized.close_to_close ?? r.outcome.realized.ret5 ?? 0)}`}</span> : <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-muted">pending</span>}</td>
              <td className={`pl-4 ${r.intact ? "text-up" : "text-down"}`}>{r.intact ? "Yes" : "ALTERED"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Prediction() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["prediction-summary"], queryFn: api.predictionSummary, retry: false, staleTime: 60_000,
    refetchInterval: (query) => { const d = query.state.data; return d && d.computing ? 3000 : false; },
  });
  const compute = useMutation({ mutationFn: api.predictionRecompute, onSettled: () => void qc.invalidateQueries({ queryKey: ["prediction-summary"] }) });
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
                {(["T1", "T5"] as const).map((h) => {
                  const any = !!d.computing || compute.isPending;
                  const scope = d.computing ? d.computing_scope ?? "all" : compute.isPending ? (compute.variables ?? "all") : null;
                  const mine = any && (scope === "all" || scope === h);
                  return <ForecastCard key={h} hz={h} f={d.forecasts[h]} evs={evs} runs={d.runs} busy={{ mine, other: any && !mine, since: d.computing_since ?? null, waiting: !!d.waiting_for_data }} onCompute={() => compute.mutate(h)} />;
                })}
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
              <DayLogPanel days={d.days ?? []} />
              <ForwardPanel board={d.ledger.scoreboard} />
              <PostMortem rows={[...d.ledger.recent.T1.map((r) => ({ ...r, hz: "T1" as const })), ...d.ledger.recent.T5.map((r) => ({ ...r, hz: "T5" as const }))]} />
              <CashPanel />
              <FlowsPanel />
              <section aria-label="Models and data" className="rounded-xl border border-rule bg-slate px-4 py-3 text-sm" data-testid="models-data">
                <p className="text-muted">
                  Data: NIFTY 50 {d.data.first} to {d.data.last} ({d.data.bars} sessions) plus global, sector and NSE series. Computed {fmtDateTimeIST(d.computed_at)}. Models trained on the early half, scored on the later half ({d.evaluation.test_size}-session windows).
                </p>
                <p className="mt-1 text-muted">Not used by the models: {d.excluded_inputs.join("; ")}.</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-info">Show every model input</summary>
                  <p className="mt-2 text-xs text-muted">T+1 ({d.features.T1.version}): {d.features.T1.names.map((f) => f.replaceAll("_", " ")).join(", ")}.</p>
                  <p className="mt-2 text-xs text-muted">T+5 ({d.features.T5.version}): {d.features.T5.names.map((f) => f.replaceAll("_", " ")).join(", ")}.</p>
                </details>
              </section>
            </>
          );
        })()}
    </div>
  );
}
