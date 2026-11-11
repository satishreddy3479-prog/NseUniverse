import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtTimeIST, MISSING } from "../lib/format";
import { DetailPanels } from "../components/intelligence/Detail";
import { AlertsPanel, DivergencePanel, ScenarioPanel, TimelinePanel } from "../components/intelligence/Insight";
import { CommandStrip, EngineMatrix, Interpretation, PulseCards } from "../components/intelligence/Overview";
import { HeavyweightPanel } from "../components/intelligence/Heavyweight";
import { IntradayMlPanel } from "../components/intelligence/IntradayMl";
import { StraddleSummaryCard } from "../components/intelligence/StraddleDecay";

const LABELS: Record<string, string> = { flow: "Stored per-minute flow (rolling CVD)", market: "Market flow, breadth and heavyweights", intraday: "Command centre (stored chain)", futures: "Futures series", skew: "Volatility skew", momentum: "IV momentum", positioning: "Strike positioning", gex: "GEX (rebuilt)", vix: "India VIX, HV and RV (daily closes)", heavymeta: "Heavyweight index weights", ml: "Intraday ML research" };
const STATE_TONE: Record<string, string> = { AVAILABLE: "text-up", PARTIAL: "text-warn", UNAVAILABLE: "text-down" };

/** NIFTY 50 Market Intelligence: one page that fuses the existing analytics into a sentiment, a regime and the evidence behind them. */
export function MarketIntelligence() {
  const q = useQuery({ queryKey: ["intelligence"], queryFn: () => api.intelligenceSummary(), refetchInterval: 5_000, retry: false });
  if (q.isPending) return <div className="mx-auto max-w-[1500px] space-y-3" aria-label="Loading the market intelligence dashboard"><div className="h-32 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" /><div className="h-48 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" /></div>;
  if (q.isError || !q.data) return <p role="alert" className="mx-auto max-w-[1500px] rounded-sm border border-down/50 p-3 text-sm text-down">The market intelligence dashboard could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}. The individual analysis pages are unaffected.</p>;
  const d = q.data;
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="mi-page">
      <header><h1 className="text-xl font-semibold md:text-2xl">NIFTY 50 Market Intelligence</h1><p className="text-xs text-muted">Reads the existing engines, fuses them, and shows the evidence. Session {d.session}, expiry {d.expiry ?? MISSING}, updated {fmtTimeIST(d.generated_at)} IST.</p></header>
      <CommandStrip d={d} />
      <PulseCards d={d} />
      <EngineMatrix d={d} />
      <HeavyweightPanel d={d} />
      <IntradayMlPanel d={d} />
      <StraddleSummaryCard />
      <Interpretation d={d} />
      {(d.observations ?? []).length > 0 && (
        <section aria-label="Conflicting and confirming readings" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-observations">
          <h2 className="mb-1 text-sm font-semibold text-paper">Readings side by side <span className="font-normal text-muted">· described, never read as a reversal</span></h2>
          <ul className="space-y-2 text-sm">{(d.observations ?? []).map((o) => <li key={o.id} data-testid="mi-observation"><span className="font-medium text-paper">{o.title}.</span> <span className="text-paper">{o.reading}.</span> <span className="text-muted">{o.explanation}</span></li>)}</ul>
        </section>
      )}
      <div className="grid gap-3 xl:grid-cols-2"><DivergencePanel d={d} /><AlertsPanel alerts={d.alerts} /></div>
      <ScenarioPanel s={d.scenarios} />
      <TimelinePanel />
      <DetailPanels d={d} />
      {d.capabilities && (
        <section aria-label="Data quality and freshness" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-capabilities">
          <h2 className="mb-1 text-sm font-semibold text-paper">Data quality and freshness <span className="font-normal text-muted">· what exists today, each with its own source timestamp</span></h2>
          <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Capability</th><th className="py-1 font-normal">Status</th><th className="py-1 font-normal">Source as of</th><th className="py-1 font-normal">Why</th></tr></thead>
            <tbody>{d.capabilities.map((c) => <tr key={c.id} className="border-t border-rule/50 align-top" data-testid={`mi-cap-${c.id}`}><td className="py-1 text-paper">{c.link ? <Link to={c.link} className="text-info hover:underline">{c.name}</Link> : c.name}</td><td className={`py-1 font-semibold ${STATE_TONE[c.status] ?? "text-muted"}`}>{c.status}</td><td className="num py-1 text-muted">{c.as_of ?? MISSING}</td><td className="py-1 text-muted">{c.reason}</td></tr>)}</tbody></table></div>
          <p className="mt-2 text-[11px] text-muted">AVAILABLE: computed in full from stored or live data. PARTIAL: an incomplete calculation or coverage, counted for only the share of its evidence that exists. UNAVAILABLE: the data is not collected or stored; nothing is estimated in its place.</p>
        </section>
      )}
      {d.overlap_audit && (
        <details className="rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="mi-overlap">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-paper">Evidence overlap audit and corrections</summary>
          <div className="border-t border-rule px-4 py-3 text-xs">
            <ul className="space-y-1">{d.overlap_audit.findings.map((f) => <li key={f.input}><span className="text-paper">{f.input}</span> <span className="text-muted">was: {f.was}. Now: {f.fix}.</span></li>)}</ul>
            <p className="mt-2 text-muted">Terms in one family are averaged into a single reading; a term with weight below 1 shares an input (price) with another group.</p>
          </div>
        </details>
      )}
      <details className="rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="mi-sources">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-paper">Data sources, freshness and method</summary>
        <div className="border-t border-rule px-4 py-3 text-xs">
          <table className="w-full min-w-[28rem]"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Input</th><th className="py-1 font-normal">State</th><th className="py-1 text-right font-normal">Age</th><th className="py-1 text-right font-normal">Source timestamp</th><th className="py-1 text-right font-normal">Read in</th></tr></thead>
            <tbody>{Object.entries(d.status).map(([k, v]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{LABELS[k] ?? k}</td><td className={`py-1 ${v.ok ? "text-up" : "text-down"}`}>{v.ok ? "ok" : (v.error ?? "unavailable")}</td><td className="num py-1 text-right text-muted">{v.age_s == null ? MISSING : v.age_s < 90 ? `${Math.round(v.age_s)} s` : `${Math.round(v.age_s / 60)} min`}</td><td className="num py-1 text-right text-muted">{v.as_of ?? MISSING}</td><td className="num py-1 text-right text-muted">{v.ms} ms</td></tr>)}</tbody></table>
          <p className="mt-2 text-muted" data-testid="mi-method">Overall = Σ(group score × effective weight) ÷ Σ(effective weights), where a PARTIAL group counts for the share of its evidence that exists and an unavailable group counts for nothing; weights {Object.entries(d.config.weights).map(([k, v]) => `${k} ${v}`).join(", ")}; at least {d.config.min_engines} groups and {(d.config.min_coverage * 100).toFixed(0)}% of the weight are required, otherwise the sentiment is not shown. EVIDENCE QUALITY = coverage factor × agreement among groups × freshness, shown as three numbers, independent of the size of the score, capped when groups conflict; it measures freshness, completeness and agreement, never a probability or a prediction. {d.config.note} Futures CVD (Proxy) and Heavyweight CVD (Proxy) are estimates from the quote and tick rule, not observed buyer or seller volume. GEX is modelled exposure with an assumed sign, not observed dealer positioning. India VIX is a daily close and is never an intraday signal.</p>
        </div>
      </details>
    </div>
  );
}
