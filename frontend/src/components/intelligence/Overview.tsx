import { Link } from "react-router-dom";
import { fmtInt, fmtTimeIST, MISSING } from "../../lib/format";
import { ENGINE_ORDER, freshLabel, signed, toneOf, type EngineView, type Intelligence } from "../../lib/intelligence";

const bar = (s: number) => `${Math.max(0, Math.min(100, (s + 100) / 2))}%`;

/** Score on a -100..+100 scale: a plain bar with a marker, no decorative gauge. */
export function ScoreBar({ score }: { score: number | null }) {
  return (
    <div className="relative mt-1 h-2 w-full rounded-sm bg-slate-2" role="img" aria-label={score == null ? "no score" : `score ${score.toFixed(0)} on a scale of minus 100 to plus 100`}>
      <div className="absolute left-1/2 top-0 h-2 w-px bg-rule" />
      {score != null && <div className={`absolute top-[-2px] h-3 w-1.5 rounded-sm ${score >= 15 ? "bg-up" : score <= -15 ? "bg-down" : "bg-muted"}`} style={{ left: `calc(${bar(score)} - 3px)` }} />}
    </div>
  );
}

/** The 10-second answer: direction, score, confidence, regime, volatility regime, data quality. */
export function CommandStrip({ d, compact = false }: { d: Intelligence; compact?: boolean }) {
  const s = d.sentiment;
  const insufficient = s.score == null;
  const failed = Object.entries(d.status).filter(([, v]) => !v.ok).map(([k]) => k);
  const stale = d.engines.filter((e) => e.freshness.fresh === false).map((e) => e.name);
  const cell = (label: string, value: string, sub?: string, cls = "text-paper") => (
    <div className="min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className={`num truncate text-lg font-semibold ${cls}`}>{value}</div>{sub && <div className="truncate text-[11px] text-muted">{sub}</div>}</div>
  );
  return (
    <section aria-label="Market sentiment" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-command">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">NIFTY 50 market sentiment</div>
          <div className={`text-2xl font-semibold ${toneOf(s.score)}`} data-testid="mi-class">{insufficient ? "INSUFFICIENT DATA – SENTIMENT UNRELIABLE" : s.class}</div>
          <div className="num text-sm text-muted" data-testid="mi-score">{insufficient ? (s.reason ?? "") : `Directional score ${signed(s.score)} / 100`}</div>
          <ScoreBar score={s.score} />
        </div>
        {cell("Confidence", s.confidence == null ? MISSING : `${s.confidence.toFixed(0)} / 100`, s.confidence_parts ? `coverage ${(s.confidence_parts.coverage_factor * 100).toFixed(0)}% · agreement ${(s.confidence_parts.agreement * 100).toFixed(0)}% · freshness ${(s.confidence_parts.freshness * 100).toFixed(0)}%` : "needs enough engines")}
        {cell("Market regime", d.regime.name, d.regime.previous ? `was ${d.regime.previous}` : "no earlier regime recorded today")}
        {cell("Volatility regime", s.volatility_regime, `gamma ${d.regime.gamma}`)}
      </div>
      {!compact && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-rule pt-3 sm:grid-cols-4 lg:grid-cols-6">
          {cell("Trend strength", s.trend_strength == null ? MISSING : `${s.trend_strength}`, "efficiency ratio × 100")}
          {cell("Signal quality", s.signal_quality ?? MISSING, "from confidence")}
          {cell("Data coverage", `${(s.data_completeness * 100).toFixed(0)}%`, `${s.engines_available} of ${d.engines.length} engines`)}
          {cell("Agreement", s.agreement == null ? MISSING : `${(s.agreement * 100).toFixed(0)}%`, "weight on the same side")}
          {cell("Last updated", fmtTimeIST(d.generated_at), `expiry ${d.expiry ?? MISSING}`)}
          {cell("Computed in", `${Math.round(d.compute_ms)} ms`, "server aggregation")}
        </div>
      )}
      {(failed.length > 0 || stale.length > 0) && (
        <p className="mt-2 text-xs text-warn" data-testid="mi-quality" role="status">
          {failed.length > 0 && <>Inputs not available: {failed.join(", ")}. </>}{stale.length > 0 && <>Stale, not shown as live: {stale.join("; ")}.</>}
        </p>
      )}
    </section>
  );
}

function Pulse({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="rounded-sm bg-slate-2 px-2.5 py-2" data-testid="mi-pulse"><div className="truncate text-[11px] text-muted">{label}</div><div className={`num truncate text-[15px] font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="truncate text-[10px] text-muted">{sub}</div>}</div>;
}

export function PulseCards({ d }: { d: Intelligence }) {
  const p = d.pulse;
  const n = (v: number | null | undefined, dp = 2) => (v == null ? MISSING : v.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp }));
  const sgn = (v: number | null | undefined, dp = 2) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}`);
  const col = (v: number | null | undefined) => (v == null || v === 0 ? undefined : v > 0 ? "text-up" : "text-down");
  return (
    <section aria-label="Market pulse" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-9" data-testid="mi-pulses">
      <Pulse label="NIFTY spot" value={n(p.spot)} sub={`${sgn(p.change_pct)}% day`} tone={col(p.change_pct)} />
      <Pulse label="Futures" value={n(p.futures)} sub={p.basis == null ? undefined : `basis ${sgn(p.basis, 1)} (${sgn(p.basis_pct, 2)}%)`} />
      <Pulse label={`ATM ${p.atm_strike ?? ""}`} value={`${n(p.atm_ce_premium, 1)} / ${n(p.atm_pe_premium, 1)}`} sub="CE / PE premium" />
      <Pulse label="ATM IV" value={p.atm_iv == null ? MISSING : `${p.atm_iv.toFixed(2)}%`} sub={`expiry ${p.expiry ?? MISSING}`} />
      <Pulse label="India VIX" value={p.india_vix.value == null ? MISSING : p.india_vix.value.toFixed(2)} sub={p.india_vix.as_of ? `${p.india_vix.as_of} close (not live)` : "daily close"} />
      <Pulse label="PCR (OI)" value={n(p.pcr)} />
      <Pulse label="Net GEX" value={p.net_gex == null ? MISSING : `${n(p.net_gex, 1)} cr`} sub="model sign" tone={col(p.net_gex)} />
      <Pulse label="Gamma flip" value={p.gamma_flip == null ? MISSING : fmtInt(Math.round(p.gamma_flip))} sub={d.gex.flip_distance_pct == null ? undefined : `spot ${sgn(d.gex.flip_distance_pct)}% from it`} />
      <Pulse label="Futures OI change" value={p.futures_oi_change == null ? MISSING : sgn(p.futures_oi_change, 0)} sub="vs baseline" tone={col(p.futures_oi_change)} />
      <Pulse label="Futures CVD" value={p.futures_cvd_pct == null ? MISSING : `${sgn(p.futures_cvd_pct, 1)}%`} sub="estimate (proxy)" tone={col(p.futures_cvd_pct)} />
      <Pulse label="Futures VWAP" value={n(p.futures_vwap)} sub="future's own VWAP" />
      <Pulse label="Heavyweight CVD" value={p.heavyweight_cvd == null ? MISSING : sgn(p.heavyweight_cvd, 0)} sub="normalised, weighted (estimate)" tone={col(p.heavyweight_cvd)} />
    </section>
  );
}

function EngineCard({ e }: { e: EngineView }) {
  const lbl = freshLabel(e);
  return (
    <article className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid={`mi-engine-${e.key}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-paper">{e.name}</h3>
        <span className="num shrink-0 text-[11px] text-muted" title="weight in the fused score">w {e.weight}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2"><span className={`num text-xl font-semibold ${toneOf(e.score)}`}>{e.score == null ? MISSING : signed(e.score)}</span><span className={`text-xs ${toneOf(e.score)}`}>{e.score == null ? "Unavailable" : e.tilt}</span></div>
      <p className={`text-[11px] ${e.freshness.fresh === false ? "text-warn" : "text-muted"}`}>{lbl}{e.contribution != null && ` · contributes ${signed(e.contribution, 1)}`}</p>
      <ScoreBar score={e.score} />
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-info">Evidence</summary>
        <ul className="mt-1 space-y-1">
          {e.terms.map((t) => (
            <li key={t.name} className={t.available ? "text-muted" : "text-muted/70"}>
              <span className="text-paper">{t.name}</span> {t.available ? <span className={`num ${toneOf(t.score)}`}>{signed(t.score)}</span> : <span className="text-warn">unavailable</span>}{t.proxy && <span className="ml-1 rounded-sm border border-warn/40 px-1 text-[10px] text-warn">proxy</span>}
              <div className="text-[11px]">{t.detail}</div>
            </li>
          ))}
        </ul>
        {e.conflicting.length > 0 && <p className="mt-1 text-[11px] text-warn">Conflicting: {e.conflicting.join("; ")}</p>}
      </details>
      <Link to={e.link} className="mt-2 text-xs text-info hover:underline">Open detailed analysis →</Link>
    </article>
  );
}

export function EngineMatrix({ d }: { d: Intelligence }) {
  const by = new Map(d.engines.map((e) => [e.key, e]));
  return (
    <section aria-label="Engine sentiment matrix">
      <h2 className="mb-2 text-sm font-semibold text-paper">Engine sentiment matrix <span className="font-normal text-muted">· each engine scored −100 to +100 from existing analytics; an unavailable engine is left out, not scored neutral</span></h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="mi-engines">{ENGINE_ORDER.map((k) => by.get(k)).filter((e): e is EngineView => !!e).map((e) => <EngineCard key={e.key} e={e} />)}</div>
    </section>
  );
}

export function Interpretation({ d }: { d: Intelligence }) {
  const sc = d.scenarios;
  const inv = d.sentiment.score != null && d.sentiment.score >= 15 ? sc.bullish?.invalidation : d.sentiment.score != null && d.sentiment.score <= -15 ? sc.bearish?.invalidation : sc.sideways?.invalidation;
  return (
    <section aria-label="Market interpretation" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-interpretation">
      <h2 className="mb-1 text-sm font-semibold text-paper">Market interpretation <span className="font-normal text-muted">· generated from the readings above</span></h2>
      <p className="text-sm leading-relaxed text-paper">{d.interpretation}</p>
      {d.regime.evidence.length > 0 && <p className="mt-2 text-xs text-muted">Regime evidence: {d.regime.evidence.join("; ")}.</p>}
      <p className="mt-1 text-xs text-warn" data-testid="mi-invalidation">What would weaken this view: {inv ?? "needs levels (VWAP, walls or open-interest strikes) that are not available yet"}.</p>
      <p className="mt-1 text-[11px] text-muted">A description of what the indicators show, not a forecast or a trade signal. Weights and thresholds are provisional and not fitted to history.</p>
    </section>
  );
}
