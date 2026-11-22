import { useChartColors, EChart } from "../EChart";
import { Loading } from "../Loading";
import { MISSING } from "../../lib/format";
import { type GridResult, type Num, type RiskGrid, versionLabel } from "../../lib/risk";
import { payoffOption, riskMatrixOption } from "../../lib/riskCharts";

export type MatrixKind = "spot_iv" | "spot_time";

/** The risk matrix: a heat map of P&L in rupees over spot and volatility (or spot and time), with the surface version it was computed on. */
export function RiskMatrixPanel({ grid, kind, onKind, forward, version, busy, error }: {
  grid: GridResult | undefined;
  kind: MatrixKind;
  onKind: (k: MatrixKind) => void;
  forward: Num;
  version: string | null;
  busy: boolean;
  error: string | null;
}) {
  const colors = useChartColors();
  return (
    <section aria-label="Risk matrix" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-matrix">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Risk matrix <span className="font-normal text-muted">· change in value, ₹</span></h2>
        <div role="group" aria-label="Matrix axes" className="flex gap-1">
          {([["spot_iv", "Spot × volatility"], ["spot_time", "Spot × time"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => onKind(k)} data-testid={`risk-matrix-${k}`}
              className={`min-h-9 rounded-sm border px-2.5 text-xs ${kind === k ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`}>{label}</button>
          ))}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-down">{error}</p> : grid == null ? (
        <p className="mt-2 text-sm text-muted">{busy ? <Loading variant="inline" label="Calculating…" /> : "Add legs to see the matrix."}</p>
      ) : (
        <>
          {grid.warnings.length > 0 && <p className="mt-1 text-xs text-warn">{grid.warnings.join("; ")}</p>}
          <div className="mt-2 h-[340px]" data-testid="risk-matrix-chart"><EChart option={riskMatrixOption(grid, forward, colors)} ariaLabel="Risk matrix: change in value over spot and volatility or time" /></div>
          <p className="text-[11px] text-muted">Volatility follows <b>{grid.sticky_rule}</b>. Red is a loss, green a gain. Surface {versionLabel(version)}. {grid.pnl.flat().every((v) => v == null) ? "No cell could be valued." : ""}</p>
        </>
      )}
    </section>
  );
}

/** The payoff chart: the position's change in value against the index level at the nearest expiry and today, with the one and two standard deviation bands. */
export function PayoffPanel({ payoff, now, forward, sd1, sd2, version, busy, error }: {
  payoff: RiskGrid | undefined;
  now: GridResult | undefined;
  forward: Num;
  sd1: Num;
  sd2: Num;
  version: string | null;
  busy: boolean;
  error: string | null;
}) {
  const colors = useChartColors();
  const mid = now ? Math.floor(now.col_axis.length / 2) : 0;
  const today = now && now.col_axis[mid] === 0 ? { shocks: now.row_axis, pnl: now.pnl.map((r) => r[mid] ?? null) } : null;
  return (
    <section aria-label="Payoff" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-payoff">
      <h2 className="text-sm font-semibold text-paper">Payoff <span className="font-normal text-muted">· at the nearest expiry and today</span></h2>
      {error ? <p role="alert" className="mt-2 text-sm text-down">{error}</p> : payoff == null ? (
        <p className="mt-2 text-sm text-muted">{busy ? <Loading variant="inline" label="Calculating…" /> : "Add legs to see the payoff."}</p>
      ) : (
        <>
          <p className="mt-2 text-[11px] text-muted">Change in value (₹) against the index level.</p>
          <div className="h-[300px]" data-testid="risk-payoff-chart"><EChart option={payoffOption({ atExpiry: payoff.grid, now: today, forward: payoff.forward ?? forward, sd1, sd2, colors })} ariaLabel="Payoff of the position against the index level" /></div>
          <p className="text-[11px] text-muted">Shaded: one and two standard deviations of the nearest expiry{sd1 == null ? ` (${MISSING})` : ""}. Diamonds: breakeven. Against the current value, not the entry price. Surface {versionLabel(version)}.</p>
        </>
      )}
    </section>
  );
}
