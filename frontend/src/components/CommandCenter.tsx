// Market Sentiment Command Center (top of the Intraday analysis page).
// Shows only what /api/intraday/summary computed from stored observations. Every number carries its
// source and time; anything missing is shown as missing, and nothing here is an ML prediction.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { compactIN } from "../lib/analytics";
import { divergingBarOption, ivSmileOption, sentimentHistoryOption } from "../lib/chartOptions";
import { fmtDateTimeIST, fmtPct, fmtPrice, fmtTimeIST, MISSING } from "../lib/format";
import { useLiveSpot } from "../lib/useLive";
import type { BreadthBlock, BreakoutState, FlowStats, IntradayComponent, IntradaySummary, MarketSummary, SetupCandidate, SideClass } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { FillBar, Gauge, MiniBar, RangeBar, SplitBar, Tile } from "./viz";

const PHASE: Record<string, string> = {
  closed: "Closed (no session today)", pre_market: "Pre-market", pre_open: "Pre-open (09:00–09:15)", opening: "Opening (09:15–09:45)",
  morning: "Morning", midday: "Midday", afternoon: "Afternoon", closing: "Closing (15:00–15:40)", post_market: "Post-market",
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

/**
 * Width of a card on wide screens as a share of the 12-column row. Cards sit in a wrapping flex row and grow to
 * fill it, so a row never ends with a blank gap when a neighbouring card has no data and is not shown.
 */
const BASIS: Record<number, string> = {
  4: "lg:basis-[calc(33.333%-0.5rem)]", 5: "lg:basis-[calc(41.667%-0.44rem)]", 6: "lg:basis-[calc(50%-0.375rem)]",
  7: "lg:basis-[calc(58.333%-0.31rem)]", 8: "lg:basis-[calc(66.667%-0.25rem)]", 12: "lg:basis-full",
};

function Card({ title, children, right, className = "" }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  const span = Number(/lg:col-span-(\d+)/.exec(className)?.[1] ?? 12);
  const width = `w-full lg:w-auto lg:grow ${BASIS[span] ?? BASIS[12]}`;
  className = `${className.replace(/lg:col-span-\d+/, "")} ${width}`;
  return (
    <section aria-label={title} className={`min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}>
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-rule bg-gradient-to-r from-slate-2/80 to-transparent px-3 py-1.5">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-paper/90"><span aria-hidden="true" className="inline-block h-3.5 w-1 rounded-sm bg-info" />{title}</h3>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

const lvl = (d: IntradaySummary, name: string): number | null => d.levels.find((l) => l.name === name)?.value ?? null;

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
    <div className="min-w-0 rounded-sm bg-slate-2/50 px-2.5 py-1.5">
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
      <Stat label="Intraday ML" value={d.ml.model_trained ? d.ml.stage_name : "No model yet"} cls="text-muted" sub={`${d.ml.stage_name} · ${d.ml.labelled_sessions} session${d.ml.labelled_sessions === 1 ? "" : "s"} labelled`} />
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

const QUALITY: Record<string, { text: string; cls: string }> = {
  broad_confirmed: { text: "Broad, volume-confirmed", cls: "border-up/60 text-up" },
  broad: { text: "Broad (volume not confirmed)", cls: "border-up/50 text-up" },
  narrow: { text: "Narrow: few stocks carry it", cls: "border-warn/60 text-warn" },
  thin: { text: "Thin: low volume", cls: "border-warn/60 text-warn" },
  mixed: { text: "Mixed", cls: "border-info/60 text-info" },
  no_move: { text: "No real index move yet", cls: "border-rule text-muted" },
  unknown: { text: "Not enough stocks priced", cls: "border-rule text-muted" },
};

/** Stacked up / flat / down bar for a breadth block. */
export function BreadthBar({ b, label }: { b: BreadthBlock; label: string }) {
  const n = Math.max(1, b.covered);
  return (
    <div role="img" aria-label={`${label}: ${b.advancing} up, ${b.flat} flat, ${b.declining} down of ${b.covered} priced`} className="flex h-2.5 w-full overflow-hidden rounded-sm bg-slate-2">
      <div className="bg-up" style={{ width: `${(b.advancing / n) * 100}%` }} />
      <div className="bg-muted/50" style={{ width: `${(b.flat / n) * 100}%` }} />
      <div className="bg-down" style={{ width: `${(b.declining / n) * 100}%` }} />
    </div>
  );
}

function BreadthRow({ label, b }: { label: string; b: BreadthBlock }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="font-semibold text-paper">{label}</span>
        <span className="num text-muted">
          <span className="text-up">{b.advancing} up</span> · <span className="text-down">{b.declining} down</span> · {b.flat} flat · {b.covered}/{b.total} priced
        </span>
      </div>
      {b.covered === 0 ? <p className="text-xs text-muted">No priced stocks yet.</p> : <BreadthBar b={b} label={label} />}
      {b.covered > 0 && (
        <p className="num mt-1 text-[11px] text-muted">
          equal-weighted {fmtPct(b.equal_weight_return)} · A/D ratio {b.ad_ratio == null ? MISSING : b.ad_ratio.toFixed(2)} · at session high {b.at_high} / low {b.at_low}
          {b.coverage < 0.9 && <span className="text-warn"> · coverage {Math.round(b.coverage * 100)}%</span>}
        </p>
      )}
    </div>
  );
}

function SourceChecklist({ s }: { s: MarketSummary["sources"] }) {
  const rows: [string, boolean, string][] = [
    ["NIFTY 50 / NIFTY 500 lists", !!s.lists.nifty50 && !!s.lists.nifty500, s.lists.nifty50 ? `${s.lists.nifty50.stocks} / ${s.lists.nifty500?.stocks ?? 0} stocks` : "not downloaded yet"],
    ["Kotak stock tokens", s.tokens.found > 0, `${s.tokens.found} of ${s.tokens.of} found`],
    ["Live stock prices", s.live.stocks_with_ticks > 0, `${s.live.stocks_with_ticks} of ${s.live.subscribed} streaming`],
    ["Index weights", !!s.weights, s.weights ? `${s.weights.source}, as of ${s.weights.as_of}${s.weights.approximate ? " (approximate)" : ""}` : "not loaded"],
    ["Volume baseline", s.volume_baseline.stocks > 0, `${s.volume_baseline.sessions} of ${s.volume_baseline.needs_sessions} sessions stored`],
  ];
  return (
    <ul className="space-y-1 text-xs" data-testid="cc-breadth-sources">
      {rows.map(([name, ok, detail]) => (
        <li key={name} className="flex justify-between gap-2"><span className="text-paper">{ok ? "✓" : "○"} {name}</span><span className={ok ? "text-muted" : "text-warn"}>{detail}</span></li>
      ))}
    </ul>
  );
}

const DIVERGENCE_TEXT: Record<string, string> = {
  bearish_divergence: "Index rising while fewer stocks take part (bearish divergence)",
  bullish_divergence: "Index falling while more stocks recover (bullish divergence)",
  confirmed: "Index and breadth moving together",
  no_clear_index_move: "No clear index move in the window",
};

function Participation({ p }: { p: NonNullable<MarketSummary["participation"]> }) {
  const mo = p.momentum;
  return (
    <div className="mt-2 space-y-1 border-t border-rule/50 pt-2 text-muted" data-testid="cc-participation">
      <p className="num">Above own day VWAP: {p.above_vwap.pct_above == null ? MISSING : `${p.above_vwap.pct_above}% (${p.above_vwap.above} of ${p.above_vwap.covered})`}{p.above_vwap.missing > 0 ? ` · ${p.above_vwap.missing} without a VWAP` : ""}</p>
      <p className="num">{p.opening_range == null ? "Opening range still forming." : `Above ${p.opening_range.minutes}-min opening-range high: ${p.opening_range.above_high} · below low: ${p.opening_range.below_low} · inside: ${p.opening_range.inside} (${p.opening_range.missing} without a recorded range)`}</p>
      <p className="num">Breadth momentum ({mo.window_minutes} min): {mo.breadth_momentum == null ? MISSING : `${mo.breadth_momentum >= 0 ? "+" : "−"}${Math.abs(mo.breadth_momentum).toFixed(2)}`}. {DIVERGENCE_TEXT[mo.state] ?? "Not enough history yet."}</p>
    </div>
  );
}

function Breadth({ d }: { d: IntradaySummary }) {
  const m = d.stocks;
  const q = m ? QUALITY[m.nifty50.quality.state] ?? QUALITY.unknown! : null;
  const hasStocks = !!m && m.nifty50.breadth.covered > 0;
  return (
    <Card title="Market breadth & move quality" className="lg:col-span-6" right={q && hasStocks ? <Chip cls={q.cls} title="Provisional rule, not validated">{q.text}</Chip> : <Chip>Not available</Chip>}>
      {!m ? <p className="text-sm text-muted">Stock breadth is turned off on this backend.</p> : !hasStocks ? (
        <>
          <p className="mb-2 text-sm text-muted">No stock prices are streaming yet, so breadth cannot be measured. It is not guessed.</p>
          <SourceChecklist s={m.sources} />
        </>
      ) : (
        <>
          <BreadthRow label="NIFTY 50" b={m.nifty50.breadth} />
          <BreadthRow label="NIFTY 500" b={m.nifty500.breadth} />
          <div className="mt-2 rounded-sm bg-slate-2 p-2 text-xs" data-testid="cc-move-quality">
            <div className="font-semibold text-paper">Is the move real? <span className="font-normal text-muted">(provisional rule)</span></div>
            <ul className="mt-1 list-inside list-disc text-muted">{m.nifty50.quality.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {m.nifty50.contribution?.top5_share != null && (
              <p className="num mt-1 text-muted">Top 5 stocks explain {Math.round(m.nifty50.contribution.top5_share * 100)}% of the NIFTY 50 move; {m.nifty50.contribution.stocks_for_half ?? MISSING} stock(s) explain half. Weights {m.nifty50.weights?.approximate ? "approximate" : "official"}, as of {m.nifty50.weights?.as_of}.</p>
            )}
            {m.nifty50.volume?.weighted_rv != null && (
              <p className="num mt-1 text-muted">Volume {m.nifty50.volume.weighted_rv.toFixed(2)}x normal so far ({m.nifty50.volume.reference === "profile" ? "against the typical intraday profile" : "linear time reference: early volume is front-loaded, so this can show thin but not confirm strong"}).</p>
            )}
            {m.participation && <Participation p={m.participation} />}
          </div>
          <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Data sources</summary><div className="mt-1"><SourceChecklist s={m.sources} /></div></details>
        </>
      )}
    </Card>
  );
}

function Heavyweights({ d }: { d: IntradaySummary }) {
  const m = d.stocks;
  const rows = (m?.nifty50.stocks ?? []).filter((s) => s.change_pct != null).slice(0, 10);
  return (
    <Card title="NIFTY 50 heavyweights" className="lg:col-span-6" right={<span className="text-[11px] text-muted">by contribution to the index move</span>}>
      {rows.length === 0 ? <p className="text-sm text-muted">{m ? "No priced NIFTY 50 stocks yet." : "Stock breadth is turned off."}</p> : (
        <table className="w-full text-xs" data-testid="cc-heavyweights">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Stock</th><th className="py-1 text-right font-normal">Weight</th><th className="py-1 text-right font-normal">Change</th><th className="py-1 text-right font-normal">Contribution</th><th className="py-1 text-right font-normal">Volume vs normal</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.symbol} className="border-t border-rule/50">
                <td className="py-1 text-paper" title={s.sector ?? ""}>{s.symbol}</td>
                <td className="num py-1 text-right text-muted">{s.weight == null ? MISSING : `${s.weight.toFixed(1)}%`}</td>
                <td className={`num py-1 text-right ${tone(s.change_pct)}`}><span className="mr-2">{fmtPct(s.change_pct)}</span><MiniBar value={s.change_pct} scale={2} /></td>
                <td className={`num py-1 text-right ${tone(s.contribution)}`}>{s.contribution == null ? MISSING : `${s.contribution >= 0 ? "+" : "−"}${Math.abs(s.contribution).toFixed(3)} pt`}</td>
                <td className={`num py-1 text-right ${s.relative_volume != null && s.relative_volume < 0.7 ? "text-warn" : "text-muted"}`}>{s.relative_volume == null ? MISSING : `${s.relative_volume.toFixed(2)}x`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {m && !m.nifty50.weights && rows.length > 0 && <p className="mt-2 text-[11px] text-warn">Index weights are not loaded, so contribution cannot be shown (breadth counts still work).</p>}
    </Card>
  );
}

const DIVERGENCE: Record<string, string> = {
  confirmed: "Price and net buying agree",
  bearish_divergence: "Price rose while sellers led (bearish divergence)",
  bullish_divergence: "Price fell while buyers led (bullish divergence)",
  no_clear_move: "No clear move to compare",
};

function fmtQty(n: number | null | undefined): string {
  return n == null ? MISSING : `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-IN")}`;
}

function FlowLine({ f }: { f: FlowStats }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      <div><div className="text-[11px] text-muted">Net buying (CVD, estimated)</div><div className={`num ${tone(f.cvd)}`}>{fmtQty(f.cvd)}{f.cvd_pct == null ? "" : ` · ${f.cvd_pct >= 0 ? "+" : "−"}${Math.abs(f.cvd_pct).toFixed(1)}%`}</div></div>
      <div><div className="text-[11px] text-muted">Buy / sell volume</div><div className="num text-paper">{fmtQty(f.buy_volume)} / {fmtQty(f.sell_volume)}</div></div>
      <div><div className="text-[11px] text-muted">Order-book imbalance</div><div className={`num ${tone(f.depth_imbalance)}`}>{f.depth_imbalance == null ? MISSING : f.depth_imbalance.toFixed(2)}</div></div>
      <div><div className="text-[11px] text-muted">Volume vs normal</div><div className={`num ${f.relative_volume != null && f.relative_volume < 0.7 ? "text-warn" : "text-paper"}`}>{f.relative_volume == null ? MISSING : `${f.relative_volume.toFixed(2)}x`}</div></div>
    </div>
  );
}

const BREAKOUT_TONE: Record<string, string> = {
  CONFIRMED: "text-up", DEVELOPING: "text-warn", UNCONFIRMED: "text-muted", FAILED: "text-down", INVALIDATED: "text-down", EXPIRED: "text-muted",
};

function Breakout({ d }: { d: IntradaySummary }) {
  const st = d.structure;
  const v = d.vwap;
  const b: BreakoutState | null = st?.breakout ?? null;
  const or = st?.ranges.find((r) => r.minutes === (b?.or_minutes ?? 15)) ?? st?.ranges[0];
  return (
    <Card title="Breakout intelligence" className="lg:col-span-6" right={<span className="text-[11px] text-muted">{st ? st.data : "no data"} · rule-based, not a prediction</span>}>
      {!st ? <p className="text-sm text-muted">Price structure is not available.</p> : (
        <div className="space-y-3 text-xs" data-testid="cc-breakout">
          <div>
            <div className="text-[11px] text-muted">Opening range ({or?.minutes ?? 15} min) · {or?.state ?? MISSING}</div>
            <div className="num text-paper">{or?.high == null ? MISSING : `${or.high.toFixed(2)} high · ${or.low?.toFixed(2)} low · width ${or.width?.toFixed(1)}`}</div>
            <div className="mt-2" data-testid="cc-range-bar">
              {or?.high != null && or.low != null
                ? <RangeBar label="Opening range with the current price" low={or.low} high={or.high} marks={[{ v: d.price.last, label: `Now ${d.price.last?.toFixed(0)}`, cls: "text-brass" }, { v: lvl(d, "Previous day high"), label: "Prev high", cls: "text-up" }, { v: lvl(d, "Previous day low"), label: "Prev low", cls: "text-down" }]} />
                : <>
                    <RangeBar label="Previous day range with the current price" low={lvl(d, "Previous day low")} high={lvl(d, "Previous day high")} marks={[{ v: d.price.last, label: `Last ${d.price.last?.toFixed(0)}`, cls: "text-brass" }, { v: lvl(d, "Previous close"), label: "Prev close", cls: "text-info" }]} />
                    <div className="text-[10px] text-muted">Shaded: previous session's high to low (no opening range stored for today).</div>
                  </>}
            </div>
          </div>
          {b ? (
            <div data-testid="cc-breakout-status">
              <div className="text-sm"><span className={`font-semibold ${BREAKOUT_TONE[b.status] ?? ""}`}>{b.status}</span> <span className="text-muted">{b.direction === "up" ? "break above" : "break below"} the range · {b.beyond} closes beyond, {b.clear} clear of the buffer</span></div>
              <div className="mt-1 num text-paper">Quality {b.quality.score == null ? `${MISSING} (needs ≥50% of inputs, has ${Math.round(b.quality.coverage * 100)}%)` : `${b.quality.score.toFixed(0)} / 100`} <span className="text-muted">· a score, not a probability</span></div>
              <div className="mt-1 text-[11px] text-muted">Invalid if a close returns through {b.invalidation.toFixed(2)}. {b.quality.missing.length > 0 ? `Not available: ${b.quality.missing.join(", ")}.` : ""}{b.previous ? ` Earlier: ${b.previous}.` : ""}</div>
            </div>
          ) : <p className="text-muted">{st.data === "HISTORICAL" ? "Stored data only: no breakout call." : or?.state === "complete" ? "No close outside the opening range yet." : "Opening range still forming."}</p>}
          {st.structure && <div><span className="text-muted">Structure: </span><span className="text-paper">{st.structure.label}</span>{st.structure.break ? <span className="text-warn"> · {st.structure.break.replaceAll("_", " ")}</span> : null}</div>}
          <div data-testid="cc-vwap">
            <span className="text-muted">NIFTY future vs its day VWAP: </span>
            {v ? <span className="num text-paper">{v.side} by {Math.abs(v.distance_pts).toFixed(1)} pts ({v.distance_pct.toFixed(2)}%) · {v.crosses} crosses{v.slope_pts_per_15m == null ? "" : ` · VWAP ${v.slope_pts_per_15m >= 0 ? "+" : "−"}${Math.abs(v.slope_pts_per_15m).toFixed(1)} in 15 min`}</span> : <span className="text-muted">not available (no futures feed)</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

function FlowCard({ d }: { d: IntradaySummary }) {
  const fl = d.stocks?.flow;
  const fut = fl?.futures ?? null;
  return (
    <Card title="Futures flow and top-5 heavyweights" className="lg:col-span-12" right={<span className="text-[11px] text-muted">estimated from the exchange feed · provisional</span>}>
      {!fl ? <p className="text-sm text-muted">{d.stocks ? "No flow data yet." : "Stock breadth is turned off."}</p> : (
        <div className="space-y-4" data-testid="cc-flow">
          <div>
            <div className="mb-1 text-xs font-medium text-paper">NIFTY current-month future {fl.futures_contract ? `(${fl.futures_contract})` : ""}</div>
            {fut ? (
              <>
                <FlowLine f={fut} />
                {fut.divergence && <p className="mt-1 text-xs text-muted" data-testid="cc-fut-divergence">Last {fut.divergence.window_minutes} min: {DIVERGENCE[fut.divergence.state] ?? fut.divergence.state} (price {fmtPct(fut.divergence.price_change_pct)}).</p>}
              </>
            ) : <p className="text-xs text-muted">{fl.futures_note}. No futures ticks received yet.</p>}
            {!fl.baseline.futures_profile_ready && <p className="mt-1 text-[11px] text-muted">Volume vs normal needs {fl.baseline.needs_sessions} recorded sessions ({fl.baseline.profile_sessions_futures} so far).</p>}
          </div>
          <div className="overflow-x-auto">
            <div className="mb-1 text-xs text-muted">Top 5 by {fl.heavy5.basis}</div>
            <table className="w-full min-w-[36rem] text-xs" data-testid="cc-heavy5">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Stock</th><th className="py-1 text-right font-normal">Change</th><th className="py-1 text-right font-normal">Volume vs normal</th><th className="py-1 text-right font-normal">Net buying (est.)</th><th className="py-1 text-right font-normal">Book imbalance</th><th className="py-1 text-right font-normal">Trend</th><th className="py-1 text-right font-normal">RSI</th><th className="py-1 text-right font-normal">vs 20-day avg</th></tr></thead>
              <tbody>
                {fl.heavy5.stocks.map((s) => (
                  <tr key={s.symbol} className="border-t border-rule/50">
                    <td className="py-1 text-paper">{s.symbol}</td>
                    <td className={`num py-1 text-right ${tone(s.change_pct)}`}><span className="mr-2">{fmtPct(s.change_pct)}</span><MiniBar value={s.change_pct} scale={2} /></td>
                    <td className={`num py-1 text-right ${s.relative_volume != null && s.relative_volume < 0.7 ? "text-warn" : "text-muted"}`}>{s.relative_volume == null ? MISSING : `${s.relative_volume.toFixed(2)}x`}</td>
                    <td className={`num py-1 text-right ${tone(s.flow?.cvd)}`}>{s.flow ? fmtQty(s.flow.cvd) : MISSING}</td>
                    <td className={`num py-1 text-right ${tone(s.flow?.depth_imbalance)}`}>{s.flow?.depth_imbalance == null ? MISSING : s.flow.depth_imbalance.toFixed(2)}</td>
                    <td className="py-1 text-right"><span className={`rounded-sm border px-1.5 py-px text-[11px] ${s.technical.trend === "uptrend" ? "border-up/50 text-up" : s.technical.trend === "downtrend" ? "border-down/50 text-down" : "border-rule text-muted"}`}>{s.technical.trend ?? MISSING}</span></td>
                    <td className="num py-1 text-right text-muted"><span className="mr-2">{s.technical.rsi14 == null ? MISSING : s.technical.rsi14.toFixed(0)}</span><FillBar value={s.technical.rsi14} max={100} color={(s.technical.rsi14 ?? 50) >= 70 ? "bg-warn" : (s.technical.rsi14 ?? 50) <= 30 ? "bg-info" : "bg-muted/60"} /></td>
                    <td className={`num py-1 text-right ${tone(s.technical.price_vs_sma20_pct)}`}>{fmtPct(s.technical.price_vs_sma20_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fl.heavy5.stocks.some((s) => !s.technical.enough_history) && <p className="mt-1 text-[11px] text-muted">Technical reads use NSE daily files; the 50-day trend needs 50 sessions of history, which is still being collected.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

function Volatility({ d }: { d: IntradaySummary }) {
  const colors = useChartColors();
  const v = d.volatility;
  const ok = v?.status === "ok" && v.atm_iv != null;
  const chg = (k: string) => { const x = v?.iv_change_pts?.[k]; return x == null ? MISSING : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`; };
  const near = (v?.rows ?? []).filter((r) => r.otm && r.iv != null && Math.abs(r.strike - (v?.atm_strike ?? 0)) <= 100);
  return (
    <Card title="Implied volatility & Greeks" className="lg:col-span-6" right={<span className="text-[11px] text-muted">{v?.data ?? "no data"} · computed from option prices</span>}>
      {!ok ? <p className="text-sm text-muted" data-testid="cc-vol-missing">{v ? v.status : "Not available."}</p> : (
        <div className="space-y-3 text-xs" data-testid="cc-vol">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <div><div className="text-[11px] text-muted">ATM IV (strike {v.atm_strike})</div><div className="num text-xl font-semibold text-paper">{v.atm_iv?.toFixed(2)}%</div></div>
            <div><div className="text-[11px] text-muted">IV change 5 / 15 / 30 min</div><div className="num text-paper">{chg("5")} / {chg("15")} / {chg("30")} pts</div></div>
            <div><div className="text-[11px] text-muted">Put − call IV (≈25Δ)</div><div className="num text-paper">{v.skew_25d_put_minus_call == null ? MISSING : `${v.skew_25d_put_minus_call.toFixed(2)} pts`}</div></div>
            <div><div className="text-[11px] text-muted">IV − realised (60 min)</div><div className="num text-paper">{v.iv_minus_realized == null ? MISSING : `${v.iv_minus_realized >= 0 ? "+" : "−"}${Math.abs(v.iv_minus_realized).toFixed(1)} pts`}</div></div>
          </div>
          <div className="rounded-sm bg-slate-2/40 p-2" data-testid="cc-smile">
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted"><span>Implied volatility by strike (out-of-the-money options)</span><span><span className="text-down">● puts</span> <span className="text-up">● calls</span></span></div>
            <div className="h-36"><EChart option={ivSmileOption(near.length >= 3 ? near : (v?.rows ?? []).filter((r) => r.otm && r.iv != null), v.atm_strike ?? null, colors)} ariaLabel="Implied volatility smile" /></div>
          </div>
          <div className="text-muted">Implied move to expiry ({v.time_to_expiry_days?.toFixed(1)} days): ATM straddle <span className="num text-paper">{v.expected_move_straddle_pts?.toFixed(0) ?? MISSING} pts</span> · one standard deviation from IV <span className="num text-paper">{v.expected_move_iv_1sd_pts?.toFixed(0) ?? MISSING} pts</span>. Implied, not a forecast.</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-xs" data-testid="cc-greeks">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Strike</th><th className="py-1 font-normal">Side</th><th className="py-1 text-right font-normal">IV %</th><th className="py-1 text-right font-normal">Delta</th><th className="py-1 text-right font-normal">Gamma</th><th className="py-1 text-right font-normal">Theta/day</th><th className="py-1 text-right font-normal">Vega/pt</th></tr></thead>
              <tbody>
                {near.map((r) => (
                  <tr key={`${r.strike}${r.side}`} className="border-t border-rule/50">
                    <td className="num py-1 text-paper">{r.strike}</td><td className="py-1 text-muted">{r.side}</td>
                    <td className="num py-1 text-right">{r.iv?.toFixed(2)}</td><td className="num py-1 text-right">{r.delta?.toFixed(3) ?? MISSING}</td>
                    <td className="num py-1 text-right">{r.gamma?.toFixed(5) ?? MISSING}</td><td className="num py-1 text-right">{r.theta_day?.toFixed(2) ?? MISSING}</td><td className="num py-1 text-right">{r.vega_pt?.toFixed(2) ?? MISSING}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(v.interpretation ?? []).map((t) => <p key={t} className="text-muted">Context: {t}</p>)}
          <p className="text-[11px] text-muted">{v.model}. Forward {v.forward?.toFixed(2)} ({v.forward_source}). {v.rate_assumed == null ? "Discount rate not reported." : `Discount rate assumed ${(v.rate_assumed * 100).toFixed(1)}%;`} not validated against a broker reference.{v.valued_at ? ` Time to expiry is counted from ${fmtDateTimeIST(v.valued_at)}, the market time of these prices${v.as_of && v.valued_at !== v.as_of ? " (the chain was fetched later, after the close)" : ""}.` : ""}</p>
        </div>
      )}
    </Card>
  );
}

const WINDOW_NAMES: Record<string, string> = { atm_pm2: "ATM ±2", atm_pm5: "ATM ±5", atm_pm10: "ATM ±10", all: "All strikes" };

function Positioning({ d }: { d: IntradaySummary }) {
  const p = d.positioning;
  const ts = d.volatility?.term_structure;
  const fmt = (x: number | null | undefined) => (x == null ? MISSING : x.toFixed(2));
  const cls = (c?: SideClass) => (!c ? MISSING : c.label ? `${c.label}${c.reading ? ` (${c.reading})` : ""}` : c.reason ?? MISSING);
  return (
    <Card title="Options positioning detail" className="lg:col-span-6" right={<span className="text-[11px] text-muted">{p?.data ?? "no data"} · tentative readings, not signals</span>}>
      {!p || p.status !== "ok" ? <p className="text-sm text-muted" data-testid="cc-pos-missing">{p?.status ?? "Not available."}</p> : (
        <div className="space-y-3 text-xs" data-testid="cc-pos">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window</th><th className="py-1 text-right font-normal">PCR (OI)</th><th className="py-1 text-right font-normal">PCR (volume)</th></tr></thead>
            <tbody>
              {Object.entries(p.pcr_windows ?? {}).map(([k, w]) => (
                <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{WINDOW_NAMES[k] ?? k}</td><td className="num py-1 text-right"><span className="mr-2">{fmt(w.pcr_oi)}</span><MiniBar value={w.pcr_oi == null ? null : w.pcr_oi - 1} scale={0.6} /></td><td className="num py-1 text-right">{fmt(w.pcr_volume)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted">OI-change PCR since the open: <span className="num text-paper">{p.oi_change_pcr_since_open?.value == null ? MISSING : p.oi_change_pcr_since_open.value.toFixed(2)}</span>{p.oi_change_pcr_since_open?.reason ? ` (${p.oi_change_pcr_since_open.reason})` : ""}</p>
          <div>
            <div className="text-[11px] text-muted">Premium and OI against {p.reference_minutes} minutes ago (ATM ±5)</div>
            {p.classification?.available ? (
              <ul className="mt-1 space-y-0.5"><li><span className="text-muted">Calls: </span><span className="text-paper">{cls(p.classification.calls)}</span></li><li><span className="text-muted">Puts: </span><span className="text-paper">{cls(p.classification.puts)}</span></li></ul>
            ) : <p className="text-muted">{p.classification?.reason ?? "Not available."}</p>}
            <p className="mt-1 text-[11px] text-muted">{p.classification?.limits}</p>
          </div>
          {p.concentration?.calls.top3_share != null && p.concentration.puts.top3_share != null && (
            <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-2 gap-y-1 text-[11px] text-muted" aria-hidden="true" data-testid="cc-concentration">
              <span>Calls</span><span className="flex items-center gap-2"><FillBar value={p.concentration.calls.top3_share} max={1} color="bg-up" className="w-full" /><span className="num w-9 text-right text-paper">{Math.round(p.concentration.calls.top3_share * 100)}%</span></span>
              <span>Puts</span><span className="flex items-center gap-2"><FillBar value={p.concentration.puts.top3_share} max={1} color="bg-down" className="w-full" /><span className="num w-9 text-right text-paper">{Math.round(p.concentration.puts.top3_share * 100)}%</span></span>
            </div>
          )}
          <p className="num text-muted">OI concentration (top-3 strikes): calls {p.concentration?.calls.top3_share == null ? MISSING : `${Math.round(p.concentration.calls.top3_share * 100)}%`} (largest {p.concentration?.calls.max_strike ?? MISSING}) · puts {p.concentration?.puts.top3_share == null ? MISSING : `${Math.round(p.concentration.puts.top3_share * 100)}%`} (largest {p.concentration?.puts.max_strike ?? MISSING}). A hypothesis for a reaction zone, not support or resistance.</p>
          <p className="text-muted" data-testid="cc-term">IV term structure: {ts?.shape ? `${ts.shape}, far minus near ${ts.iv_far_minus_near?.toFixed(2)} pts (${ts.rows.map((r) => `${r.expiry} ${r.atm_iv?.toFixed(1)}%`).join(", ")})` : (ts?.reason ?? MISSING)}</p>
        </div>
      )}
    </Card>
  );
}

function ForwardCheckCard({ expiry }: { expiry: string }) {
  const q = useQuery({ queryKey: ["intradayForward", expiry], queryFn: () => api.intradayForward(expiry), refetchInterval: 600_000, retry: false });
  const r = q.data;
  const rows: ["bullish" | "neutral" | "bearish", string, string][] = [["bullish", "Score ≥ +0.2 (bullish)", "text-up"], ["neutral", "Between (neutral)", "text-muted"], ["bearish", "Score ≤ −0.2 (bearish)", "text-down"]];
  return (
    <Card title="Forward check of the rules-based sentiment" className="lg:col-span-12" right={<span className="text-[11px] text-muted">stored in real time · what NIFTY did next</span>}>
      {q.isLoading ? <p className="text-sm text-muted">Loading…</p> : !r ? <p className="text-sm text-muted" data-testid="cc-forward-error">The forward check is unavailable.</p> : (
        <div className="space-y-3 text-xs" data-testid="cc-forward">
          <p className="text-paper"><span className="num font-semibold">{r.sessions}</span> session(s) of stored scores. <span className="text-muted">{r.conclusion ?? "The sample is large enough to read, with the usual caution."}</span></p>
          <div className="grid gap-3 md:grid-cols-3">
            {["15", "30", "60"].map((h) => {
              const g = r.horizons[h];
              if (!g) return null;
              return (
                <div key={h} className="rounded-sm border border-rule bg-slate-2/40 p-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Next {h} minutes</div>
                  <table className="w-full"><thead><tr className="text-[11px] text-muted"><th className="py-0.5 text-left font-normal">Score group</th><th className="py-0.5 text-right font-normal">Samples</th><th className="py-0.5 text-right font-normal">Mean move</th><th className="py-0.5 text-right font-normal">Up share</th></tr></thead>
                    <tbody>
                      {rows.map(([k, name, cls]) => {
                        const x = g[k];
                        return (
                          <tr key={k} className="border-t border-rule/50">
                            <td className={`py-1 ${cls}`}>{name}</td><td className="num py-1 text-right">{x.n}</td>
                            <td className={`num py-1 text-right ${tone(x.mean_fwd_pct)}`}><span className="mr-1">{x.mean_fwd_pct == null ? MISSING : fmtPct(x.mean_fwd_pct)}</span><MiniBar value={x.mean_fwd_pct} scale={0.2} className="w-10" /></td>
                            <td className="num py-1 text-right">{x.share_up == null ? MISSING : `${Math.round(x.share_up * 100)}%`}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t border-rule"><td className="py-1 text-muted">All stored scores</td><td className="num py-1 text-right">{g.all.n}</td><td className={`num py-1 text-right ${tone(g.all.mean_fwd_pct)}`}>{g.all.mean_fwd_pct == null ? MISSING : fmtPct(g.all.mean_fwd_pct)}</td><td className="num py-1 text-right">{g.all.share_up == null ? MISSING : `${Math.round(g.all.share_up * 100)}%`}</td></tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">{r.note} Bullish scores should be followed by a higher mean move than neutral and bearish ones for the sentiment to carry information; until {r.min_sessions} sessions are stored this is a record, not evidence.</p>
        </div>
      )}
    </Card>
  );
}

function ModelResearch() {
  const q = useQuery({ queryKey: ["intradayResearch", 15], queryFn: () => api.intradayResearch(15), refetchInterval: 600_000, retry: false });
  const r = q.data;
  const models = r?.models ? Object.entries(r.models) : [];
  return (
    <Card title="Prediction model research (15 min)" className="lg:col-span-12" right={<span className="text-[11px] text-muted">walk-forward on stored sessions</span>}>
      {q.isLoading ? <p className="text-sm text-muted">Loading…</p> : !r ? <p className="text-sm text-muted" data-testid="cc-research-error">Model research is unavailable.</p> : (
        <div className="space-y-2 text-xs" data-testid="cc-research">
          <p className="text-paper"><span className="font-semibold">{r.gate?.label ?? (r.status === "validated" ? "Validated" : "Insufficient data")}</span> · {r.sessions} labelled session(s), {r.rows} rows</p>
          {r.reason && <p className="text-muted">{r.reason}. No probabilities are shown.</p>}
          {r.gate?.reasons.map((x) => <p key={x} className="text-muted">• {x}</p>)}
          {models.length > 0 && (
            <table className="w-full min-w-[28rem] text-xs">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Model</th><th className="py-1 text-right font-normal">Log loss</th><th className="py-1 text-right font-normal">Brier</th><th className="py-1 text-right font-normal">Balanced acc.</th><th className="py-1 text-right font-normal">Calibration error</th></tr></thead>
              <tbody>
                {models.map(([k, m]) => (
                  <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{k.replace("_", " ")}</td><td className="num py-1 text-right">{m.log_loss.toFixed(3)}</td><td className="num py-1 text-right">{m.brier.toFixed(3)}</td><td className="num py-1 text-right">{m.balanced_accuracy == null ? MISSING : m.balanced_accuracy.toFixed(3)}</td><td className="num py-1 text-right">{m.calibration.ece.toFixed(3)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-muted">{r.note}</p>
        </div>
      )}
    </Card>
  );
}

const SETUP_TONE: Record<string, string> = { ACTIVE: "text-up", WATCH: "text-warn", BLOCKED: "text-down", REJECTED: "text-muted" };

function SetupRow({ c }: { c: SetupCandidate }) {
  const why = [...(c.rejected_because ?? []), ...(c.blocked_because ?? [])];
  return (
    <li className="border-t border-rule/50 py-2" data-testid="cc-setup">
      <div><span className={`mr-1 rounded-sm border px-1.5 py-px text-[11px] font-semibold ${SETUP_TONE[c.status] ?? ""} ${c.status === "ACTIVE" ? "border-up/50 bg-up/10" : c.status === "WATCH" ? "border-warn/50 bg-warn/10" : c.status === "BLOCKED" ? "border-down/50 bg-down/10" : "border-rule"}`}>{c.status}</span> <span className="text-paper">{c.setup.replaceAll("_", " ")}{c.direction ? ` · ${c.direction}` : ""}</span></div>
      <div className="text-muted">{c.entry_condition}</div>
      {c.entry_ref != null && <div className="num text-paper">Entry ~{c.entry_ref} · stop {c.stop} · target {c.target} · reward/risk {c.reward_risk ?? MISSING} · {c.lots} lot(s), max loss ₹{c.max_loss_rs} · costs ≈ {c.costs_pts} pts</div>}
      {c.levels && <div className="num text-paper">Range edges {c.levels.join(" – ")}</div>}
      <div className="text-[11px] text-muted">{c.reason}. Invalid if {c.invalidation}. {why.length > 0 ? `Not taken: ${why.join("; ")}.` : ""}</div>
    </li>
  );
}

function SetupMonitor({ d }: { d: IntradaySummary }) {
  const s = d.setups;
  return (
    <Card title="Setup monitor" className="lg:col-span-6" right={<span className="text-[11px] text-muted">read-only · no orders · no probabilities</span>}>
      {!s ? <p className="text-sm text-muted">Setups are not available.</p> : (
        <div className="space-y-2 text-xs" data-testid="cc-setups">
          <p className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-sm font-semibold ${s.decision.startsWith("NO TRADE") ? "border-warn/50 bg-warn/10 text-warn" : s.decision.includes("WATCH") ? "border-info/50 bg-info/10 text-info" : "border-up/50 bg-up/10 text-up"}`} data-testid="cc-setup-decision"><span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-current" />{s.decision}</p>
          {s.global_blockers.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-muted">Controls active:</span>{s.global_blockers.map((b) => <span key={b} className="rounded-sm border border-rule bg-slate-2 px-2 py-0.5 text-[11px] text-paper">{b}.</span>)}</div>}
          {s.candidates.length === 0 ? <p className="text-muted">No rule is met right now.</p> : <ul>{s.candidates.map((c) => <SetupRow key={`${c.setup}${c.direction}`} c={c} />)}</ul>}
          <p className="text-[11px] text-muted">{s.note}</p>
        </div>
      )}
    </Card>
  );
}

const rs = (v: number | null | undefined) => (v == null ? MISSING : `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);

function PaperResults() {
  const q = useQuery({ queryKey: ["intradayPaper"], queryFn: () => api.intradayPaper(), refetchInterval: 600_000, retry: false });
  const r = q.data;
  return (
    <Card title="Paper trading of the setups (after costs)" className="lg:col-span-6" right={<span className="text-[11px] text-muted">stored sessions · nothing is sent to a broker</span>}>
      {!r ? <p className="text-sm text-muted">{q.isLoading ? "Loading…" : "Paper results are unavailable."}</p> : (
        <div className="space-y-1 text-xs" data-testid="cc-paper">
          <p className="text-paper">{r.trades} trade(s) over {r.sessions} session(s). <span className="text-muted">{r.conclusion}.</span></p>
          {r.trades > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="cc-paper-tiles" aria-hidden="true">
              <Tile label="Net after costs" value={rs(r.net_rupees)} valueCls={tone(r.net_rupees)} accent={r.net_rupees >= 0 ? "border-l-up" : "border-l-down"} />
              <Tile label="Win rate" value={`${Math.round(Number(r.win_rate) * 100)}%`}><FillBar value={Number(r.win_rate)} max={1} color="bg-info" className="mt-1 w-full" /></Tile>
              <Tile label="Expectancy" value={rs(r.expectancy_rupees)} sub="per trade" valueCls={tone(r.expectancy_rupees)} />
              <Tile label="Profit factor" value={r.profit_factor == null ? MISSING : String(r.profit_factor)} />
              <Tile label="Max drawdown" value={rs(r.max_drawdown_rupees)} valueCls="text-down" />
            </div>
          )}
          {r.trades > 0 && <p className="num text-muted">Net ₹{r.net_rupees} (₹{r.gross_rupees_before_costs} before ₹{r.costs_and_slippage_rupees} of costs and slippage) · win rate {r.win_rate} · expectancy ₹{r.expectancy_rupees} per trade · profit factor {r.profit_factor ?? MISSING} · max drawdown ₹{r.max_drawdown_rupees}</p>}
          <p className="text-[11px] text-muted">Rules that can be rebuilt from the index path only (opening-range breakout and failed breakout); the index stands in for the future; {r.min_trades_for_a_conclusion} trades are needed before any conclusion.</p>
        </div>
      )}
    </Card>
  );
}

function Replay({ expiry }: { expiry: string }) {
  const sessions = useQuery({ queryKey: ["replaySessions"], queryFn: () => api.intradayReplaySessions(), retry: false });
  const [pick, setPick] = useState<{ session: string; at: string } | null>(null);
  const [session, setSession] = useState("");
  const [at, setAt] = useState("10:30");
  const list = sessions.data?.sessions ?? [];
  const chosen = session || list[list.length - 1]?.session || "";
  const res = useQuery({ queryKey: ["replay", pick?.session, expiry, pick?.at], queryFn: () => api.intradayReplay(pick!.session, expiry, pick!.at), enabled: !!pick, retry: false });
  const r = res.data;
  const s = r?.summary;
  return (
    <Card title="Session replay" className="lg:col-span-12" right={<span className="text-[11px] text-muted">only what was stored at that time</span>}>
      <div className="space-y-2 text-xs" data-testid="cc-replay">
        {list.length === 0 ? <p className="text-muted">No stored session to replay yet.</p> : (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setPick({ session: chosen, at }); }}>
            <label className="text-muted">Session <select aria-label="Replay session" className="ml-1 rounded border border-rule bg-slate px-1 py-0.5 text-paper" value={chosen} onChange={(e) => setSession(e.target.value)}>{list.map((x) => <option key={x.session} value={x.session}>{x.session} ({x.samples})</option>)}</select></label>
            <label className="text-muted">Time (IST) <input aria-label="Replay time" type="time" min="09:15" max="15:40" className="ml-1 rounded border border-rule bg-slate px-1 py-0.5 text-paper" value={at} onChange={(e) => setAt(e.target.value)} /></label>
            <button type="submit" className="rounded border border-rule px-2 py-0.5 text-paper hover:bg-slate">Show the dashboard as it was</button>
          </form>
        )}
        {res.isLoading && <p className="text-muted">Loading…</p>}
        {r && r.status !== "ok" && <p className="text-warn">{r.status}</p>}
        {r && s && (
          <div className="space-y-1" data-testid="cc-replay-result">
            <p className="text-paper">As of {fmtDateTimeIST(r.at)} (newest sample {fmtTimeIST(r.last_sample_at ?? r.at)}): <span className="font-semibold">{s.assessment.label}</span>{s.regime?.primary ? ` · ${s.regime.primary}` : ""}</p>
            <p className="num text-muted">Spot {s.market.last_sample_at ? "" : MISSING}{s.price?.last == null ? "" : fmtPrice(s.price.last)} · breakout {s.structure?.breakout?.status ?? "none"} · setups: {s.setups?.decision ?? MISSING}</p>
            <div className="mt-1 border-t border-rule/50 pt-1">
              <p className="text-warn">After the fact (not known at the time shown):</p>
              <ul className="num text-muted">{Object.entries(r.after_the_fact ?? {}).map(([h, o]) => <li key={h}>{h} min: {o?.outcome ?? MISSING}{o?.minutes_to_touch != null ? ` after ${o.minutes_to_touch} min` : ""}{o?.reason ? ` (${o.reason})` : ""}</li>)}</ul>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function Sectors({ d }: { d: IntradaySummary }) {
  const colors = useChartColors();
  const m = d.stocks;
  const rows = (m?.sectors.nifty500 ?? []).filter((r) => r.equal_weight_return != null);
  return (
    <Card title="Sectors" className="lg:col-span-12" right={<span className="text-[11px] text-muted">equal-weighted NIFTY 500 stocks · ranked by strength against the index</span>}>
      {rows.length === 0 ? <p className="text-sm text-muted">{m ? "No sector has enough priced stocks yet." : "Stock breadth is turned off."}</p> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div style={{ height: Math.max(160, rows.length * 24 + 12) }}><EChart option={divergingBarOption(rows.map((r) => ({ name: r.sector, value: r.equal_weight_return as number })), colors)} ariaLabel="Sector returns, equal-weighted" /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs" data-testid="cc-sectors">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">#</th><th className="py-1 font-normal">Sector</th><th className="py-1 text-right font-normal">Return</th><th className="py-1 text-right font-normal">vs index</th><th className="py-1 text-right font-normal">Up / down</th><th className="py-1 text-right font-normal">Volume vs normal</th><th className="py-1 text-right font-normal">Priced</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sector} className="border-t border-rule/50">
                  <td className="num py-1 text-muted">{r.rank ?? MISSING}</td>
                  <td className="py-1 text-paper">{r.sector}</td>
                  <td className={`num py-1 text-right ${tone(r.equal_weight_return)}`}>{fmtPct(r.equal_weight_return)}</td>
                  <td className={`num py-1 text-right ${tone(r.relative_strength)}`}>{r.relative_strength == null ? MISSING : `${r.relative_strength >= 0 ? "+" : "−"}${Math.abs(r.relative_strength).toFixed(2)}`}</td>
                  <td className="num py-1 text-right text-muted">{r.advancing} / {r.declining}</td>
                  <td className={`num py-1 text-right ${r.weighted_rv != null && r.weighted_rv < 0.7 ? "text-warn" : "text-muted"}`}>{r.weighted_rv == null ? MISSING : `${r.weighted_rv.toFixed(2)}x`}</td>
                  <td className="num py-1 text-right text-muted">{r.covered}/{r.stocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      )}
      {m && m.sectors.rotation.length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid="cc-rotation">Rotation since the last sample: {m.sectors.rotation.map((r) => `${r.sector} ${r.direction === "up" ? "▲" : "▼"} ${r.from_rank}→${r.to_rank}`).join(", ")}.</p>
      )}
    </Card>
  );
}

function Context({ d }: { d: IntradaySummary }) {
  return (
    <Card title="Intraday decision context" className="lg:col-span-4">
      <dl className="space-y-2">
        {d.context.map((c) => (
          <div key={c.question} className={`rounded-sm border-l-2 bg-slate-2/40 px-2.5 py-1.5 ${/^(Unclassified|Not enough|Not available|n\/a)/i.test(c.answer) ? "border-rule" : "border-info/70"}`}>
            <dt className="text-xs font-semibold text-paper">{c.question}</dt>
            <dd className="text-xs text-muted">{c.answer}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * Key levels as one list sorted by price, with the current price placed among them. Each level shows how far it
 * is from the current price (points and %), so what is nearest above and below is clear at a glance.
 * Levels within 0.02% of each other are shown as separate rows, never merged, because they have different sources.
 */
function Levels({ d }: { d: IntradaySummary }) {
  const price = d.price.last;
  const have = d.levels.filter((l): l is typeof l & { value: number } => l.value != null && (price == null || Math.abs(l.value / price - 1) < 0.1));
  const missing = d.levels.filter((l) => l.value == null);
  const far = d.levels.filter((l) => l.value != null && price != null && Math.abs((l.value as number) / price - 1) >= 0.1);
  const sorted = [...have].sort((a, b) => b.value - a.value);
  const reach = price == null ? 1 : Math.max(...sorted.map((l) => Math.abs(l.value - price)), 1);
  const nowAt = price == null ? -1 : sorted.findIndex((l) => l.value < price);
  const nowIndex = price == null ? -1 : nowAt === -1 ? sorted.length : nowAt;
  const nearestAbove = price == null ? null : [...sorted].reverse().find((l) => l.value >= price) ?? null;
  const nearestBelow = price == null ? null : sorted.find((l) => l.value < price) ?? null;
  const row = (l: (typeof sorted)[number]) => {
    const dist = price == null ? null : l.value - price;
    const above = dist != null && dist >= 0;
    return (
      <li key={l.name} className="grid grid-cols-[1fr_auto_5.5rem] items-center gap-2 border-b border-rule/40 py-1 text-xs"
        title={`${l.method}${l.source ? ` · ${l.source}` : ""}${l.as_of ? ` · ${l.as_of}` : ""}`}>
        <span className="truncate text-paper">{l.name}</span>
        <span className="num text-right font-semibold text-paper">{fmtPrice(l.value)}</span>
        <span className="flex items-center gap-1" aria-label={dist == null ? "distance unavailable" : `${Math.abs(dist).toFixed(0)} points ${above ? "above" : "below"}`}>
          <span className="relative h-1.5 flex-1 rounded-sm bg-slate-2">
            {dist != null && <span className={`absolute top-0 h-full rounded-sm ${above ? "left-0 bg-info/70" : "right-0 bg-brass/70"}`} style={{ width: `${Math.max(4, (Math.abs(dist) / reach) * 100)}%` }} />}
          </span>
          <span className="num w-12 text-right text-[11px] text-muted">{dist == null ? "—" : `${above ? "+" : "−"}${Math.abs(dist).toFixed(0)}`}</span>
        </span>
      </li>
    );
  };
  const now = (
    <li key="now" className="my-0.5 flex items-center justify-between rounded-sm border border-brass bg-brass/10 px-2 py-1 text-xs font-semibold text-brass" data-testid="levels-now">
      <span>Now</span><span className="num">{price == null ? "—" : fmtPrice(price)}</span>
      <span className="text-[11px] font-normal text-muted">{d.price.change_pct == null ? "" : `${d.price.change_pct >= 0 ? "+" : "−"}${Math.abs(d.price.change_pct).toFixed(2)}% on prev close`}</span>
    </li>
  );
  return (
    <Card title="Key levels" className="lg:col-span-4" right={<span className="text-[11px] text-muted">points from the current price</span>}>
      {price != null && (nearestAbove || nearestBelow) && (
        <div className="mb-2 grid grid-cols-2 gap-2 text-xs" data-testid="levels-nearest">
          <div className="rounded-sm border border-rule bg-slate-2/60 px-2 py-1"><div className="text-[10px] uppercase tracking-wide text-muted">Nearest above</div>
            {nearestAbove ? <><div className="truncate text-paper">{nearestAbove.name}</div><div className="num text-info">{fmtPrice(nearestAbove.value)} · +{(nearestAbove.value - price).toFixed(0)}</div></> : <div className="text-muted">none listed</div>}</div>
          <div className="rounded-sm border border-rule bg-slate-2/60 px-2 py-1"><div className="text-[10px] uppercase tracking-wide text-muted">Nearest below</div>
            {nearestBelow ? <><div className="truncate text-paper">{nearestBelow.name}</div><div className="num text-brass">{fmtPrice(nearestBelow.value)} · −{(price - nearestBelow.value).toFixed(0)}</div></> : <div className="text-muted">none listed</div>}</div>
        </div>
      )}
      <ul data-testid="ladder" aria-label="Key levels sorted by price">
        {sorted.slice(0, Math.max(nowIndex, 0)).map(row)}
        {price != null && now}
        {sorted.slice(Math.max(nowIndex, 0)).map(row)}
      </ul>
      {missing.length > 0 && (
        <ul className="mt-1" aria-label="Levels not available">
          {missing.map((l) => (
            <li key={l.name} className="flex items-center justify-between border-b border-rule/40 py-1 text-xs" title={`${l.method}${l.source ? ` · ${l.source}` : ""}${l.as_of ? ` · ${l.as_of}` : ""}`}>
              <span className="text-muted">{l.name}</span><span className="text-muted">n/a</span>
            </li>
          ))}
        </ul>
      )}
      {far.length > 0 && <p className="mt-2 text-[11px] text-muted">Not on the list (over 10% from price): {far.map((l) => l.name).join(", ")}.</p>}
      <p className="mt-2 text-[11px] text-muted">Hover a row for source, method and time. OI concentrations are positioning, not guaranteed support/resistance.</p>
    </Card>
  );
}

function Options({ d }: { d: IntradaySummary }) {
  const o = d.options;
  return (
    <Card title="Options positioning" className="lg:col-span-4" right={<span className="text-[11px] text-muted">{o.universe} · {d.expiry}</span>}>
      <div className="mb-3 grid grid-cols-2 items-center gap-3" data-testid="cc-options-visual">
        <Gauge label="Put-call ratio (OI)" value={o.pcr_oi} min={0.4} max={1.6} zones={[{ to: 0.7, color: "var(--down)" }, { to: 1.0, color: "var(--muted)" }, { to: 1.3, color: "var(--info)" }, { to: 1.6, color: "var(--up)" }]} text={o.pcr_oi == null ? MISSING : o.pcr_oi.toFixed(2)} sub="PCR (OI) · a ratio, not a signal" />
        <div className="space-y-2 text-[11px] text-muted">
          <div>Total OI: call vs put<SplitBar a={o.ce_oi} b={o.pe_oi} label="Total call OI versus put OI" /></div>
          <div>Change vs prev day (size)<SplitBar a={o.ce_oi_chg == null ? null : Math.abs(o.ce_oi_chg)} b={o.pe_oi_chg == null ? null : Math.abs(o.pe_oi_chg)} label="Call OI change versus put OI change" /></div>
        </div>
      </div>
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
    <Card title="Global, sectors & flows" className="lg:col-span-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Last completed sessions</h4>
          <table className="w-full text-xs"><tbody>
            {d.global.map((g) => (
              <tr key={g.key} className="border-b border-rule/40 last:border-0">
                <td className="py-0.5 pr-2 text-muted">{g.name}</td>
                <td className={`num py-0.5 text-right ${tone(g.ret_pct)}`}><span className="mr-2">{fmtPct(g.ret_pct)}</span><MiniBar value={g.ret_pct} scale={3} className="w-14" /></td>
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
                <td className={`num py-0.5 text-right ${tone(s.ret_pct)}`}><span className="mr-2">{fmtPct(s.ret_pct)}</span><MiniBar value={s.ret_pct} scale={3} className="w-14" /></td>
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
          <Chip>{d.ml.model_trained ? d.ml.stage_name : "No model yet"}</Chip>
        </div>
        <p className="mt-1 text-xs text-muted">{d.ml.reason}</p>
        <ol className="mt-2 grid grid-cols-4 gap-1" aria-label="Intraday model stages">
          {d.ml.stages.map((st) => {
            const done = d.ml.labelled_sessions >= st.from_sessions;
            return (
              <li key={st.id} title={st.what} className={`rounded-sm border px-1 py-1 text-center text-[10px] leading-tight ${done ? "border-accent/60 text-paper" : "border-rule text-muted"}`}>
                <span className="block font-semibold">{st.from_sessions}+</span>{st.name}
              </li>
            );
          })}
        </ol>
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
    refetchInterval: 15_000,
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
          <div className="flex flex-wrap gap-3">
            <Sentiment d={d} />
            <Evidence d={d} />
            <Regime d={d} />
            <Breadth d={d} />
            <Heavyweights d={d} />
            <Breakout d={d} />
            <SetupMonitor d={d} />
            <Volatility d={d} />
            <Positioning d={d} />
            <FlowCard d={d} />
            <Sectors d={d} />
            <ModelResearch />
            {expiry && <ForwardCheckCard expiry={expiry} />}
            <PaperResults />
            <Replay expiry={d.expiry} />
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
