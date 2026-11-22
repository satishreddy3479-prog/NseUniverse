import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GammaMapPanel } from "../components/risk/GammaMapPanel";
import { GreeksDashboard } from "../components/risk/GreeksDashboard";
import { LegsEditor } from "../components/risk/LegsEditor";
import { explainRisk as explain } from "../components/risk/BuilderWhatIf";
import { SurfaceViewer } from "../components/risk/SurfaceViewer";
import { api } from "../lib/api";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { legsFromBuilder, type RiskLeg, riskApi, RiskApiError, stampText } from "../lib/risk";

const LEGS_KEY = "nse.greeks.legs";
/** The live view is a poll: the surface is rebuilt on the server only when quotes changed, so asking often is cheap. */
const POLL = { portfolio: 1_000, surface: 5_000 } as const;

const loadLegs = (): RiskLeg[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LEGS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as RiskLeg[]).filter((l) => l && typeof l.strike === "number" && typeof l.expiry === "string") : [];
  } catch {
    return [];
  }
};

/** Advanced Greeks: the position's Greeks in rupees by leg, expiry and portfolio limits, the gamma map and the volatility surface it is valued on. The what-if scenarios (index, volatility, time and rate moves, the risk matrix and the payoff) live in the Strategy Builder's Scenarios tab, on the strategy being built. Read-only: nothing is sent to a broker. */
export function AdvancedGreeks() {
  const [legs, setLegsState] = useState<RiskLeg[]>(loadLegs);
  const setLegs = (l: RiskLeg[]) => {
    setLegsState(l);
    try { localStorage.setItem(LEGS_KEY, JSON.stringify(l)); } catch { /* storage unavailable: the legs last for this visit */ }
  };
  const has = legs.length > 0;
  const key = useMemo(() => JSON.stringify(legs), [legs]);

  const status = useQuery({ queryKey: ["risk-status"], queryFn: riskApi.status, refetchInterval: 30_000, retry: false });
  const builder = useQuery({ queryKey: ["risk-builder"], queryFn: api.runningGet, refetchInterval: 30_000, retry: false });
  const builderLegs = useMemo(() => legsFromBuilder(builder.data?.doc?.legs), [builder.data]);
  const builderFutures = useMemo(() => (builder.data?.doc?.legs ?? []).filter((l) => l.enabled !== false && l.type === "FUT").length, [builder.data]);

  const surface = useQuery({ queryKey: ["risk-surface"], queryFn: () => riskApi.surface(), refetchInterval: POLL.surface, retry: false, placeholderData: keepPreviousData });
  const expiries = useMemo(() => Array.from(new Set([...(surface.data?.slices.map((s) => s.expiry) ?? []), ...legs.map((l) => l.expiry)])).filter(Boolean).sort(), [surface.data, legs]);
  const opt = { enabled: has, retry: false, placeholderData: keepPreviousData } as const;
  const portfolio = useQuery({ queryKey: ["risk-portfolio", key], queryFn: () => riskApi.portfolio(legs), refetchInterval: POLL.portfolio, ...opt });

  const stamp = portfolio.data ?? surface.data ?? null;
  const degraded = (surface.data?.slices ?? []).filter((s) => s.degraded);
  const gone = status.data?.enabled === false || (status.error instanceof RiskApiError && status.error.code === "disabled");

  return (
    <div className="stagger mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="greeks-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted"><Link to="/" className="text-info hover:underline">← All tools</Link></p>
          <h1 className="text-xl font-semibold md:text-2xl">Advanced Greeks</h1>
          <p className="text-xs text-muted">The Greeks of your NIFTY option legs in rupees, by leg, by expiry and against the limits, the gamma map, and the volatility surface they are valued on. What a move in the index, in volatility, in time or in rates would do to a strategy is in the <Link to="/strategy" className="text-info hover:underline">Strategy Builder</Link>, on its Scenarios tab. Read-only: nothing is placed or sent to a broker.</p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-3">
          <ChartInfoToggle />
          <div className="text-right text-xs" data-testid="risk-stamp">
            <div className="font-medium text-paper" title={stamp?.surface_version_id ?? ""} data-testid="risk-stamp-text">{stampText(stamp)}</div>
            {stamp && <div className={stamp.stale || stamp.source === "stored" ? "text-warn" : "text-up"}>{stamp.source === "live" ? "Live books in use" : "Stored chain"}{stamp.stale ? " · stale" : ""}</div>}
          </div>
        </div>
      </header>
      {gone ? (
        <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="risk-disabled">The Greeks engine is turned off on this server.</p>
      ) : (
        <>
          {status.data?.config_error && <p role="alert" className="rounded-sm border border-down/50 bg-down/10 p-2 text-sm text-down" data-testid="risk-config-error">The engine's configuration needs fixing: {status.data.config_error}</p>}
          {degraded.length > 0 && <p className="rounded-sm border border-warn/50 bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="risk-degraded-banner">Model degraded for {degraded.map((s) => s.expiry).join(", ")}: {degraded[0]!.degraded_reason}. Figures for these expiries are unavailable or less reliable; see the surface below.</p>}
          <LegsEditor legs={legs} onChange={setLegs} expiries={expiries} maxLegs={status.data?.max_legs ?? 60} builderCount={builderLegs.length} onUseBuilder={() => setLegs(builderLegs)} />
          {builderFutures > 0 && <p role="note" className="px-1 text-xs text-warn" data-testid="greeks-futures-note">The Strategy Builder holds {builderFutures} NIFTY future leg{builderFutures === 1 ? "" : "s"}. This page prices options only, so the future is left out of "Use builder legs" and of every number here. The Builder's own Greeks and Scenarios tabs include it.</p>}
          <GreeksDashboard risk={portfolio.data?.portfolio} version={portfolio.data?.surface_version_id ?? null} asOf={stampText(portfolio.data ?? null).replace(/, surface .*/, "")} busy={portfolio.isFetching} error={has ? explain(portfolio.error) : null} />
          <GammaMapPanel expiries={expiries} />
          <SurfaceViewer surface={surface.data} busy={surface.isFetching} error={explain(surface.error)} />
        </>
      )}
    </div>
  );
}
