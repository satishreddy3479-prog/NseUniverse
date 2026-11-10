import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST, MISSING } from "../lib/format";
import { DetailPanels } from "../components/intelligence/Detail";
import { AlertsPanel, DivergencePanel, ScenarioPanel, TimelinePanel } from "../components/intelligence/Insight";
import { CommandStrip, EngineMatrix, Interpretation, PulseCards } from "../components/intelligence/Overview";

const LABELS: Record<string, string> = { market: "Market flow, breadth and heavyweights", intraday: "Command centre (stored chain)", futures: "Futures series", skew: "Volatility skew", momentum: "IV momentum", positioning: "Strike positioning", gex: "GEX (rebuilt)", vix: "VIX, HV and RV history" };

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
      <Interpretation d={d} />
      <div className="grid gap-3 xl:grid-cols-2"><DivergencePanel d={d} /><AlertsPanel alerts={d.alerts} /></div>
      <ScenarioPanel s={d.scenarios} />
      <TimelinePanel />
      <DetailPanels d={d} />
      <details className="rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="mi-sources">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-paper">Data sources, freshness and method</summary>
        <div className="border-t border-rule px-4 py-3 text-xs">
          <table className="w-full min-w-[28rem]"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Input</th><th className="py-1 font-normal">State</th><th className="py-1 text-right font-normal">Age</th><th className="py-1 text-right font-normal">Read in</th></tr></thead>
            <tbody>{Object.entries(d.status).map(([k, v]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{LABELS[k] ?? k}</td><td className={`py-1 ${v.ok ? "text-up" : "text-down"}`}>{v.ok ? "ok" : (v.error ?? "unavailable")}</td><td className="num py-1 text-right text-muted">{v.age_s == null ? MISSING : v.age_s < 90 ? `${Math.round(v.age_s)} s` : `${Math.round(v.age_s / 60)} min`}</td><td className="num py-1 text-right text-muted">{v.ms} ms</td></tr>)}</tbody></table>
          <p className="mt-2 text-muted" data-testid="mi-method">Overall = Σ(engine score × weight) ÷ Σ(weights of engines that have a score); weights {Object.entries(d.config.weights).map(([k, v]) => `${k} ${v}`).join(", ")}; at least {d.config.min_engines} engines and {(d.config.min_coverage * 100).toFixed(0)}% of the weight are required, otherwise the sentiment is not shown. Confidence = coverage factor × agreement × freshness, shown as three numbers, never as a probability. {d.config.note} Futures and heavyweight CVD are estimates from the quote and tick rule, not a trade tape. GEX is a model with an assumed sign, not observed dealer positioning.</p>
        </div>
      </details>
    </div>
  );
}
