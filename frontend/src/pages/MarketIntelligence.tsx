import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST, MISSING } from "../lib/format";
import { DetailPanels } from "../components/intelligence/Detail";
import { AlertsPanel, DivergencePanel, ScenarioPanel, TimelinePanel } from "../components/intelligence/Insight";
import { CommandStrip, EngineMatrix, Interpretation, PulseCards } from "../components/intelligence/Overview";
import { HeavyweightPanel } from "../components/intelligence/Heavyweight";
import { StockFuturesPanel } from "../components/intelligence/StockFutures";
import { TurnWatchPanel } from "../components/intelligence/TurnWatch";
import { IntradayMlPanel } from "../components/intelligence/IntradayMl";
import { StraddleSummaryCard } from "../components/intelligence/StraddleDecay";
import { Capabilities } from "../components/intelligence/Capabilities";
import { SectionNav } from "../components/intelligence/SectionNav";

const LABELS: Record<string, string> = { flow: "Stored per-minute flow (rolling CVD)", market: "Market flow, breadth and heavyweights", intraday: "Command centre (stored chain)", futures: "Futures series", skew: "Volatility skew", momentum: "IV momentum", positioning: "Strike positioning", gex: "GEX (rebuilt)", vix: "India VIX, HV and RV (daily closes)", heavymeta: "Heavyweight index weights", ml: "Intraday ML research" };
const NAV = [
  { id: "mi-sentiment", label: "Sentiment" }, { id: "mi-evidence", label: "Evidence" }, { id: "mi-heavyweights", label: "Heavyweights" }, { id: "mi-stockfut", label: "Stock futures" }, { id: "mi-straddle", label: "Straddle" },
  { id: "mi-ml", label: "Intraday ML" }, { id: "mi-interpretation", label: "Interpretation" }, { id: "mi-divergences", label: "Divergences & alerts" }, { id: "mi-scenarios", label: "Scenarios" },
  { id: "mi-timeline", label: "Timeline" }, { id: "mi-details", label: "Details" }, { id: "mi-quality", label: "Data quality" },
];

/** NIFTY 50 Market Intelligence: one page that fuses the existing analytics into a sentiment, a regime and the evidence behind them. */
export function MarketIntelligence() {
  const q = useQuery({ queryKey: ["intelligence"], queryFn: () => api.intelligenceSummary(), refetchInterval: 5_000, retry: false });
  if (q.isPending) return <div className="mx-auto max-w-[1500px] space-y-3" aria-label="Loading the market intelligence dashboard"><div className="h-32 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" /><div className="h-48 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" /></div>;
  if (q.isError || !q.data) return <p role="alert" className="mx-auto max-w-[1500px] rounded-sm border border-down/50 p-3 text-sm text-down">The market intelligence dashboard could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}. The individual analysis pages are unaffected.</p>;
  const d = q.data;
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="mi-page">
      <header><h1 className="text-xl font-semibold md:text-2xl">NIFTY 50 Market Intelligence</h1><p className="text-xs text-muted">Reads the existing engines, fuses them, and shows the evidence. Session {d.session}, expiry {d.expiry ?? MISSING}, updated {fmtTimeIST(d.generated_at)} IST.</p></header>
      <SectionNav items={NAV} />
      <div id="mi-sentiment" className="flex scroll-mt-14 flex-col gap-3"><CommandStrip d={d} /><TurnWatchPanel d={d} /><PulseCards d={d} /></div>
      <div id="mi-evidence" className="scroll-mt-14"><EngineMatrix d={d} /></div>
      <div id="mi-heavyweights" className="scroll-mt-14"><HeavyweightPanel d={d} /></div>
      <div id="mi-stockfut" className="scroll-mt-14"><StockFuturesPanel d={d} /></div>
      <div id="mi-straddle" className="scroll-mt-14"><StraddleSummaryCard /></div>
      <div id="mi-ml" className="scroll-mt-14"><IntradayMlPanel d={d} /></div>
      <div id="mi-interpretation" className="grid scroll-mt-14 items-start gap-3 xl:grid-cols-2">
        <Interpretation d={d} />
        {(d.observations ?? []).length > 0 && (
          <section aria-label="Conflicting and confirming readings" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-observations">
            <h2 className="mb-1 text-sm font-semibold text-paper">Readings side by side <span className="font-normal text-muted">· described, never read as a reversal</span></h2>
            <ul className="space-y-2 text-sm">{(d.observations ?? []).map((o) => <li key={o.id} data-testid="mi-observation"><span className="font-medium text-paper">{o.title}.</span> <span className="text-paper">{o.reading}.</span> <span className="text-muted">{o.explanation}</span></li>)}</ul>
          </section>
        )}
      </div>
      <div id="mi-divergences" className="grid scroll-mt-14 items-start gap-3 xl:grid-cols-2"><DivergencePanel d={d} /><AlertsPanel alerts={d.alerts} /></div>
      <div id="mi-scenarios" className="scroll-mt-14"><ScenarioPanel s={d.scenarios} /></div>
      <div id="mi-timeline" className="scroll-mt-14"><TimelinePanel /></div>
      <div id="mi-details" className="scroll-mt-14"><DetailPanels d={d} /></div>
      {d.capabilities && <div id="mi-quality" className="scroll-mt-14"><Capabilities items={d.capabilities} /></div>}
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
          <table className="stack-rows w-full min-w-[28rem]"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Input</th><th className="py-1 font-normal">State</th><th className="py-1 text-right font-normal">Age</th><th className="py-1 text-right font-normal">Source timestamp</th><th className="py-1 text-right font-normal">Read in</th></tr></thead>
            <tbody>{Object.entries(d.status).map(([k, v]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 font-semibold text-paper">{LABELS[k] ?? k}</td><td data-label="State" className={`py-1 ${v.ok ? "text-up" : "text-down"}`}>{v.ok ? "ok" : (v.error ?? "unavailable")}</td><td data-label="Age" className="num py-1 text-right text-muted">{v.age_s == null ? MISSING : v.age_s < 90 ? `${Math.round(v.age_s)} s` : `${Math.round(v.age_s / 60)} min`}</td><td data-label="Source timestamp" className="num py-1 text-right text-muted">{v.as_of ?? MISSING}</td><td data-label="Read in" className="num py-1 text-right text-muted">{v.ms} ms</td></tr>)}</tbody></table>
          <p className="mt-2 text-muted" data-testid="mi-method">Overall = Σ(group score × effective weight) ÷ Σ(effective weights), where a PARTIAL group counts for the share of its evidence that exists and an unavailable group counts for nothing; weights {Object.entries(d.config.weights).map(([k, v]) => `${k} ${v}`).join(", ")}; at least {d.config.min_engines} groups and {(d.config.min_coverage * 100).toFixed(0)}% of the weight are required, otherwise the sentiment is not shown. EVIDENCE QUALITY = coverage factor × agreement among groups × freshness, shown as three numbers, independent of the size of the score, capped when groups conflict; it measures freshness, completeness and agreement, never a probability or a prediction. {d.config.note} Futures CVD (Proxy) and Heavyweight CVD (Proxy) are estimates from the quote and tick rule, not observed buyer or seller volume. GEX is modelled exposure with an assumed sign, not observed dealer positioning. India VIX is a daily close and is never an intraday signal.</p>
        </div>
      </details>
    </div>
  );
}
