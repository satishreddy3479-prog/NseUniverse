/** Types of the decay-probability engine (`/api/intelligence/decay-probability`, `/api/intelligence/decay-calibration`): the model's odds for the at-the-money short straddle. A model probability, checked against the recorded days; not a forecast. */

export interface DecayParams { stop: number | null; target: number | null; exit: string }

export const DEFAULT_DECAY: DecayParams = { stop: 20, target: null, exit: "15:15" };

export interface DecayOdds {
  available: true;
  strike: number; premium: number; implied_vol_pct: number; forward: number;
  p_profit: number; mean: number; rupees_per_lot_mean: number;
  quantiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  p_stop: number; p_target: number; p_exit_time: number; p_touch_breakeven: number;
  breakeven: { down: number; up: number; move_pts: number }; expected_move_pts: number;
  session: string; expiry: string; as_of: string; age_minutes: number; stale: boolean; exit: string;
  stop_pct: number | null; target_pct: number | null; cost: number; vol_scale: number; lines: string[];
}
export type DecayAnswer = DecayOdds | { available: false; reason: string; session?: string; as_of?: string; age_minutes?: number; stale?: boolean };

export interface ReliabilityBand { from: number; to: number; entries: number; days: number; predicted: number | null; actual: number | null }
export interface ScaleSummary {
  entries: number; days: number; base_rate?: number; brier?: number; brier_base_rate?: number; beats_base_rate?: boolean;
  mean_predicted_pnl?: number; mean_actual_pnl?: number; mean_predicted_win?: number; reliability?: ReliabilityBand[];
  below_predicted?: { p5: number; p50: number; p95: number };
}
export interface StructureCandidate { entries_changed: number; entries_unreadable: number; brier_change: number | null; first_half_change: number | null; second_half_change: number | null; mean_error_change: number | null; improves_both_halves: boolean; kept: boolean; verdict: string }
export type DecayCalibration =
  | { status: "computing"; days_loaded: number; previous: unknown }
  | { status: "ready"; days: number; sufficient: boolean; min_days: number; note: string; variants_tried: number; scales: Record<string, ScaleSummary>;
      structure?: { base_scale: number; days: number; candidates: Record<string, StructureCandidate>; variants_tried: number; live: string[]; note: string } };

export function decayQuery(p: DecayParams): string {
  const q = new URLSearchParams({ exit: p.exit });
  if (p.stop != null) q.set("stop", String(p.stop));
  if (p.target != null) q.set("target", String(p.target));
  return q.toString();
}
