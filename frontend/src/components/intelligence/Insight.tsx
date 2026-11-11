import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtInt, fmtTimeIST, MISSING } from "../../lib/format";
import { ENGINE_ORDER, signed, toneOf, type AlertRow, type Divergence, type Intelligence, type Scenarios, type TimelinePoint } from "../../lib/intelligence";
import { EChart, useChartColors } from "../EChart";

const SEV: Record<string, string> = { high: "border-down/60 text-down", medium: "border-warn/60 text-warn", low: "border-rule text-muted" };
const STATUS: Record<string, string> = { "early warning": "text-warn", developing: "text-info", confirmed: "text-up", invalidated: "text-muted" };

export function DivergencePanel({ d }: { d: Intelligence }) {
  const rows: Divergence[] = d.divergences;
  return (
    <section aria-label="Divergences" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-divergences">
      <h2 className="mb-1 text-sm font-semibold text-paper">Cross-engine divergences <span className="font-normal text-muted">· a divergence is a description, never a reversal signal</span></h2>
      {rows.length === 0 ? <p className="text-sm text-muted" data-testid="mi-no-div">No divergence detected between the engines at this moment.</p> : (
        <ul className="space-y-2">
          {rows.map((x) => (
            <li key={x.id} className="rounded-sm border border-rule bg-slate-2/50 p-2.5 text-sm" data-testid="mi-div">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-paper">{x.name}</span>
                <span className={`rounded-sm border px-1.5 py-px text-[11px] ${SEV[x.severity]}`}>{x.severity}</span>
                <span className={`text-[11px] ${STATUS[x.status]}`}>{x.status}{x.since ? ` since ${fmtTimeIST(x.since)}` : ""}</span>
                <span className="text-[11px] text-muted">{x.kind === "confirmation" ? "confirms" : "leans"} {x.direction}</span>
              </div>
              <p className="mt-1 text-xs text-paper">Now: {x.reading}</p>
              {x.previous && x.previous !== x.reading && <p className="text-[11px] text-muted">Earlier: {x.previous}</p>}
              <p className="text-[11px] text-muted">{x.explanation}</p>
              {x.evidence && x.evidence.length > 0 && <p className="text-[11px] text-muted" data-testid="mi-div-evidence">Evidence{x.at ? ` as of ${fmtTimeIST(x.at)}` : ""}: {x.evidence.join(" · ")}</p>}
              <p className="text-[11px] text-warn">Invalidated if: {x.invalidation}</p>
            </li>
          ))}
        </ul>
      )}
      {d.divergences_invalidated.length > 0 && <p className="mt-2 text-[11px] text-muted">Invalidated since the last minute: {d.divergences_invalidated.map((x) => x.id).join(", ")}.</p>}
      <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer text-info">Checks that cannot be made today</summary><ul className="mt-1 list-disc pl-5">{d.divergences_unavailable.map((u) => <li key={u}>{u}</li>)}</ul></details>
    </section>
  );
}

const lvl = (v: number | null | undefined) => (v == null ? MISSING : fmtInt(Math.round(v)));

export function ScenarioPanel({ s }: { s: Scenarios }) {
  if (!s.available) return <section aria-label="Scenarios" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="mi-scenarios">Scenarios need a fused sentiment: {s.reason ?? "insufficient data"}.</section>;
  const card = (title: string, tone: string, sc: NonNullable<Scenarios["bullish"]>, rows: [string, string][]) => (
    <article className="rounded-sm border border-rule bg-slate-2/50 p-3" data-testid={`mi-scenario-${title.toLowerCase()}`}>
      <div className="flex items-baseline justify-between"><h3 className={`text-sm font-semibold ${tone}`}>{title}</h3><span className="num text-lg font-semibold text-paper">{sc.score}</span></div>
      <dl className="mt-1 space-y-0.5 text-xs">{rows.map(([k, v]) => <div key={k}><dt className="inline text-muted">{k}: </dt><dd className="inline text-paper">{v}</dd></div>)}</dl>
      {sc.supporting && sc.supporting.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-muted">{sc.supporting.slice(0, 4).map((t) => <li key={t}>{t}</li>)}</ul>}
    </article>
  );
  const b = s.bullish!, r = s.bearish!, w = s.sideways!;
  return (
    <section aria-label="Scenarios" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-scenarios">
      <h2 className="mb-1 text-sm font-semibold text-paper">Market scenarios <span className="font-normal text-warn">· {s.label}</span></h2>
      <div className="grid gap-3 md:grid-cols-3">
        {card("Bullish", "text-up", b, [["Resistance", lvl(b.resistance)], ["Confirmation", b.confirmation ?? MISSING], ["Invalidation", b.invalidation ?? MISSING]])}
        {card("Bearish", "text-down", r, [["Support", lvl(r.support)], ["Confirmation", r.confirmation ?? MISSING], ["Invalidation", r.invalidation ?? MISSING]])}
        {card("Sideways", "text-muted", w, [["Expected range", `${lvl(w.range?.[0])} to ${lvl(w.range?.[1])}`], ["Gamma", w.gamma ?? MISSING], ["Invalidation", w.invalidation ?? MISSING]])}
      </div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[26rem] text-xs" data-testid="mi-horizons">
        <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Horizon</th><th className="py-1 text-right font-normal">One standard deviation (ATM IV), points</th></tr></thead>
        <tbody>{(s.horizons ?? []).map((h) => <tr key={h.horizon} className="border-t border-rule/50"><td className="py-1 text-paper">{h.horizon}</td><td className="num py-1 text-right text-muted">{h.one_sd_points == null ? MISSING : `±${h.one_sd_points.toFixed(0)}`}</td></tr>)}</tbody>
      </table></div>
      <p className="mt-1 text-[11px] text-muted">The ranges are the move implied by ATM IV over each horizon, spot × IV × √(minutes ÷ (252 × 375)); an estimate of dispersion, not a forecast, and no predictive accuracy is claimed.</p>
    </section>
  );
}

/** Reading of one recorded minute: every value shown is a stored value of that minute. */
export function MinuteReading({ p }: { p: TimelinePoint }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-6" data-testid="mi-minute">
      {([["Time", fmtTimeIST(p.at)], ["NIFTY", p.spot == null ? MISSING : fmtInt(Math.round(p.spot))], ["Score", p.score == null ? "insufficient data" : signed(p.score)], ["Evidence quality", p.confidence == null ? MISSING : p.confidence.toFixed(0)], ["Regime", p.regime ?? MISSING],
        ["Gamma", p.gamma_regime ?? MISSING], ["Futures CVD % (Proxy)", p.metrics.cvd_pct == null ? MISSING : String(p.metrics.cvd_pct)], ["Net GEX", p.metrics.net_gex == null ? MISSING : String(p.metrics.net_gex)], ["ATM IV", p.metrics.atm_iv == null ? MISSING : String(p.metrics.atm_iv)],
        ["Heavy CVD (Proxy)", p.metrics.heavy_cvd == null ? MISSING : String(p.metrics.heavy_cvd)], ["Futures OI chg", p.metrics.fut_oi_change == null ? MISSING : String(p.metrics.fut_oi_change)], ["Divergences", p.divs.length ? p.divs.map((x) => x.id).join(", ") : "none"]] as [string, string][]).map(([l, v]) => (
        <div key={l} className="rounded-sm bg-slate-2 p-2"><div className="text-[11px] text-muted">{l}</div><div className="num truncate text-paper">{v}</div></div>
      ))}
      <div className="col-span-2 rounded-sm bg-slate-2 p-2 sm:col-span-4 lg:col-span-6"><div className="text-[11px] text-muted">Engine scores at that minute</div>
        <div className="num text-paper">{ENGINE_ORDER.map((k) => `${k} ${p.engines[k] == null ? "—" : signed(p.engines[k] as number)}`).join(" · ")}</div></div>
    </div>
  );
}

export function TimelinePanel() {
  const c = useChartColors();
  const q = useQuery({ queryKey: ["mi-timeline"], queryFn: () => api.intelligenceTimeline(), refetchInterval: 30_000, retry: false });
  const [sel, setSel] = useState<number | null>(null);
  const pts = q.data?.points ?? [];
  const idx = sel == null ? pts.length - 1 : Math.min(sel, pts.length - 1);
  const opt = useMemo(() => pts.length < 2 ? null : {
    animation: false, grid: { left: 46, right: 56, top: 34, bottom: 34 },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: pts.map((p) => fmtTimeIST(p.at)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", min: -100, max: 100, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } }],
    series: [
      { name: "Sentiment score", type: "line", showSymbol: false, connectNulls: false, data: pts.map((p) => p.score), lineStyle: { color: c.brass, width: 2 } },
      { name: "Evidence quality", type: "line", showSymbol: false, data: pts.map((p) => p.confidence), lineStyle: { color: c.info, width: 1, type: "dashed" } },
      { name: "NIFTY", type: "line", yAxisIndex: 1, showSymbol: false, data: pts.map((p) => p.spot), lineStyle: { color: c.muted, width: 1 } },
    ],
  }, [pts, c]);
  return (
    <section aria-label="Market timeline" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-timeline">
      <h2 className="mb-1 text-sm font-semibold text-paper">Intraday timeline <span className="font-normal text-muted">· only minutes that were recorded</span></h2>
      {q.isLoading && <div className="h-24 animate-pulse rounded-sm bg-slate-2" aria-label="Loading" />}
      {q.isError && <p role="alert" className="text-sm text-down">The timeline could not be loaded.</p>}
      {q.data && pts.length === 0 && <p className="text-sm text-muted" data-testid="mi-timeline-empty">No minute has been recorded for {q.data.session} yet. The dashboard starts recording when it runs during market hours; earlier minutes are not reconstructed.</p>}
      {opt && (
        <>
          <div style={{ height: 240 }}><EChart option={opt} ariaLabel="Sentiment score, evidence quality and NIFTY through the session" /></div>
          <label className="mt-1 flex items-center gap-2 text-xs text-muted">Inspect minute
            <input type="range" min={0} max={pts.length - 1} value={idx} onChange={(e) => setSel(Number(e.target.value))} aria-label="Inspect minute" className="w-full max-w-md" />
            <span className="num text-paper">{pts[idx] ? fmtTimeIST(pts[idx]!.at) : ""}</span>
          </label>
        </>
      )}
      {pts[idx] && <MinuteReading p={pts[idx]!} />}
      {q.data && <p className="mt-1 text-[11px] text-muted">{q.data.recorded} minutes recorded for {q.data.session}. {q.data.note}</p>}
    </section>
  );
}

export function AlertsPanel({ alerts }: { alerts: AlertRow[] }) {
  return (
    <section aria-label="Alert centre" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-alerts">
      <h2 className="mb-1 text-sm font-semibold text-paper">Alert centre <span className="font-normal text-muted">· raised from changes between recorded minutes; the same alert is not repeated inside 10 minutes</span></h2>
      {alerts.length === 0 ? <p className="text-sm text-muted" data-testid="mi-no-alerts">No alert has been raised today.</p> : (
        <ul className="space-y-2">{alerts.map((a) => (
          <li key={a.id} className="rounded-sm border border-rule bg-slate-2/50 p-2 text-xs" data-testid="mi-alert">
            <div className="flex flex-wrap items-center gap-2"><span className="text-muted">{fmtTimeIST(a.at)}</span><span className="font-medium text-paper">{a.kind}</span><span className={`rounded-sm border px-1.5 text-[11px] ${SEV[a.severity] ?? ""}`}>{a.severity}</span><span className={`text-[11px] ${toneOf(a.direction === "bullish" ? 50 : a.direction === "bearish" ? -50 : 0)}`}>{a.direction}</span></div>
            <p className="text-paper">{a.text}</p>
            {a.evidence.length > 0 && <p className="text-muted">Evidence: {a.evidence.join("; ")}</p>}
            <p className="text-muted">Confirmed by: {a.confirmation}. Invalidated if: {a.invalidation}.</p>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
