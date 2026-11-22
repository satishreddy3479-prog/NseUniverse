import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fmtInt } from "../../lib/format";
import { gridWithFutures, presetsWithFutures, riskApi, RiskApiError, scenarioWithFutures, type RiskLeg, type ScenarioParams, type StickyRule } from "../../lib/risk";
import { PayoffPanel, RiskMatrixPanel, type MatrixKind } from "./RiskCharts";
import { ScenarioPanel, ZERO_SCENARIO } from "./ScenarioPanel";

/** The live view is a poll: the surface is rebuilt on the server only when quotes changed, so asking often is cheap. */
const POLL = { scenario: 2_000, presets: 5_000 } as const;

/** What went wrong, in words: the server's own message, with the cases a trader will meet spelled out. */
export function explainRisk(e: unknown): string | null {
  if (!e) return null;
  if (e instanceof RiskApiError) {
    if (e.code === "no_surface") return "No stored option chain is available yet for these expiries, so there is no surface to value the legs on. It appears once the chain sampler has stored one.";
    if (e.code === "expiry_unavailable") return `${e.message}. Pick an expiry that has a chain.`;
    if (e.code === "no_fit") return `${e.message}. Greeks and scenarios need a fitted smile.`;
    if (e.code === "config_error") return `The engine's configuration needs fixing: ${e.message}`;
    if (e.code === "disabled") return "The scenario engine is turned off on this server.";
    return e.message;
  }
  return "Could not reach the backend.";
}

/**
 * What-if on the volatility surface, for the strategy being built: a move in the index, in volatility, in time or in rates, the volatility rule (the smile follows
 * moneyness, the strike or the delta), the presets, the risk matrix and the payoff, all computed by the engine on the surface fitted to the stored chain. The engine
 * prices options; ``futUnits`` (rupees per index point of the strategy's NIFTY futures) is added here, because a future moves one for one with the index.
 */
export function BuilderWhatIf({ legs, futUnits }: { legs: RiskLeg[]; futUnits: number }) {
  const [scenario, setScenario] = useState<ScenarioParams>(ZERO_SCENARIO("moneyness"));
  const [matrixKind, setMatrixKind] = useState<MatrixKind>("spot_iv");
  const has = legs.length > 0;
  const key = useMemo(() => JSON.stringify(legs), [legs]);
  const status = useQuery({ queryKey: ["risk-status"], queryFn: riskApi.status, refetchInterval: 30_000, retry: false });
  const defaultRule: StickyRule = status.data?.default_sticky ?? "moneyness";
  useEffect(() => {
    if (status.data?.default_sticky && scenario.sticky_rule === "moneyness" && status.data.default_sticky !== "moneyness") setScenario((s) => ({ ...s, sticky_rule: status.data!.default_sticky }));
    // the configured default applies once, to a panel the user has not touched
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.default_sticky]);
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
    queryFn: () => riskApi.grid(legs, { kind: "spot_time", sticky_rule: scenario.sticky_rule, fixed_iv_shock: scenario.iv_shock, rate_shock: scenario.rate_shock }), refetchInterval: POLL.scenario, ...opt,
  });
  const payoff = useQuery({ queryKey: ["risk-payoff", key, scenario.sticky_rule], queryFn: () => riskApi.grid(legs, { kind: "payoff", sticky_rule: scenario.sticky_rule }), refetchInterval: POLL.scenario, ...opt });

  const matrix = matrixKind === "spot_iv" ? gridIv : gridTime;
  const sd1 = presets.data?.presets.sd_plus_1?.scenario.spot_shock ?? null;
  const sd2 = presets.data?.presets.sd_plus_2?.scenario.spot_shock ?? null;
  const gone = status.data?.enabled === false || (status.error instanceof RiskApiError && status.error.code === "disabled");
  if (gone) return <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="risk-disabled">The scenario engine is turned off on this server.</p>;
  const err = (e: unknown) => (has ? explainRisk(e) : null);
  const futNote = futUnits !== 0;
  return (
    <div className="flex flex-col gap-3" data-testid="builder-whatif">
      <div>
        <h3 className="text-base font-semibold text-paper">What-if on the volatility surface</h3>
        <p className="text-xs text-muted">The strategy's option legs re-valued on the smile fitted to the stored chain: change the index, volatility, time or rates, and choose how the smile behaves when the index moves. A model value, not a market price; nothing is sent to a broker.</p>
        {futNote && <p className="mt-1 text-xs text-info" data-testid="whatif-futures-note">Includes the NIFTY future: {futUnits > 0 ? "+" : "−"}₹{fmtInt(Math.abs(futUnits))} per index point. It moves one for one with the index; time, volatility and rate moves do not change it.</p>}
        {!has && futNote && <p className="mt-1 text-xs text-muted">The strategy has only a future: its result is just that line.</p>}
      </div>
      <ScenarioPanel scenario={scenario} onChange={setScenario} presets={presets.data ? presetsWithFutures(presets.data, futUnits) : undefined} result={scen.data?.result ? scenarioWithFutures(scen.data.result, futUnits) : undefined} defaultRule={defaultRule} busy={scen.isFetching} error={err(scen.error)} />
      <div className="grid gap-3 xl:grid-cols-2">
        <RiskMatrixPanel grid={matrix.data?.grid ? gridWithFutures(matrix.data.grid, futUnits) : undefined} kind={matrixKind} onKind={setMatrixKind} forward={matrix.data?.forward ?? null} version={matrix.data?.surface_version_id ?? null} busy={matrix.isFetching} error={err(matrix.error)} />
        <PayoffPanel payoff={payoff.data ? { ...payoff.data, grid: gridWithFutures(payoff.data.grid, futUnits) } : undefined} now={gridNow.data?.grid ? gridWithFutures(gridNow.data.grid, futUnits) : undefined} forward={payoff.data?.forward ?? null} sd1={sd1} sd2={sd2} version={payoff.data?.surface_version_id ?? null} busy={payoff.isFetching} error={err(payoff.error)} />
      </div>
    </div>
  );
}
