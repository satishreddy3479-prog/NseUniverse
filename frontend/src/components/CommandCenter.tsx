// Market Sentiment Command Center (top of the Intraday analysis page).
// Shows only what /api/intraday/summary computed from stored observations. Every number carries its
// source and time; anything missing is shown as missing, and nothing here is an ML prediction.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { compactIN } from "../lib/analytics";
import { sentimentHistoryOption } from "../lib/chartOptions";
import { fmtDateTimeIST, fmtPct, fmtPrice, fmtTimeIST, MISSING } from "../lib/format";
import { useLiveSpot } from "../lib/useLive";
import type { IntradayComponent, IntradaySummary } from "../lib/types";
import { EChart, useChartColors } from "./EChart";

const PHASE: Record<string, string> = {
  closed: "Closed (no session today)", pre_market: "Pre-market", pre_open: "Pre-open (09:00–09:15)", opening: "Opening (09:15–09:45)",
  morning: "Morning", midday: "Midday", afternoon: "Afternoon", closing: "Closing (15:00–15:30)", post_market: "Post-market",
};
const MODE: Record<string, { text: string; cls: string }> = {
  live: { text: "Live samples", cls: "border-up/60 text-up" },
  delayed: { text: "Delayed", cls: "border-warn/60 text-warn" },
  stale: { text: "Stale", cls: "border-down/60 text-down" },
  historical: { text: "Last session (not live)", cls: "border-info/60 text-info" },
  unavailable: { text: "No data", cls: "border-rule text-muted" },
};
const HEALTH: Record<string, string> = {
  fresh: "text-up", delayed: "text-warn", stale: "text-down", historical: "text-info", warning: "text-warn",
  not_available: "text-muted", api_failure: "text-down", not_published: "text-muted", invalid: "text-down",
};
const HEALTH_LABEL: Record<string, string> = {
  fresh: "Fresh", delayed: "Delayed", stale: "Stale", historical: "Last session", warning: "Check",
  not_available: "Not available", api_failure: "Failed", not_published: "Not yet published", invalid: "Invalid",
};

function tone(v: number | null | undefined): string {
  if (v == null) return "text-muted";
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-paper";
}

function labelTone(label: string): string {
  if (label.includes("bullish") || label === "Bullish") return "text-up";
  if (label.includes("bearish") || label === "Bearish") return "text-down";
  if (label.includes("volatility")) return "text-warn";
  if (label === "Insufficient data") return "text-muted";
  return "text-info";
}

function Card({ title, children, right, className = "" }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`min-w-0 rounded-[var(--radius-panel)] border border-rule bg-slate ${className}`}>
      <header className="flex min-h-9 items-center justify-between gap-2 border-b border-rule px-3 py-1.5">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Chip({ children, cls = "border-rule text-muted", title }: { children: ReactNode; cls?: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

/** -1..+1 bar with a centre line; null renders as an empty track. */
export function ScoreBar({ value, label }: { value: number | null; label: string }) {
  const pct = value == null ? 0 : Math.min(1, Math.abs(value)) * 50;
  return (
    <div className="relative h-2.5 w-full rounded-sm bg-slate-2" role="meter" aria-label={label}
      aria-valuemin={-1} aria-valuemax={1} aria-valuenow={value ?? undefined} aria-valuetext={value == null ? "not available" : value.toFixed(2)}>
      <div className="absolute inset-y-0 left-1/2 w-px bg-muted/60" />
      {value != null && (
        <div className={`absolute inset-y-0 rounded-sm ${value >= 0 ? "bg-up" : "bg-down"}`}
          style={value >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }} />
      )}
    </div>
  );
}

function Stat({ label, value, sub, cls = "text-paper" }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num truncate text-sm font-semibold ${cls}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Header({ d }: { d: IntradaySummary }) {
  const ls = useLiveSpot();
  const live = ls.live && ls.ltp != null;
  const spot = live ? ls.ltp : d.price.last;
  const prev = d.price.prev_close;
  const chg = spot != null && prev ? spot - prev : null;
  const m = MODE[d.market.mode] ?? MODE.unavailable!;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-[var(--radius-panel)] border border-rule bg-slate p-3 sm:grid-cols-4 lg:grid-cols-8" data-testid="cc-header">
      <div className="col-span-2 min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
          NIFTY 50 <Chip cls={live ? "border-up/60 text-up" : m.cls}>{live ? "Live stream" : m.text}</Chip>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="num text-2xl font-semibold text-paper">{fmtPrice(spot)}</span>
          <span className={`num text-sm font-medium ${tone(chg)}`}>
            {chg == null ? MISSING : `${chg >= 0 ? "+" : "−"}${fmtPrice(Math.abs(chg))} (${fmtPct((chg / (prev as number)) * 100)})`}
          </span>
        </div>
        <div className="text-[11px] text-muted">
          {live ? "Kotak live tick" : d.price.last_at ? `Sampled ${fmtTimeIST(d.price.last_at)}` : "No sample today"} · prev close {fmtPrice(prev)}
        </div>
      </div>
      <Stat label="First sample" value={fmtPrice(d.price.first)} sub={d.price.first_at ? `${fmtTimeIST(d.price.first_at)} (not official open)` : "—"} />
      <Stat label="Sampled high / low" value={`${fmtPrice(d.price.sampled_high)} / ${fmtPrice(d.price.sampled_low)}`} sub={`${d.market.samples_today} samples today`} />
      <Stat label="Session" value={PHASE[d.market.phase] ?? d.market.phase} sub={d.market.calendar_note ?? `${d.market.date} · prev session ${d.market.prev_session ?? "—"}`} />
      <Stat label="Last stored sample" value={d.market.last_sample_at ? fmtTimeIST(d.market.last_sample_at) : MISSING}
        sub={d.market.age_seconds != null ? `${Math.round(d.market.age_seconds / 60)} min ago` : "none"} />
      <Stat label="Scoring" value="Rules v1 (provisional)" sub={d.assessment.version} />
      <Stat label="Intraday ML" value="Not trained" cls="text-muted" sub={`${d.ml.complete_sessions}/${d.ml.required_sessions} sessions`} />
    </div>
  );
}

function Sentiment({ d }: { d: IntradaySummary }) {
  const a = d.assessment;
  const missing = a.components.filter((c) => !c.available);
  return (
    <Card title="Current market sentiment" className="lg:col-span-5"
      right={<span className="text-[11px] text-muted">rules-based · not a forecast</span>}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className={`text-2xl font-semibold ${labelTone(a.label)}`} data-testid="cc-label">{a.label}</div>
        <div className="num text-sm text-muted">score <span className={`font-semibold ${tone(a.score)}`}>{a.score == null ? MISSING : a.score.toFixed(2)}</span> / ±1</div>
      </div>
      <div className="mt-2"><ScoreBar value={a.score} label="Sentiment score" /></div>
      <div className="mt-1 flex justify-between text-[10px] text-muted"><span>Bearish −1</span><span>0</span><span>+1 Bullish</span></div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Direction" value={a.direction} cls={a.direction === "Up" ? "text-up" : a.direction === "Down" ? "text-down" : "text-paper"} />
        <Stat label="Volatility" value={a.volatility} cls={a.volatility === "High" ? "text-warn" : "text-paper"} />
        <Stat label="Data coverage" value={`${Math.round(a.coverage * 100)}%`} sub={`min ${Math.round(d.config.min_coverage * 100)}%`} />
        <Stat label="Confidence" value="Not calibrated" cls="text-muted" sub="no validated model yet" />
      </dl>
      <div className="mt-2 h-1.5 w-full rounded-sm bg-slate-2" aria-hidden>
        <div className="h-full rounded-sm bg-info" style={{ width: `${Math.round(a.coverage * 100)}%` }} />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-paper" data-testid="cc-narrative">{d.narrative}</p>
      <p className="mt-1 text-xs text-muted">{a.volatility_detail}</p>
      {d.previous_score && (
        <p className="mt-2 text-xs text-muted">
          Previous stored score {d.previous_score.score == null ? MISSING : d.previous_score.score.toFixed(2)} at {fmtTimeIST(d.previous_score.sample_utc)}.
          {d.changes.length > 0 && <> Changed by: {d.changes.slice(0, 3).map((c) => `${c.component} ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)}`).join(", ")}.</>}
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-2 text-xs text-warn">Missing from the score: {missing.map((c) => c.name).join(", ")}.</p>
      )}
    </Card>
  );
}

function EvidenceRow({ c }: { c: IntradayComponent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-rule/60 last:border-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2 text-left sm:grid-cols-[minmax(0,12rem)_1fr_5rem_4rem]">
        <span className="truncate text-sm text-paper">{open ? "▾" : "▸"} {c.name}</span>
        <span className="text-right text-xs text-muted sm:hidden">{c.available ? (c.score ?? 0).toFixed(2) : "n/a"}</span>
        <span className="col-span-2 sm:col-span-1">{c.available ? <ScoreBar value={c.score} label={`${c.name} score`} /> : <span className="text-xs text-muted">Unavailable — {c.reason}</span>}</span>
        <span className={`num hidden text-right text-sm sm:block ${tone(c.score)}`}>{c.score == null ? "—" : c.score.toFixed(2)}</span>
        <span className="num hidden text-right text-xs text-muted sm:block">w {c.weight.toFixed(2)}</span>
      </button>
      {open && (
        <div className="mb-2 rounded-sm bg-slate-2 p-2 text-xs text-muted">
          {c.formula && <p><span className="text-paper">Calculation:</span> {c.formula}</p>}
          {c.source && <p className="mt-1"><span className="text-paper">Source:</span> {c.source}{c.as_of ? ` · as of ${c.as_of.length > 10 ? fmtDateTimeIST(c.as_of) : c.as_of}` : ""}</p>}
          {c.contribution != null && <p className="mt-1"><span className="text-paper">Contribution:</span> {c.contribution.toFixed(3)} (score × weight)</p>}
          {c.inputs.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {c.inputs.map((i) => (
                <li key={i.name}>{i.name}: <span className="num text-paper">{i.value == null ? MISSING : `${Math.abs(i.value) >= 1000 ? compactIN(i.value) : i.value.toFixed(2)}${i.unit === "%" ? "%" : i.unit ? ` ${i.unit}` : ""}`}</span>{i.session ? ` (${i.session})` : ""}{i.note ? ` — ${i.note}` : ""}</li>
              ))}
            </ul>
          )}
          {!c.available && <p className="mt-1 text-warn">Not scored: {c.reason}</p>}
        </div>
      )}
    </li>
  );
}

function Evidence({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Evidence breakdown" className="lg:col-span-7" right={<span className="text-[11px] text-muted">tap a row for formula, inputs and source</span>}>
      <ul data-testid="cc-evidence">{d.assessment.components.map((c) => <EvidenceRow key={c.key} c={c} />)}</ul>
      <p className="mt-2 text-[11px] text-muted">
        Correlated price measures form one group. Score = Σ(weight × group score) over available groups ÷ their weights. Weights are provisional, not fitted;
        volatility and events set the regime and flags, not the score.
      </p>
    </Card>
  );
}

function Regime({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Market regime & scenarios" className="lg:col-span-8" right={<span className="text-[11px] text-muted">observed now · possible later</span>}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted">Observed</span>
        <span className="text-base font-semibold text-paper" data-testid="cc-regime">{d.regime.primary}</span>
        {d.regime.tags.map((t) => <Chip key={t} cls="border-warn/50 text-warn">{t}</Chip>)}
      </div>
      <p className="mt-1 text-xs text-muted">{d.regime.reason}</p>
      {d.scenarios.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No scenarios: there is no current assessment to build them from.</p>
      ) : (
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {d.scenarios.map((s, i) => (
            <div key={s.name} className={`rounded-sm border p-2 ${i === 0 ? "border-brass/60" : "border-rule"} bg-slate-2`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm font-semibold ${s.name.startsWith("Bull") ? "text-up" : s.name.startsWith("Bear") ? "text-down" : "text-info"}`}>{s.name}</span>
                <span className="text-[10px] text-muted">{i === 0 ? "best fit now" : ""}</span>
              </div>
              <p className="text-[11px] text-muted">Probability: not estimated ({s.status}) · {s.horizon}</p>
              <p className="mt-1 text-xs"><span className="text-up">For:</span> {s.supporting.length ? s.supporting.join("; ") : "none"}</p>
              <p className="text-xs"><span className="text-down">Against:</span> {s.conflicting.length ? s.conflicting.join("; ") : "none"}</p>
              <p className="mt-1 text-xs text-paper">Strengthens: <span className="text-muted">{s.strengthens}</span></p>
              <p className="text-xs text-paper">Weakens: <span className="text-muted">{s.weakens}</span></p>
              <p className="num mt-1 text-[11px] text-muted">{Object.entries(s.levels).map(([k, v]) => `${k} ${fmtPrice(v)}`).join(" · ")}</p>
            </div>
          ))}
        </div>
      )}
      {d.scenarios_ruled_out.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted" data-testid="cc-ruled-out" aria-label="Scenarios ruled out">
          {d.scenarios_ruled_out.map((r) => (
            <li key={r.name}><span className="text-paper">Not shown: {r.name}</span> — {r.reason}.</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Context({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Intraday decision context" className="lg:col-span-4">
      <dl className="space-y-2">
        {d.context.map((c) => (
          <div key={c.question}>
            <dt className="text-xs font-semibold text-paper">{c.question}</dt>
            <dd className="text-xs text-muted">{c.answer}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Levels({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Key levels" className="lg:col-span-4">
      <table className="w-full text-xs">
        <tbody>
          {d.levels.map((l) => (
            <tr key={l.name} className="border-b border-rule/50 last:border-0" title={`${l.method}${l.source ? ` · ${l.source}` : ""}${l.as_of ? ` · ${l.as_of}` : ""}`}>
              <td className="py-1 pr-2 text-muted">{l.name}</td>
              <td className="num py-1 text-right text-paper">{l.value == null ? <span className="text-muted">n/a</span> : fmtPrice(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted">Hover a row for source, method and time. OI concentrations are positioning, not guaranteed support/resistance.</p>
    </Card>
  );
}

function Options({ d }: { d: IntradaySummary }) {
  const o = d.options;
  return (
    <Card title="Options positioning" className="lg:col-span-4" right={<span className="text-[11px] text-muted">{o.universe} · {d.expiry}</span>}>
      <dl className="grid grid-cols-2 gap-3">
        <Stat label="PCR (OI)" value={o.pcr_oi == null ? MISSING : o.pcr_oi.toFixed(2)} sub={o.pcr_oi_change == null ? "change: needs 2 samples" : `${o.pcr_oi_change >= 0 ? "+" : ""}${o.pcr_oi_change.toFixed(2)} since first sample`} />
        <Stat label="PCR (volume)" value={o.pcr_vol == null ? MISSING : o.pcr_vol.toFixed(2)} />
        <Stat label="Call OI chg vs prev day" value={compactIN(o.ce_oi_chg)} cls={tone(o.ce_oi_chg)} sub={`total ${compactIN(o.ce_oi)}`} />
        <Stat label="Put OI chg vs prev day" value={compactIN(o.pe_oi_chg)} cls={tone(o.pe_oi_chg)} sub={`total ${compactIN(o.pe_oi)}`} />
        <Stat label="ATM straddle" value={fmtPrice(o.straddle)} sub={o.straddle_change_pct == null ? `strike ${fmtPrice(o.atm_strike)}` : `${fmtPct(o.straddle_change_pct)} since first (incl. decay)`} />
        <Stat label="Largest OI strikes" value={`C ${o.max_ce_oi_strike ?? "—"} / P ${o.max_pe_oi_strike ?? "—"}`} />
      </dl>
      {(o.missing.oi ?? 0) > 0 && <p className="mt-2 text-[11px] text-warn">{o.missing.oi} contracts without OI were left out (not counted as 0).</p>}
      <p className="mt-2 text-[11px] text-muted">OI changes do not reveal whether traders bought or wrote options.</p>
    </Card>
  );
}

function Health({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Data coverage & warnings" className="lg:col-span-4">
      <ul className="space-y-1.5" data-testid="cc-health">
        {d.health.map((h) => (
          <li key={h.source} className="flex items-start justify-between gap-2 text-xs">
            <span className="min-w-0"><span className="text-paper">{h.source}</span><span className="block text-[11px] text-muted">{h.detail}</span></span>
            <span className={`shrink-0 font-semibold ${HEALTH[h.status] ?? "text-muted"}`}>{HEALTH_LABEL[h.status] ?? h.status}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Markets({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Global, sectors & flows" className="lg:col-span-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Last completed sessions</h4>
          <table className="w-full text-xs"><tbody>
            {d.global.map((g) => (
              <tr key={g.key} className="border-b border-rule/40 last:border-0">
                <td className="py-0.5 pr-2 text-muted">{g.name}</td>
                <td className={`num py-0.5 text-right ${tone(g.ret_pct)}`}>{fmtPct(g.ret_pct)}</td>
                <td className={`py-0.5 pl-2 text-right text-[10px] ${g.fresh ? "text-muted" : "text-warn"}`}>{g.session.slice(5)}</td>
              </tr>
            ))}
            {d.global.length === 0 && <tr><td className="text-muted">No stored global bars.</td></tr>}
          </tbody></table>
        </div>
        <div>
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Sectors (previous session, daily)</h4>
          <table className="w-full text-xs"><tbody>
            {d.sectors.rows.map((s) => (
              <tr key={s.key} className="border-b border-rule/40 last:border-0">
                <td className="py-0.5 pr-2 text-muted">{s.name}</td>
                <td className={`num py-0.5 text-right ${tone(s.ret_pct)}`}>{fmtPct(s.ret_pct)}</td>
              </tr>
            ))}
            {d.sectors.rows.length === 0 && <tr><td className="text-muted">No stored sector bars.</td></tr>}
          </tbody></table>
          <h4 className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-muted">FII / DII cash (official provisional)</h4>
          {d.institutional ? (
            <p className="num text-xs">
              <span className={tone(d.institutional.fii_net)}>FII {d.institutional.fii_net == null ? MISSING : `${d.institutional.fii_net.toFixed(0)} cr`}</span>
              {" · "}<span className={tone(d.institutional.dii_net)}>DII {d.institutional.dii_net == null ? MISSING : `${d.institutional.dii_net.toFixed(0)} cr`}</span>
              <span className={`ml-1 text-[10px] ${d.institutional.fresh ? "text-muted" : "text-warn"}`}>({d.institutional.session})</span>
            </p>
          ) : <p className="text-xs text-muted">Not stored yet.</p>}
          <p className="mt-1 text-[11px] text-muted">Published after ~18:00 IST; never an intraday figure.</p>
        </div>
      </div>
    </Card>
  );
}

function EventsMl({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Events & ML model" className="lg:col-span-6">
      <ul className="space-y-1">
        {d.events.slice(0, 4).map((e) => (
          <li key={e.id} className="flex justify-between gap-2 text-xs">
            <span className={`min-w-0 truncate ${e.impact === "high" ? "text-paper" : "text-muted"}`}>{e.impact === "high" ? "● " : ""}{e.name}</span>
            <span className="num shrink-0 text-muted">{e.all_day ? e.start_ist.slice(0, 10) : fmtDateTimeIST(e.start_ist)}{e.time_verified ? "" : " ?"}</span>
          </li>
        ))}
        {d.events.length === 0 && <li className="text-xs text-muted">No calendar events in the next 7 days.</li>}
      </ul>
      <p className="mt-1 text-[11px] text-muted">“?” = time not confirmed by the publisher. Countdowns are not shown for unverified times.</p>
      <div className="mt-3 rounded-sm border border-rule bg-slate-2 p-2" data-testid="cc-ml">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-paper">Intraday ML model</span>
          <Chip>Not trained</Chip>
        </div>
        <p className="mt-1 text-xs text-muted">{d.ml.reason}</p>
        <div className="mt-2 h-1.5 w-full rounded-sm bg-slate" aria-hidden>
          <div className="h-full rounded-sm bg-accent" style={{ width: `${Math.min(100, (d.ml.complete_sessions / d.ml.required_sessions) * 100)}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-muted">The overnight T+1 / T+5 models are on the Prediction page and are separate from this.</p>
      </div>
    </Card>
  );
}

function History({ expiry }: { expiry: string }) {
  const colors = useChartColors();
  const q = useQuery({ queryKey: ["intradayScores", expiry], queryFn: () => api.intradayScores(expiry), refetchInterval: 60_000, retry: false });
  const rows = q.data?.rows ?? [];
  const option = useMemo(() => sentimentHistoryOption(rows, colors), [rows, colors]);
  return (
    <Card title="Sentiment history (today, stored)" className="lg:col-span-12"
      right={<span className="text-[11px] text-muted">{rows.length} stored scores · {expiry}</span>}>
      {rows.length < 2 ? (
        <p className="py-6 text-center text-sm text-muted">
          {q.isError ? "Score history could not be loaded." : "Scores are stored once a minute while the market is open; the chart appears after two."}
        </p>
      ) : (
        <div className="h-56"><EChart option={option} ariaLabel="Sentiment score and sampled NIFTY over today's session" /></div>
      )}
    </Card>
  );
}

const HIDE_KEY = "nse.intraday.cc.hidden";

export function CommandCenter({ expiry }: { expiry: string | null }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; } });
  const toggle = () => setHidden((h) => { try { localStorage.setItem(HIDE_KEY, h ? "0" : "1"); } catch { /* storage unavailable */ } return !h; });
  const q = useQuery({
    queryKey: ["intradaySummary", expiry],
    queryFn: () => api.intradaySummary(expiry!),
    enabled: !!expiry,
    refetchInterval: 30_000,
    retry: false,
  });
  const d = q.data;
  return (
    <section aria-label="Market Sentiment Command Center" className="flex flex-col gap-3" data-testid="command-center">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-paper">Market Sentiment Command Center</h2>
        <div className="flex items-center gap-3 text-xs">
          {d && <span className="text-muted">computed {fmtTimeIST(d.generated_at)}</span>}
          <a href="#widgets" className="text-info hover:underline">Jump to widgets ↓</a>
          <button type="button" onClick={toggle} aria-expanded={!hidden} className="rounded-sm border border-rule px-2 py-1 text-muted hover:text-paper">
            {hidden ? "Show" : "Hide"}
          </button>
        </div>
      </div>
      {hidden ? null : !expiry ? (
        <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>
      ) : q.isLoading ? (
        <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading command center" />
      ) : q.isError || !d ? (
        <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">
          The command center could not be computed: {q.error instanceof Error ? q.error.message : "unknown error"}. The widgets below still work.
        </p>
      ) : (
        <>
          <Header d={d} />
          {d.market.mode !== "live" && (
            <p className="rounded-sm border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn" data-testid="cc-mode-note">
              {d.market.mode === "historical" ? `Market is ${(PHASE[d.market.phase] ?? d.market.phase).toLowerCase()}. Values come from the last stored samples and are not live.`
                : d.market.mode === "stale" ? "Samples have stopped arriving during market hours. Check that the backend sampler is running."
                : d.market.mode === "delayed" ? "The last sample is a few minutes old."
                : "No stored sample for this expiry yet."}
            </p>
          )}
          <div className="grid gap-3 lg:grid-cols-12">
            <Sentiment d={d} />
            <Evidence d={d} />
            <Regime d={d} />
            <Context d={d} />
            <Levels d={d} />
            <Options d={d} />
            <Health d={d} />
            <Markets d={d} />
            <EventsMl d={d} />
            <History expiry={expiry} />
          </div>
        </>
      )}
    </section>
  );
}
