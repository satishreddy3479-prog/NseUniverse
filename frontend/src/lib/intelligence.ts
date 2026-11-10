/** Types and small helpers for the NIFTY 50 market-intelligence dashboard (backend: GET /api/intelligence/summary and /timeline). */
export interface InputStatus { ok: boolean; age_s: number | null; ms: number; error?: string | null }
export interface EngineTerm { name: string; score: number | null; detail: string; available: boolean; proxy: boolean }
export interface EngineView {
  key: string; name: string; score: number | null; class: string; tilt: "bullish" | "bearish" | "neutral" | "unavailable"; link: string; weight: number; contribution: number | null;
  terms: EngineTerm[]; supporting: string[]; conflicting: string[]; unavailable: string[];
  freshness: { fresh: boolean | null; age_s: number | null; inputs: string[]; failed: string[] };
  metrics?: { weighted_cvd_score: number | null; positive_cvd: number; negative_cvd: number; stocks_used: string[]; aggregate_points_pct: number | null; participation_ratio: number | null; divergence: string | null; symbols: string[] };
  buildup?: string; state?: Record<string, unknown>;
}
export interface Sentiment {
  score: number | null; class: string; coverage: number; engines_available: number; agreement: number | null; freshness: number | null; confidence: number | null; reason: string | null;
  confidence_parts?: { coverage_factor: number; agreement: number; freshness: number }; trend_strength: number | null; signal_quality: string | null; data_completeness: number; volatility_regime: string;
}
export interface Divergence {
  id: string; name: string; direction: string; severity: "low" | "medium" | "high"; reading: string; explanation: string; invalidation: string;
  status: "early warning" | "developing" | "confirmed"; since: string | null; previous: string | null;
}
export interface Scenario { score: number; supporting?: string[]; resistance?: number | null; support?: number | null; confirmation?: string | null; invalidation?: string | null; range?: (number | null)[]; gamma?: string; volatility?: string }
export interface Scenarios {
  available: boolean; label: string; reason?: string | null; bullish?: Scenario; bearish?: Scenario; sideways?: Scenario;
  horizons?: { horizon: string; minutes: number; one_sd_points: number | null }[];
}
export interface AlertRow { id: number; at: string; kind: string; severity: string; direction: string; text: string; evidence: string[]; confirmation: string; invalidation: string }
export interface GexState {
  available: boolean; net?: number | null; flip?: number | null; flip_distance_pct?: number | null; regime?: string; call_wall?: number | null; put_wall?: number | null; peak?: number | null; near_net?: number | null;
  relationship?: string; net_change_pct?: number | null; net_change_15m?: number | null; spot_change_15m_pct?: number | null; ce?: number | null; pe?: number | null; abs?: number | null; at?: string; universe?: string; session?: string;
  methodology?: string;
}
export interface StrikeChange { strike: number; change: number }
export interface Panels {
  options: { ce_oi: number | null; pe_oi: number | null; ce_oi_change: number | null; pe_oi_change: number | null; pcr_oi: number | null; pcr_vol: number | null; pcr_first: number | null; max_ce_oi_strike: number | null; max_pe_oi_strike: number | null;
    largest_call_additions: StrikeChange[]; largest_put_additions: StrikeChange[]; largest_call_unwinding: StrikeChange[]; largest_put_unwinding: StrikeChange[];
    demand: { side: string; group: string; label: string; summary: { oi_pct: number | null; premium_pct: number | null; iv_change: number | null; volume_change: number | null; strikes: number } }[]; note: string };
  gex: GexState;
  vega: { ce_avg_vega: number | null; pe_avg_vega: number | null; strikes: number; note: string };
  volatility: { atm_iv: number | null; iv_change_15m: number | null; hv: number | null; rv: number | null; india_vix: number | null; ivr_252?: number | null; ivp_252?: number | null; skew_25d: number | null; skew_10d: number | null; risk_reversal_25d: number | null;
    butterfly_25d: number | null; term_slope_30d: number | null; term_shape: string | null; term: { expiry: string; days: number | null; atm_iv: number | null }[]; expected_move_1sd_pts: number | null; straddle: number | null; interpretation: string[] | string | null; note: string };
  futures: { series: Record<string, number | null> | null; contract: string | null; oi_change: number | null; volume: number | null; buildup?: string; flow: Record<string, number | boolean | string | null> | null; vwap: Record<string, number | string | null> | null; unavailable: string[]; note: string };
  heavyweight: { stocks: { symbol: string; weight: number | null; change_pct: number | null; relative_volume: number | null; cvd_pct: number | null; divergence: string | null; contribution: number | null }[]; metrics?: EngineView["metrics"]; unavailable: string[]; note: string };
}
export interface Pulse {
  spot: number | null; change_pct: number | null; futures: number | null; basis: number | null; basis_pct: number | null; atm_strike: number | null; expiry: string | null; atm_ce_premium: number | null; atm_pe_premium: number | null;
  atm_iv: number | null; india_vix: { value: number | null; as_of: string | null; note: string }; pcr: number | null; net_gex: number | null; gamma_flip: number | null; futures_oi_change: number | null; futures_cvd_pct: number | null; futures_vwap: number | null; heavyweight_cvd: number | null;
}
export interface Intelligence {
  generated_at: string; expiry: string | null; session: string; enabled: boolean; status: Record<string, InputStatus>; sentiment: Sentiment;
  regime: { name: string; evidence: string[]; volatility: string; gamma: string; previous: string | null; changed_at: string | null };
  engines: EngineView[]; pulse: Pulse; gex: GexState; interpretation: string; divergences: Divergence[]; divergences_invalidated: { id: string; status: string }[]; divergences_unavailable: string[];
  scenarios: Scenarios; panels: Panels; alerts: AlertRow[]; config: { weights: Record<string, number>; min_coverage: number; min_engines: number; note: string }; compute_ms: number;
}
export interface TimelinePoint {
  session: string; at: string; spot: number | null; score: number | null; confidence: number | null; coverage: number | null; regime: string | null; vol_regime: string | null; gamma_regime: string | null;
  engines: Record<string, number | null>; metrics: Record<string, number | string | null>; divs: { id: string }[];
}
export interface Timeline { session: string; sessions: string[]; points: TimelinePoint[]; recorded: number; note: string }

/** Colour class of a signed score: green bullish, red bearish, grey neutral, amber when unavailable. */
export const toneOf = (s: number | null | undefined): string => (s == null ? "text-warn" : s >= 15 ? "text-up" : s <= -15 ? "text-down" : "text-muted");
export const signed = (v: number | null | undefined, d = 0): string => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
export const ENGINE_ORDER = ["futures", "options", "gex", "heavyweight", "volatility", "structure"] as const;
/** The freshness of an engine in words, never showing stale data as live. */
export function freshLabel(e: { freshness: { fresh: boolean | null; age_s: number | null } }): string {
  if (e.freshness.fresh == null) return "no data";
  const a = e.freshness.age_s;
  const age = a == null ? "" : a < 90 ? ` · ${Math.round(a)} s old` : ` · ${Math.round(a / 60)} min old`;
  return (e.freshness.fresh ? "fresh" : "STALE") + age;
}
