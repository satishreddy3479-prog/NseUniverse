/** Types of /api/intelligence/straddle (straddle decay intelligence and buyer/seller environments). A missing value is null and is shown as a dash, never as zero. */

export interface Stat { open: number | null; current: number | null; change: number | null; change_pct: number | null; high?: number | null; low?: number | null }
export interface Terms { theta: number; vega: number; delta: number; gamma: number; vanna?: number; volga?: number; residual: number; actual: number; vega_skew?: number }
export interface Efficiency {
  status: "efficient" | "slower" | "none" | "expansion" | "unavailable";
  efficiency_pct: number | null; actual_decay: number | null; expected_decay: number | null; shortfall?: number | null; shortfall_rupees?: number | null; shortfall_pct?: number | null;
  reason: string | null; causes?: Record<string, number | null> | null; lot_size?: number;
}
export interface Window { ce: Terms; pe: Terms; both: Terms; steps: number; efficiency: Efficiency }
export type Windows = Record<"open" | "60" | "30", Window | null>;
export interface Realised { minutes: number | null; vol_pct: number | null; returns: number; gaps_skipped: number; note?: string }
export type Moves = Record<"5" | "15" | "30" | "60", number | null>;
export interface IvRegime { tags: string[]; text: string; ce_change_pts?: number | null; pe_change_pts?: number | null }

export interface Component {
  id: string; name: string; weight: number; value: number | null; contribution: number | null; text: string; source: string; proxy: boolean; status: "AVAILABLE" | "UNAVAILABLE";
}
export interface SideRisk { risk: number | null; label: string; reasons: { name: string; value: number; text: string }[] }
export interface SubScore { score: number | null; class?: string; state?: string; uses: string[]; name?: string; direction?: string; note?: string }
export interface Seller {
  score: number | null; class: string; capped_by_flags: string | null; coverage: number; components: Component[]; flags: { id: string; text: string }[];
  short_straddle: SubScore; short_strangle: SubScore; call_side_risk: SideRisk; put_side_risk: SideRisk; note: string;
}
export interface Buyer {
  score: number | null; class: string; coverage: number; components: Component[]; types: Record<string, SubScore>;
  direction: { value: number | null; label: string; parts: { name: string; value: number }[] }; premium_check: { iv_rising_but_not_justified: boolean; text: string }; note: string;
}
export interface Environment {
  seller: Seller; buyer: Buyer; positioning?: { status: string; supports: boolean | null; lines: string[] }; invalidation: string[]; proxies: string[]; weights_note: string; sources: { seller_inputs: string[]; buyer_inputs: string[] };
  comparison: {
    verdict: string; text: string; seller_score: number | null; buyer_score: number | null; same_sign_in_both: string[]; conflicting_seller: string[]; conflicting_buyer: string[];
    top_seller: { name: string; contribution: number | null; text: string }[]; top_buyer: { name: string; contribution: number | null; text: string }[];
  };
}
export interface SourceRow { id: string; name: string; as_of: string | null; age_s: number | null; status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE"; reliability: string }
export interface AlertRow { id: number; at: string; kind: string; severity: string; direction: string; text: string; evidence: string[] }
export interface ScoreHistory { times: string[]; seller: (number | null)[]; buyer: (number | null)[]; regime: (string | null)[]; eff30: (number | null)[]; spot: (number | null)[] }

export interface McContext {
  as_of: string | null;
  volatility: { skew_25d: number | null; skew_10d: number | null; risk_reversal_25d: number | null; butterfly_25d: number | null; term_slope_30d: number | null; term_shape: string | null; term: { expiry: string; days: number | null; atm_iv: number | null }[] | null; atm_iv: number | null; expected_move_1sd_pts: number | null };
  options: {
    ce_oi: number | null; pe_oi: number | null; ce_oi_change: number | null; pe_oi_change: number | null; pcr_oi: number | null; pcr_vol: number | null; max_ce_oi_strike: number | null; max_pe_oi_strike: number | null;
    largest_call_additions: { strike: number; change: number }[]; largest_put_additions: { strike: number; change: number }[]; largest_call_unwinding: { strike: number; change: number }[]; largest_put_unwinding: { strike: number; change: number }[];
    demand: unknown[]; window: string | null; note: string | null;
  };
  futures: { oi_change: number | null; buildup: string | null; vwap: { vwap?: number | null; distance_pct?: number | null; side?: string | null } | null; flow: { cvd_pct?: number | null } | null; note: string | null };
  heavyweights: { aggregate: Record<string, { score: number | null; status?: string }> | null; participation: { class?: string } | null; method: string | null };
  groups: Record<string, { name: string; score: number | null; class: string }>;
  gex: Record<string, unknown> | null;
}

export interface StraddleDecay {
  status: "ok" | "unavailable";
  message?: string;
  session?: string;
  expiry?: string;
  expiry_day?: boolean;
  generated_at?: string;
  compute_ms?: number;
  model?: string;
  rate_assumed?: number;
  proxies?: string;
  definitions?: Record<string, string>;
  samples?: number;
  unusable?: Record<string, number>;
  times?: string[];
  spot?: (number | null)[];
  tracker?: {
    fixed: { strike: number; ce: Stat; pe: Stat; straddle: Stat };
    rolling: { ce: Stat; pe: Stat; straddle: Stat; rolls: number; adjusted_change: number | null };
    opening_at: string;
    atm_open?: number | null; atm_now?: number | null;
    moves?: { fixed: Record<"straddle" | "ce" | "pe", Moves>; rolling_adjusted: { straddle: Moves } };
    difference?: { fixed_minus_rolling_now: number | null; fixed_change: number | null; rolling_adjusted_change: number | null; note: string };
  };
  series?: {
    rolling: Record<"ce" | "pe" | "straddle" | "ce_iv" | "pe_iv" | "iv", (number | null)[]> & { strike: (number | null)[] };
    fixed: Record<"ce" | "pe" | "straddle" | "ce_iv" | "pe_iv" | "iv", (number | null)[]> & { strike: (number | null)[] };
    skew25: (number | null)[]; skew10: (number | null)[]; rr25: (number | null)[]; rr10: (number | null)[];
  };
  iv?: {
    fixed: { ce: Stat; pe: Stat; combined: Stat };
    rolling: { ce: Stat; pe: Stat; combined: Stat };
    skew25: Stat; skew10: Stat; rr25: Stat; rr10: Stat;
    levels?: Record<"pe25" | "ce25" | "pe10" | "ce10" | "butterfly25" | "butterfly10", Stat>;
    moves?: Record<"fixed_ce" | "fixed_pe" | "rolling_atm" | "skew25" | "rr25", Moves>;
    regimes?: Record<"open" | "30" | "60", IvRegime>;
    per_spot_pct: number | null;
    iv_vs_spot: { slope_pts_per_pct: number | null; corr: number | null; pairs: number; note: string };
    support: { side: string; text: string };
  };
  regime?: { label: string; reasons: string[]; accel: { ratio: number | null; label: string | null; now_15m: number | null; previous_15m: number | null }; path_efficiency_30m: number | null; note: string };
  retention?: { side: string; text: string; ce_retained_pct?: number | null; pe_retained_pct?: number | null };
  attribution?: { fixed: Windows; rolling: Windows };
  cumulative?: Record<"fixed" | "rolling", Record<"theta" | "vega" | "delta" | "gamma" | "residual" | "actual", (number | null)[]>>;
  realised_vs_implied?: {
    windows: Record<string, Realised>; iv_now: number | null; iv_open: number | null; gap: Record<string, number | null>;
    implied_move_pts: number | null; implied_move_pct: number | null; implied_daily_sd_pts: number | null;
    actual_move_pts: number | null; actual_range_pts: number | null; move_vs_daily_sd: number | null; move_30m_pts?: number | null; iv_state?: string;
    acceleration?: { ratio: number | null; label: string | null; now_15m: number | null; previous_15m: number | null };
    realised_variance: { sum_sq_returns: number | null; session_move_sd_pct: number | null; returns: number };
    note: string;
  };
  structure?: {
    gex: { at: string | null; net: number | null; regime: string; flip: number | null; flip_distance_pts: number | null; flip_distance_pct: number | null; net_change_15m: number | null; relationship: string; spot_change_15m_pct: number | null; call_wall?: number | null; put_wall?: number | null } | null;
    gex_session?: { first_net: number | null; latest_net: number | null; min_net: number | null; max_net: number | null; net_change: number | null; points: number; flip_crossings: number } | null;
    config?: { tag: string; why: string }[];
    assumption?: string;
    concentration: { share_pct: number | null; atm: number; contracts_missing: number; scope: string } | null;
    straddle_theta_per_day: number | null; straddle_gamma: number | null; breakeven_daily_move_pts: number | null; realised_daily_sd_pts: number | null; realised_vs_breakeven: number | null;
    spot_move_pts: number | null; note: string;
  };
  quality?: {
    last_sample_at: string; age_minutes: number | null; stale: boolean; live: boolean; steps_skipped_fixed: number; steps_skipped_rolling: number;
    forward_fallbacks: number; estimated: string[]; stride_note: string;
  };
  interpretation: { q: string; a: string }[];
  climate?: { label: "favourable" | "mixed" | "unfavourable" | "unknown"; tally: number; because: string[]; window: string; note: string };
  environment?: Environment | null;
  environment_note?: string;
  environment_trend?: Record<"seller" | "buyer", { now: number | null; m15: number | null; m30: number | null }> | null;
  context?: McContext | null;
  sources?: SourceRow[];
  history?: ScoreHistory | null;
  alerts?: AlertRow[];
  storage?: { rows_today: number; bytes: number };
}

export interface ValAgg { windows: number; predicted_mean?: number | null; actual_mean?: number | null; ratio_actual_to_predicted?: number | null; mae?: number | null; corr?: number | null; decayed_share_pct?: number | null }
export interface EnvBucket { n: number; mean_abs_move_pts?: number; mean_move_pts?: number; median_move_pts?: number; premium_picks?: number; mean_result_pts?: number; median_result_pts?: number; win_rate_pct?: number; max_adverse_pts?: number; max_drawdown_pts?: number; directional_n?: number; directional_accuracy_pct?: number | null; note?: string }
export interface EnvValidation {
  sessions: number; sufficient: boolean; message: string; recorded_minutes?: number; cost_points_per_round_trip?: number; assumptions?: string; limits?: string[]; method?: string;
  table?: Record<"seller" | "buyer", Record<string, Record<string, EnvBucket & { expiry_day: EnvBucket; non_expiry_day: EnvBucket; earlier_sessions: EnvBucket; later_sessions: EnvBucket }>>>;
}
export interface StraddleValidation {
  generated_at: string; window_minutes: number; sufficient: boolean; message: string; method: string; note: string;
  sessions: { session: string; expiry: string; windows: number; predicted: number | null; actual: number | null; ratio: number | null }[];
  overall: ValAgg; earlier_half: ValAgg; later_half: ValAgg;
  environment?: EnvValidation;
}
