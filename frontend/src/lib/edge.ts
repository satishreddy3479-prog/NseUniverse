// The Edge monitor's data (backend: GET /api/edge/report): every indicator's calls scored against what price then did, compared with luck.
export type EdgeStatus = "too_early" | "no_edge" | "edge" | "timing_edge" | "worse";

export interface EdgeSeriesPoint { session: string; calls: number; hit_rate: number | null; edge_drift: number | null; cum_calls: number; cum_hit_rate: number | null; cum_baseline: number | null }
export interface EdgeCore {
  horizon: number; sessions: number; calls: number; hits: number; hit_rate: number | null; baseline_drift: number | null;
  edge_drift: number | null; edge_drift_ci: [number, number] | null; edge_timing: number | null; edge_timing_ci: [number, number] | null;
  recent?: { sessions: number; calls: number; hit_rate: number | null; edge_drift: number | null };
  series: EdgeSeriesPoint[];
}
export interface EdgeHorizon extends EdgeCore {
  status: EdgeStatus; status_text: string; fresh?: EdgeCore & { status: EdgeStatus; status_text: string }; tuned_through?: string; in_sample_text?: string;
}
export interface EdgeIndicator { id: string; name: string; kind: "direction" | "calm"; claim: string; status: EdgeStatus; status_text: string; primary: number; horizons: Record<string, EdgeHorizon> }
export interface EdgeReport {
  generated_at: string; version: string; sessions_scored: number; first_session: string | null; last_session: string | null; headline: string;
  indicators: EdgeIndicator[]; min_sessions: number; min_calls: number; primary_horizon: number; method: string[];
  job: { enabled: boolean; last_run: string | null; last_error: string | null; last_scored: string[]; pending: string[]; runs: string };
}

export const STATUS_LABEL: Record<EdgeStatus, string> = { too_early: "Too early", no_edge: "No edge shown", edge: "Edge over drift", timing_edge: "Timing edge", worse: "Worse than luck" };
export const STATUS_TONE: Record<EdgeStatus, string> = { too_early: "text-brass", no_edge: "text-muted", edge: "text-up", timing_edge: "text-up", worse: "text-down" };
/** Percentage points with a sign, one decimal ("+5.4 pts"); a missing figure stays missing. */
export const pts = (x: number | null | undefined): string => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pts`);
export const pct = (x: number | null | undefined, d = 1): string => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
