import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GammaMapPanel } from "../components/risk/GammaMapPanel";
import { GreeksDashboard } from "../components/risk/GreeksDashboard";
import { LegsEditor } from "../components/risk/LegsEditor";
import { PayoffPanel, RiskMatrixPanel, type MatrixKind } from "../components/risk/RiskCharts";
import { ScenarioPanel, ZERO_SCENARIO } from "../components/risk/ScenarioPanel";
import { SurfaceViewer } from "../components/risk/SurfaceViewer";
import { api } from "../lib/api";
import { legsFromBuilder, type RiskLeg, riskApi, RiskApiError, type ScenarioParams, stampText, type StickyRule } from "../lib/risk";

const LEGS_KEY = "nse.greeks.legs";
/** The live view is a poll: the surface is rebuilt on the server only when quotes changed, so asking often is cheap. */
const POLL = { portfolio: 1_000, scenario: 2_000, surface: 5_000, presets: 5_000 } as const;

const loadLegs = (): RiskLeg[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LEGS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as RiskLeg[]).filter((l) => l && typeof l.strike === "number" && typeof l.expiry === "string") : [];
  } catch {
    return [];
  }
};

/** What went wrong, in words: the server's own message, with the cases a trader will meet spelled out. */
function explain(e: unknown): string | null {
  if (!e) return null;
  if (e instanceof RiskApiError) {
    if (e.code === "no_surface") return "No stored option chain is available yet for these expiries, so there is no surface to value the legs on. It appears once the chain sampler has stored one.";
    if (e.code === "expiry_unavailable") return `${e.message}. Pick an expiry that has a chain.`;
    if (e.code === "no_fit") return `${e.message}. Greeks and scenarios need a fitted smile.`;
    if (e.code === "config_error") return `The engine's configuration needs fixing: ${e.message}`;
    if (e.code === "disabled") return "The Greeks and What-If engine is turned off on this server.";
    return e.message;
  }
  return "Could not reach the backend.";
}

/** Advanced Greeks and What-If: the position's Greeks in rupees, what a spot, volatility, time or rate move would do to it, the risk matrix and payoff, and the volatility surface it is valued on. Read-only. */
export function GreeksWhatIf() {
  const [legs, setLegsState] = useState<RiskLeg[]>(loadLegs);
  const [scenario, setScenario] = useState<ScenarioParams>(ZERO_SCENARIO("moneyness"));
  const [matrixKind, setMatrixKind] = useState<MatrixKind>("spot_iv");
  const setLegs = (l: RiskLeg[]) => {
    setLegsState(l);
    try { localStorage.setItem(LEGS_KEY, JSON.stringify(l)); } catch { /* storage unavailable: the legs last for this visit */ }
  };
  const has = legs.length > 0;
  const key = useMemo(() => JSON.stringify(legs), [legs]);

  const status = useQuery({ queryKey: ["risk-status"], queryFn: riskApi.status, refetchInterval: 30_000, retry: false });
  const defaultRule: StickyRule = status.data?.default_sticky ?? "moneyness";
  useEffect(() => {
    if (status.data?.default_sticky && scenario.sticky_rule === "moneyness" && status.data.default_sticky !== "moneyness") setScenario((s) => ({ ...s, sticky_rule: status.data!.default_sticky }));
    // the configured default applies once, to a page the user has not touched
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.default_sticky]);
  const builder = useQuery({ queryKey: ["risk-builder"], queryFn: api.runningGet, refetchInterval: 30_000, retry: false });
  const builderLegs = useMemo(() => legsFromBuilder(builder.data?.doc?.legs), [builder.data]);

  const surface = useQuery({ queryKey: ["risk-surface"], queryFn: () => riskApi.surface(), refetchInterval: POLL.surface, retry: false, placeholderData: keepPreviousData });
  const expiries = useMemo(() => Array.from(new Set([...(surface.data?.slices.map((s) => s.expiry) ?? []), ...legs.map((l) => l.expiry)])).filter(Boolean).sort(), [surface.data, legs]);
  const opt = { enabled: has, retry: false, placeholderData: keepPreviousData } as const;
  const scen = useQuery({ queryKey: ["risk-scenario", key, scenario], queryFn: () => riskApi.scenario(legs, scenario), refetchInterval: POLL.scenario, ...opt });
  const presets = useQuery({ queryKey: ["risk-presets", key, scenario.sticky_rule], queryFn: () => riskApi.presets(legs), refetchInterval: POLL.presets, ...opt });
  const gridIv = useQuery({
    queryKey: ["risk-grid-iv", key, scenario.sticky_rule, scenario.time_elapsed_hours, scenario.rate_shock],
    queryFn: () => riskApi.grid(legs, { kind: "spot_iv", sticky_rule: scenario.sticky_rule, fixed_hours: scenario.time_elapsed_hours, rate_shock: scenario.rate_shock }), refetchInterval: POLL.scenario, ...opt,
  });
  const gridNow = useQuery({
    queryKey: ["risk-grid-now", key, scenario.sticky_rule],
    queryFn: () => riskApi.grid(legs, { kind: "spot_iv", sticky_rule: scenario.sticky_rule, fixed_hours: 0 }), refetchInterval: POLL.scenario, ...opt,
  });
  const gridTime = useQuery({
    queryKey: ["risk-grid-time", key, scenario.sticky_rule, scenario.iv_shock, scenario.rate_shock],
    queryFn: () => riskApi.grid(legs, { kind: "spot_time", sticky_rule: scenario.sticky_rule, fixed_iv_shock: scenario.iv_shock, rate_shock: scenario.rate_shock }), refetchInterval: POLL.scenario, ...opt, enabled: has && matrixKind === "spot_time",
  });
  const payoff = useQuery({ queryKey: ["risk-payoff", key, scenario.sticky_rule], queryFn: () => riskApi.grid(legs, { kind: "payoff", sticky_rule: scenario.sticky_rule }), refetchInterval: POLL.scenario, ...opt });
  const portfolio = useQuery({ queryKey: ["risk-portfolio", key], queryFn: () => riskApi.portfolio(legs), refetchInterval: POLL.portfolio, ...opt });

  const matrix = matrixKind === "spot_iv" ? gridIv : gridTime;
  const stamp = portfolio.data ?? scen.data ?? surface.data ?? null;
  const sd1 = presets.data?.presets.sd_plus_1?.scenario.spot_shock ?? null;
  const sd2 = presets.data?.presets.sd_plus_2?.scenario.spot_shock ?? null;
  const degraded = (surface.data?.slices ?? []).filter((s) => s.degraded);
  const gone = status.data?.enabled === false || (status.error instanceof RiskApiError && status.error.code === "disabled");

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="greeks-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted"><Link to="/" className="text-info hover:underline">← All tools</Link></p>
          <h1 className="text-xl font-semibold md:text-2xl">Greeks and What-If</h1>
          <p className="text-xs text-muted">The Greeks of your NIFTY option legs in rupees, and what a move in the index, in volatility, in time or in rates would do to them. Read-only: nothing is placed or sent to a broker. Valued on a fitted volatility surface; thresholds and limits are configuration.</p>
        </div>
        <div className="text-right text-xs" data-testid="risk-stamp">
          <div className="font-medium text-paper" title={stamp?.surface_version_id ?? ""} data-testid="risk-stamp-text">{stampText(stamp)}</div>
          {stamp && <div className={stamp.stale || stamp.source === "stored" ? "text-warn" : "text-up"}>{stamp.source === "live" ? "Live books in use" : "Stored chain"}{stamp.stale ? " · stale" : ""}</div>}
        </div>
      </header>
      {gone ? (
        <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="risk-disabled">The Greeks and What-If engine is turned off on this server.</p>
      ) : (
        <>
          {status.data?.config_error && <p role="alert" className="rounded-sm border border-down/50 bg-down/10 p-2 text-sm text-down" data-testid="risk-config-error">The engine's configuration needs fixing: {status.data.config_error}</p>}
          {degraded.length > 0 && <p className="rounded-sm border border-warn/50 bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="risk-degraded-banner">Model degraded for {degraded.map((s) => s.expiry).join(", ")}: {degraded[0]!.degraded_reason}. Figures for these expiries are unavailable or less reliable; see the surface below.</p>}
          <LegsEditor legs={legs} onChange={setLegs} expiries={expiries} maxLegs={status.data?.max_legs ?? 60} builderCount={builderLegs.length} onUseBuilder={() => setLegs(builderLegs)} />
          <ScenarioPanel scenario={scenario} onChange={setScenario} presets={presets.data} result={scen.data?.result} defaultRule={defaultRule} busy={scen.isFetching} error={has ? explain(scen.error) : null} />
          <div className="grid gap-3 xl:grid-cols-2">
            <RiskMatrixPanel grid={matrix.data?.grid} kind={matrixKind} onKind={setMatrixKind} forward={matrix.data?.forward ?? null} version={matrix.data?.surface_version_id ?? null} busy={matrix.isFetching} error={has ? explain(matrix.error) : null} />
            <PayoffPanel payoff={payoff.data} now={gridNow.data?.grid} forward={payoff.data?.forward ?? null} sd1={sd1} sd2={sd2} version={payoff.data?.surface_version_id ?? null} busy={payoff.isFetching} error={has ? explain(payoff.error) : null} />
          </div>
          <GreeksDashboard risk={portfolio.data?.portfolio} version={portfolio.data?.surface_version_id ?? null} asOf={stampText(portfolio.data ?? null).replace(/, surface .*/, "")} busy={portfolio.isFetching} error={has ? explain(portfolio.error) : null} />
          <GammaMapPanel expiries={expiries} />
          <SurfaceViewer surface={surface.data} busy={surface.isFetching} error={explain(surface.error)} />
        </>
      )}
    </div>
  );
}
