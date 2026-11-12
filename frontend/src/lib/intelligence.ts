/** Types and small helpers for the NIFTY 50 market-intelligence dashboard (backend: GET /api/intelligence/summary and /timeline). */
export interface InputStatus { ok: boolean; age_s: number | null; ms: number; error?: string | null; as_of?: string | null }
export interface EngineTerm { name: string; score: number | null; detail: string; available: boolean; proxy: boolean; family?: string; weight?: number; shares?: string[]; overlap_adjustment?: string | null }
export type EvidenceState = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
export interface EngineView {
  key: string; name: string; score: number | null; class: string; tilt: "bullish" | "bearish" | "neutral" | "unavailable"; link: string; weight: number; contribution: number | null;
  status?: EvidenceState; fraction?: number; effective_weight?: number; terms_available?: number; terms_total?: number; families?: number;
  terms: EngineTerm[]; supporting: string[]; conflicting: string[]; unavailable: string[];
  freshness: { fresh: boolean | null; age_s: number | null; inputs: string[]; failed: string[]; as_of?: Record<string, string | null> };
  metrics?: { weighted_cvd_score?: number | null; positive_cvd?: number; negative_cvd?: number; stocks_used?: string[]; aggregate_points_pct?: number | null; heavy_up_weight?: number; heavy_down_weight?: number; participation_ratio?: number | null; divergence?: string | null; symbols?: string[] };
  buildup?: string; state?: Record<string, unknown>; detail?: VolDetail;
}
export interface Sentiment {
  score: number | null; class: string; coverage: number; engines_available: number; agreement: number | null; freshness: number | null; confidence: number | null; reason: string | null;
  engine_counts?: { available: number; partial: number; unavailable: number }; weights_note?: string; groups_bullish?: number; groups_bearish?: number;
  confidence_parts?: { coverage_factor: number; agreement: number; freshness: number; conflict_cap_applied?: boolean }; trend_strength: number | null; signal_quality: string | null; data_completeness: number; volatility_regime: string;
}
export interface Divergence {
  id: string; name: string; direction: string; severity: "low" | "medium" | "high"; reading: string; explanation: string; invalidation: string;
  status: "early warning" | "developing" | "confirmed"; since: string | null; previous: string | null;
  kind?: "divergence" | "confirmation"; evidence?: string[]; at?: string | null;
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
  methodology?: string; label?: string; flip_distance_pts?: number | null; flip_range?: [number, number] | null;
  flip_support?: { status: "supported" | "unstable" | "none" | "unassessed"; reasons: string[]; spread_pts?: number | null };
}
export interface RollingWindow { minutes: number; cvd: number | null; cvd_pct: number | null; volume: number | null; classified: number | null; from: string | null; to: string | null; status: string }
export interface CvdAcceleration { minutes: number; current_cvd: number | null; previous_cvd: number | null; current_rate: number | null; previous_rate: number | null; rate_change: number | null; acceleration: number | null; current_pct: number | null; previous_pct: number | null; status: string }
export interface Rolling { windows: Record<string, RollingWindow>; acceleration: CvdAcceleration; ok_windows: number; estimated: boolean }
export interface Observation { id: string; title: string; reading: string; explanation: string; reversal_signal: false }
export interface Capability { id: string; name: string; status: EvidenceState; reason: string; source: string; as_of: string | null; link: string | null; /** why it does not exist: the feed lacks it, nothing subscribes to it, or nothing is stored yet */ why?: "feed" | "not_subscribed" | "no_data_yet" | null }
export interface OverlapAudit { findings: { input: string; was: string; fix: string }[]; terms: { group: string; term: string; family: string; weight: number; shares: string[]; available: boolean }[] }
export interface StrikeChange { strike: number; change: number }
export interface Panels {
  options: { ce_oi: number | null; pe_oi: number | null; ce_oi_change: number | null; pe_oi_change: number | null; pcr_oi: number | null; pcr_vol: number | null; pcr_first: number | null; max_ce_oi_strike: number | null; max_pe_oi_strike: number | null;
    largest_call_additions: StrikeChange[]; largest_put_additions: StrikeChange[]; largest_call_unwinding: StrikeChange[]; largest_put_unwinding: StrikeChange[];
    demand: { side: string; group: string; label: string; summary: { oi_pct: number | null; premium_pct: number | null; iv_change: number | null; volume_change: number | null; strikes: number } }[]; note: string };
  gex: GexState;
  vega: { ce_avg_vega: number | null; pe_avg_vega: number | null; strikes: number; note: string };
  volatility: { atm_iv: number | null; iv_change_15m: number | null; hv: number | null; rv: number | null; india_vix: number | null; india_vix_label?: string; india_vix_as_of?: string | null; ivr_252?: number | null; ivp_252?: number | null; skew_25d: number | null; skew_10d: number | null; risk_reversal_25d: number | null;
    butterfly_25d: number | null; term_slope_30d: number | null; term_shape: string | null; term: { expiry: string; days: number | null; atm_iv: number | null }[]; expected_move_1sd_pts: number | null; straddle: number | null; interpretation: string[] | string | null; note: string };
  futures: { series: Record<string, number | null> | null; contract: string | null; oi_change: number | null; volume: number | null; buildup?: string; flow: Record<string, number | boolean | string | null> | null; vwap: Record<string, number | string | null> | null; rolling?: Rolling | null; unavailable: string[]; note: string };
}
export interface HeavyWindow { minutes: number; cvd: number | null; pct: number | null; norm: number | null; price_change_pct: number | null; status: string }
export interface HeavyStock {
  symbol: string; name: string | null; weight: number; previous_weight: number | null; price: number | null; change_pct: number | null; vwap: number | null; price_vs_vwap_pct: number | null;
  session: { cvd: number | null; pct: number | null; norm: number | null; buy_volume: number | null; sell_volume: number | null }; windows: Record<"5" | "15" | "30", HeavyWindow>;
  momentum: number | null; acceleration: number | null; prev5_norm?: number | null; basis_norm: number | null; bias: string; price_cvd_divergence: string | null; contribution_pct?: number | null; methodology: string; valid: boolean;
  freshness: { updated: string | null; age_s: number | null; feed: string; fresh: boolean; classified_share: number | null; coverage_of_day_volume: number | null; quote_rule_share: number | null; stored_samples: number };
}
export interface HeavyAgg { score: number | null; valid: number; of: number; weight_share: number; status: string }
export interface Heavyweights {
  available: boolean; reason?: string; method: string; limits: string[]; as_of?: string | null; stocks: HeavyStock[];
  aggregate: { session: HeavyAgg; "5": HeavyAgg; "15": HeavyAgg; "30": HeavyAgg; momentum: number | null; acceleration: number | null };
  participation: { class: string; valid: number; positive: number | null; negative: number | null; neutral: number | null; weight_share_positive: number | null; weight_share_negative: number | null; top_contributor: { symbol: string; share: number } | null; reason: string | null };
  nifty: { change_15m_pct: number | null; day_change_pct: number | null; futures_vwap_side: string | null; futures_vwap_pts: number | null; vwap_note: string }; relative_strength_pct: number | null;
  series: { t: string; session: number | null; w5: number | null; w15: number | null; spot: number | null }[];
  quality: { valid: number; of: number; weight_share: number; aggregate_available: boolean; valid_constituents?: number; weights: { as_of?: string; source?: string; age_days?: number | null; stale: boolean; approximate: boolean; rolled_to?: string | null; basis?: string; effective_date?: string; verified_at?: string | null; verified_note?: string; live?: boolean } };
}
export interface MlModelScore { log_loss: number | null; brier: number | null; n: number | null; ece: number | null }
export interface MlEvaluation {
  computed_at: string; horizon_minutes: number; barrier_k: number; status: string | null; sessions: number | null; test_sessions: number | null; rows: number | null; reason: string | null;
  models: Record<string, MlModelScore>; best_baseline_log_loss: number | null; model_log_loss_gain: number | null; feature_groups?: Record<string, { log_loss: number; delta_vs_price_only: number }> | null;
  gate: { status: string | null; show_probabilities: boolean; beat_share: number | null; mean_log_loss_gain: number | null; sign_test_p: number | null; ece: number | null; reasons: string[] };
}
export interface MlDigest {
  status: { status: string; stage_name: string; labelled_sessions: number; complete_sessions: number; sessions_with_samples: number; stages: { id: string; name: string; from_sessions: number; what: string }[]; next: { name: string; at_sessions: number; sessions_to_go: number } | null };
  last_evaluation: MlEvaluation | null; computing: boolean; next_run: string;
}
export interface VolBucket { ce_iv: number | null; pe_iv: number | null; ce_change: number | null; pe_change: number | null; risk_reversal: number | null; skew: number | null; rr_change: number | null; rr_previous_session: number | null; rr_change_since_previous_session: number | null; mechanism: string | null; movement?: string | null; avg_change?: number | null }
export interface VolDetail {
  window: string; spot_change_pct: number | null; atm: VolBucket; d25: VolBucket; d10: VolBucket; total: number | null; verdict: "BULLISH" | "BEARISH" | "CONFLICTING" | "NEUTRAL" | "UNAVAILABLE";
  components: { key: string; name: string; reading: string | null; score: number | null; contribution: number | null; scored?: boolean; change?: number | null; material?: boolean; materiality_threshold?: number }[];
  unscored_components?: { key: string; name: string; reading: string | null; score: null; contribution: number; scored: false; why: string }[]; correlated_inputs?: string[]; evidence: { bullish: string[]; bearish: string[]; conflicting: string[] }; not_scored: string[];
  interpretation: { id: string; title: string; reading: string }[]; explanation: string; scoring: { mode: string; atm_scale: number; atm_factor: number; skew_scale: number; atm_material?: number; rr_material?: number; noise_pts?: number }; sign_convention: string; sign_consistent: boolean;
}
export interface Pulse {
  spot: number | null; change_pct: number | null; futures: number | null; basis: number | null; basis_pct: number | null; atm_strike: number | null; expiry: string | null; atm_ce_premium: number | null; atm_pe_premium: number | null;
  atm_iv: number | null; vwap?: { instrument: string; futures_price: number | null; futures_vwap: number | null; distance_pts: number | null; distance_pct: number | null; side: string | null; spot_vwap: number | null; spot_vwap_estimate?: IndexVwapEstimate; spot_vwap_note: string };
  india_vix: { value: number | null; as_of: string | null; note: string; label?: string; intraday_signal?: boolean }; pcr: number | null; net_gex: number | null; gamma_flip: number | null; futures_oi_change: number | null; futures_cvd_pct: number | null; futures_vwap: number | null; heavyweight_cvd: number | null;
}
export interface StockFuturesRow {
  symbol: string; ltp: number | null; price_change_pct: number | null; oi: number | null; oi_change: number | null; oi_change_pct: number | null; buildup: string | null; volume: number | null;
  basis_pct: number | null; next_ltp: number | null; next_oi: number | null; rollover_pct: number | null; roll_cost_pct: number | null;
}
export interface NiftyRollover {
  available: boolean; reason?: string; cur_oi?: number; next_oi?: number; rollover_pct?: number | null; cur_ltp?: number; next_ltp?: number; roll_cost_pts?: number; roll_cost_pct?: number;
  rollover_pct_at_open?: number; cur_oi_change?: number; next_oi_change?: number;
}
export interface StockFutures {
  rows: StockFuturesRow[]; covered: number; of: number; buildup_counts: Record<string, number>; rollover_pct: number | null; rollover_stocks: number; note: string;
  nifty: NiftyRollover; tokens_note?: string; baseline_at?: string | null;
}
export interface IndexVwapEstimate {
  value: number | null; stocks?: number; weight_share?: number; estimate?: boolean; note: string; method?: string; reason?: string;
  spot?: number; distance_pts?: number; distance_pct?: number; side?: string;
}

export interface Intelligence {
  generated_at: string; expiry: string | null; session: string; enabled: boolean; status: Record<string, InputStatus>; sentiment: Sentiment;
  regime: { name: string; evidence: string[]; volatility: string; gamma: string; previous: string | null; changed_at: string | null };
  engines: EngineView[]; pulse: Pulse; gex: GexState; interpretation: string; divergences: Divergence[]; divergences_invalidated: { id: string; status: string }[]; divergences_unavailable: string[];
  scenarios: Scenarios; panels: Panels; alerts: AlertRow[]; config: { weights: Record<string, number>; min_coverage: number; min_engines: number; note: string; groups?: Record<string, string> }; compute_ms: number;
  capabilities?: Capability[]; overlap_audit?: OverlapAudit; heavyweights?: Heavyweights; stock_futures?: StockFutures | null; observations?: Observation[]; intraday_ml?: MlDigest | null;
}
export interface TimelinePoint {
  session: string; at: string; spot: number | null; score: number | null; confidence: number | null; coverage: number | null; regime: string | null; vol_regime: string | null; gamma_regime: string | null;
  engines: Record<string, number | null>; metrics: Record<string, number | string | null>; divs: { id: string }[];
}
export interface Timeline { session: string; sessions: string[]; points: TimelinePoint[]; recorded: number; note: string }

/** Colour class of a signed score: green bullish, red bearish, grey neutral, amber when unavailable. */
export const toneOf = (s: number | null | undefined): string => (s == null ? "text-warn" : s >= 15 ? "text-up" : s <= -15 ? "text-down" : "text-muted");
export const signed = (v: number | null | undefined, d = 0): string => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
export const ENGINE_ORDER = ["positioning", "orderflow", "volatility", "structure", "participation"] as const;
/** Tooltip for every CVD figure: what the number is and what it is not. */
export const CVD_TIP = "Estimated from the quote stream: each trade is classified buyer- or seller-initiated by the quote rule (against the prevailing best bid and ask) and then the tick rule. The feed carries no aggressor-side trade tape, so buyer and seller volume are not observed. A proxy, not genuine aggressor-side CVD.";
export const GEX_TIP = "Modelled exposure: gamma x open interest x spot^2 x 1% with an ASSUMED sign (calls +, puts -). Dealer positioning is not observed.";
export const VIX_LABEL = "India VIX – Last Daily Close";
/** The freshness of an engine in words, never showing stale data as live. */
export function freshLabel(e: { freshness: { fresh: boolean | null; age_s: number | null } }): string {
  if (e.freshness.fresh == null) return "no data";
  const a = e.freshness.age_s;
  const age = a == null ? "" : a < 90 ? ` · ${Math.round(a)} s old` : ` · ${Math.round(a / 60)} min old`;
  return (e.freshness.fresh ? "fresh" : "STALE") + age;
}
