// Mirrors backend pydantic models (backend/app/domain/models.py, app/api/routes.py).

export type DataSource = "live" | "snapshot" | "stored";
export type Completeness = "complete" | "partial" | "empty";
export type ExpiryKind = "weekly" | "monthly";
export type AuthState =
  | "not_attempted"
  | "authenticating"
  | "authenticated"
  | "failed";

export interface AuthStatus {
  state: AuthState;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

export interface SnapshotActivity {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  in_progress: boolean;
  captured_count: number;
}

export type StreamState =
  | "stopped" | "connecting" | "subscribing" | "waiting_for_data" | "streaming"
  | "reconnecting" | "auth_failed" | "failed";
export type Freshness = "none" | "fresh" | "stale" | "market_closed";

export interface MarketStatus {
  state: "unknown" | "open" | "closed" | "other";
  code: number | null;
  text: string | null;
  exchange_segment: string | null;
  received_at: string | null;
  source: "exchange_feed" | "none";
}

export interface StreamError { at: string; code: string; message: string }

export interface StreamStatus {
  implemented: boolean;
  state: StreamState;
  state_since: string | null;
  effective_state: string;
  freshness: Freshness;
  data_source: "live" | "none";
  phase: "idle" | "test_subscription" | "full_subscription";
  test_subscription_result: "not_run" | "received" | "no_data";
  message_count: number;
  tick_count: number;
  instruments_with_data: number;
  subscribed_tokens: number;
  acknowledged_tokens: number;
  reconnect_count: number;
  connected_since: string | null;
  last_message_at: string | null;
  last_market_data_at: string | null;
  data_age_seconds: number | null;
  stale_after_seconds: number;
  expiries: string[];
  market: MarketStatus;
  recent_errors: StreamError[];
  note: string;
}

/** True only for the streaming-era status shape. An older backend sends a different, smaller object. */
export function isStreamStatus(s: unknown): s is StreamStatus {
  const o = s as Partial<StreamStatus> | null | undefined;
  return (
    !!o && typeof o.state === "string" && typeof o.effective_state === "string" &&
    !!o.market && typeof o.market.state === "string" && typeof o.stale_after_seconds === "number"
  );
}

export interface LiveTick {
  key: string;
  kind: "scrip" | "index";
  exchange_segment: string;
  instrument_token: string;
  trading_symbol: string | null;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
  volume: number | null;
  oi: number | null;
  net_change: number | null;
  net_change_pct: number | null;
  last_trade_time_raw: number | null;
  last_update_time_raw: number | null;
  received_at: string;
  seq: number;
  source: "live";
}

export type ServerMessage =
  | { type: "hello"; status: StreamStatus; ticks: LiveTick[] }
  | { type: "ticks"; ticks: LiveTick[] }
  | { type: "status"; status: StreamStatus }
  | { type: "market"; market: MarketStatus };

export interface AppStatus {
  session_id: string;
  started_at: string;
  underlying: string;
  broker: string;
  auth: AuthStatus;
  snapshots: SnapshotActivity;
  stream: StreamStatus;
  snapshot_stale_after_seconds: number;
  server_time: string;
}

export interface ConfigStatus {
  credentials_present: Record<string, boolean>;
  allowed_origins: string[];
  host_is_loopback: boolean;
  underlying: string;
  option_chain_strike_count: number;
}

export interface ExpirySelection {
  underlying: string;
  as_of: string;
  available: string[];
  weekly: string | null;
  monthly: string | null;
  monthly_is_next_month: boolean;
  weekly_equals_monthly: boolean;
  source: DataSource;
  retrieved_at: string;
  warnings: string[];
}

export interface OptionQuote {
  exchange_segment: string | null;
  instrument_token: string | null;
  trading_symbol: string | null;
  option_type: "CE" | "PE";
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
  close: number | null;
  volume: number | null;
  oi: number | null;
  oi_previous: number | null;
  oi_change: number | null;
  oi_change_pct: number | null;
  moneyness: string | null;
  invalid_fields: string[];
}

export interface OptionChainRow {
  strike: number;
  call: OptionQuote | null;
  put: OptionQuote | null;
}

export interface SnapshotSummary {
  snapshot_id: string;
  session_id: string;
  underlying: string;
  expiry: string;
  expiry_kinds: ExpiryKind[];
  source: DataSource;
  retrieved_at: string;
  completeness: Completeness;
  strikes: number;
  ce_count: number;
  pe_count: number;
  file_ref: string;
  underlying_ltp: number | null;
  underlying_prev_close: number | null;
}

export interface OptionChainSnapshot extends Omit<SnapshotSummary, "strikes" | "file_ref"> {
  exchange_timestamp: string | null;
  lot_size: number | null;
  multiplier: number | null;
  underlying_ltp: number | null;
  underlying_prev_close: number | null;
  requested_strike_count: number;
  rows: OptionChainRow[];
  warnings: string[];
}

export interface ChainResponse {
  snapshot: OptionChainSnapshot;
  age_seconds: number;
  stale: boolean;
  display_source: DataSource;
}

export interface SessionInfo {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  data_mode?: string;
  snapshot_count: number;
}

export interface ErrorEvent {
  at: string;
  component: string;
  code: string;
  message: string;
}

export interface Observation {
  snapshot_id: string;
  retrieved_at: string;
  session_id: string;
  underlying_ltp: number | null;
  underlying_prev_close: number | null;
  atm_strike: number | null;
  atm_call_ltp: number | null;
  atm_put_ltp: number | null;
  straddle: number | null;
  total_ce_premium: number | null;
  total_pe_premium: number | null;
  total_ce_oi: number | null;
  total_pe_oi: number | null;
  total_ce_volume: number | null;
  total_pe_volume: number | null;
  strikes_in_universe: number;
  missing_ltp: number;
  same_as_previous: boolean;
}

export interface HistoryResponse {
  underlying: string;
  expiry: string;
  strikes_each_side: number;
  observations: Observation[];
  distinct_observations: number;
  definitions: Record<string, string>;
  note: string;
}

export interface SamplerStatus {
  enabled: boolean;
  interval_seconds: number;
  session: string;
  state: "off" | "waiting" | "sampling" | "error";
  reason: string;
  in_session: boolean;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  next_due_at: string | null;
  samples_this_run: number;
  skipped_unchanged: number;
  free_disk_gb: number | null;
}

export type BaselineKind = "previous" | "at" | "session_open" | "prev_session" | "broker_prev_day";

export interface OiRow {
  strike: number;
  side: "CE" | "PE";
  oi: number | null;
  baseline_oi: number | null;
  change: number | null;
  change_pct: number | null;
  label: string;
  ltp: number | null;
  baseline_ltp: number | null;
  price_change: number | null;
  price_change_pct: number | null;
  relation: string | null;
}

export interface OiChange {
  underlying: string;
  expiry: string;
  baseline: { kind: BaselineKind; label: string; at: string | null; note: string };
  current_at: string | null;
  spot: number | null;
  baseline_spot: number | null;
  underlying_change: number | null;
  atm_strike: number | null;
  strikes_each_side: number | null;
  rows: OiRow[];
  totals: { ce_oi: number | null; pe_oi: number | null; ce_change: number | null; pe_change: number | null };
  concentration: {
    strike: number; side: "CE" | "PE"; oi: number; share_pct: number;
    baseline_share_pct: number | null; share_change_pts: number | null;
  }[];
  observations_available: number;
  warnings: string[];
  definitions: Record<string, string>;
}

export interface OiHeatmap {
  underlying: string;
  expiry: string;
  side: "CE" | "PE";
  baseline: { kind: string; label: string; at: string | null; note: string };
  strikes: number[];
  times: string[];
  change: (number | null)[][];
  stride: number;
  atm_strike: number | null;
  missing_cells: number;
  warnings: string[];
}

export interface HistorySymbol {
  key: string;
  yahoo: string;
  name: string;
  kind: string;
  timing_verified: boolean;
  has_data: boolean;
  first?: string;
  last?: string;
  bars?: number;
  disagreements?: number;
}

export interface HistoryFetchStatus {
  enabled: boolean;
  source: string;
  running: boolean;
  progress: string;
  last_run: {
    run_id: string;
    started_at: string;
    finished_at: string | null;
    summary: { ok_symbols: number; failed_symbols: string[]; empty_symbols: string[]; new_bars: number; disagreements: number } | null;
  } | null;
  symbols: HistorySymbol[];
  started?: boolean;
}

export interface ForwardScore { n: number; brier: number; brier_base: number; hit: number; hit_ci: [number, number] }

export type Verdict = "better" | "promising" | "no_difference" | "worse";

export interface ModelScore {
  n: number; brier: number; log_loss: number; hit: number; hit_ci: [number, number];
  gain: number; gain_ci95: [number, number]; gain_ci_strict_low: number; skill: number; verdict: Verdict;
}

export interface ModelEval {
  description: string;
  params: Record<string, number> | null;
  holdout: ModelScore;
  tuning: { n: number; brier: number; gain: number; skill: number };
  calibration: { low: number; high: number; n: number; predicted: number; observed: number }[];
  folds: { start: string; end: string; n: number; brier_model: number; brier_base: number; phase: "tuning" | "holdout" }[];
}

export interface CallStats {
  threshold: number; rule: string; n_holdout: number; n_called: number; coverage?: number;
  hit?: number; hit_ci?: [number, number]; always_up_hit?: number; always_up_ci?: [number, number];
  verdict: "promising" | "no_edge_shown" | "too_few_calls";
}

export interface HorizonEval {
  available: boolean;
  reason?: string;
  n_labelled?: number;
  tuning_period?: [string, string];
  holdout_period?: [string, string];
  base?: { brier_holdout: number; brier_coin_flip: number; up_rate_holdout: number };
  models?: Record<string, ModelEval>;
  best_on_tuning?: string;
  calls?: CallStats;
  features?: string[];
  method?: string;
}

export interface ForecastPayload {
  event_risk?: EventItem[];
  p_up_model: number; p_up_raw: number; p_up_climatology: number; p_up_climatology_recent_750: number; model_verdict: Verdict;
  return_quantiles_climatological: Record<string, number>;
  top_drivers: { feature: string; log_odds: number; value: number }[];
  params: Record<string, number> | null;
  call: "up" | "down" | null; call_reason: string | null; call_strength: number | null; call_threshold: number | null;
}

export interface ModelForecast {
  reference_session: string;
  reference_close: number;
  first_target_session?: string;
  target_session?: string;
  recorded: boolean;
  preview?: boolean;
  forecast_id?: string;
  already_recorded?: boolean;
  reason?: string;
  payload: ForecastPayload | null;
}

export interface PredictionLedgerRow {
  forecast_id: string; model: string; model_version: string; reference_session: string; target_session: string; generated_at: string;
  p_up_model: number | null; p_up_climatology: number | null; intact: boolean;
  outcome: { realized: { positive: boolean; close_to_close?: number; ret5?: number }; status: string } | null;
  drivers?: { feature: string; log_odds: number; value: number }[]; call?: "up" | "down" | null;
}

export type PredictionSummary =
  | { ready: false; reason: string; computing?: boolean }
  | {
      ready: true;
      generated_at: string;
      computed_at: string;
      model_version: string;
      features: { T1: { version: string; names: string[] }; T5: { version: string; names: string[]; flows: string[] } };
      data: { symbol: string; bars: number; first: string; last: string; reference_close: number; up_rate_all: Record<string, number>; overnight_data_fresh: boolean; stale_series: string[]; inputs: Partial<Record<"T1" | "T5", Record<string, number>>> };
      evaluation: { initial_train: number; test_size: number; scheme: string; horizons: Record<"T1" | "T5" | "T5F", HorizonEval> };
      forecasts: Record<"T1" | "T5", { headline_model?: string; calls?: { call: "up" | "down" | null; reason: string | null; strength: number | null; threshold: number | null }; models: Record<string, ModelForecast> }>;
      excluded_inputs: string[];
      ledger: { counts: Record<string, { forecasts: number; outcomes: number }>; recent: Record<"T1" | "T5", PredictionLedgerRow[]>; scoreboard: Record<"T1" | "T5", Record<string, ForwardScore>> };
    };

export interface FlowsCoverage { first: string | null; last: string | null; files: number; not_published_404: number; last_stored_utc: string | null }
export interface FlowsStatus {
  enabled: boolean; running: boolean; progress: string; blocked: string | null; cash_note: string | null; source: string;
  last_run: { requests: number; stored: number; missing: number; errors: number; rejected: string[]; cash_new?: number } | null;
  coverage: Record<"fao_participant_oi" | "fao_participant_vol" | "fii_dii_cash", FlowsCoverage>;
}

export interface FlowsDay { session: string; participants: Record<string, Record<string, number>> }
export interface FlowsLatest { open_interest: FlowsDay[]; volume: FlowsDay[] }

export interface EventItem { id: string; name: string; kind: string; impact: string; start_ist: string; all_day: boolean; time_verified: boolean; tentative: boolean; source: string }
export interface NewsStatus {
  enabled: boolean; running: boolean; problems: string[]; source: string; not_used: string; model_use: string;
  coverage: { first_day: string | null; last_day: string | null; days: number; collecting_since: string | null; last_fetch: string | null };
  themes: Record<string, string>;
  latest: Record<string, { day: string; tone: number | null; volume_pct: number | null }[]>;
}

// ---- Intraday command center (/api/intraday/summary). Rules-based, provisional; never ML.
export interface IntradayComponent {
  key: string; name: string; weight: number; available: boolean; score: number | null; contribution: number | null;
  reason: string; formula: string; source: string; as_of: string | null;
  inputs: { name: string; value: number | null; unit: string; session?: string; note?: string }[];
}
export interface IntradayHealth { source: string; status: string; detail: string; as_of: string | null }
export interface IntradayScenario {
  name: string; horizon: string; probability: null; status: string; supporting: string[]; conflicting: string[];
  levels: Record<string, number | null>; strengthens: string; weakens: string;
}
export interface IntradayLevel { name: string; value: number | null; source: string; method: string; as_of: string | null }
export interface IntradaySummary {
  generated_at: string; expiry: string; compute_ms: number | null;
  market: {
    date: string; phase: string; trading_day: boolean | null; calendar_note: string | null; prev_session: string | null;
    mode: "live" | "delayed" | "stale" | "historical" | "unavailable"; last_sample_at: string | null; age_seconds: number | null;
    samples_today: number; missing_spot: number; spot_source: string;
  };
  price: {
    samples: number; last: number | null; last_at: string | null; prev_close: number | null; prev_close_source: string | null;
    change: number | null; change_pct: number | null; first: number | null; first_at: string | null;
    sampled_high: number | null; sampled_low: number | null; or_high: number | null; or_low: number | null;
    gap_pct: number | null; returns_pct: Record<string, number | null>; er_30: number | null; er_session: number | null;
    rv_pct: number | null; rv_ratio: number | null; range_pct: number | null; range_ratio: number | null;
    position_in_range: number | null; max_gap_min: number | null; vwap_reason: string;
  };
  daily: { prev_session: string | null; prev_high: number | null; prev_low: number | null; prev_close: number | null; daily_sd_pct: number | null; avg_range_pct: number | null };
  options: {
    strikes: number; atm_strike: number | null; ce_oi: number | null; pe_oi: number | null; ce_oi_chg: number | null; pe_oi_chg: number | null;
    ce_vol: number | null; pe_vol: number | null; pcr_oi: number | null; pcr_vol: number | null; pcr_oi_change: number | null;
    straddle: number | null; straddle_change_pct: number | null; max_ce_oi_strike: number | null; max_pe_oi_strike: number | null;
    missing: Record<string, number>; universe: string;
  };
  assessment: {
    score: number | null; label: string; direction: string; coverage: number; volatility: string; volatility_detail: string;
    components: IntradayComponent[]; version: string; provisional: boolean;
  };
  previous_score: { sample_utc: string; score: number | null; label: string } | null;
  changes: { component: string; delta: number }[];
  regime: { primary: string; tags: string[]; reason: string };
  scenarios: IntradayScenario[];
  /** Scenarios evaluated and ruled out by the current evidence, with the reason. */
  scenarios_ruled_out: { name: string; reason: string }[];
  /** Stock breadth, heavyweights, volume and sectors; null when the breadth service is off. */
  stocks: MarketSummary | null;
  structure?: PriceStructure;
  vwap?: FutureVwap | null;
  volatility?: VolatilityBlock;
  positioning?: PositioningBlock;
  setups?: SetupsBlock;
  narrative: string;
  context: { question: string; answer: string }[];
  levels: IntradayLevel[];
  global: { key: string; name: string; session: string; ret_pct: number | null; sd_pct: number | null; fresh: boolean }[];
  sectors: { rows: { key: string; name: string; session: string; ret_pct: number }[]; note: string };
  institutional: { session: string; fii_net: number | null; dii_net: number | null; fresh: boolean } | null;
  events: EventItem[];
  health: IntradayHealth[];
  ml: {
    status: string; stage_name: string; labelled_sessions: number; complete_sessions: number; sessions_with_samples: number;
    stages: { id: string; name: string; from_sessions: number; what: string }[];
    next: { name: string; at_sessions: number; sessions_to_go: number } | null;
    model_trained: boolean; reason: string;
  };
  config: { version: string; weights: Record<string, number>; min_coverage: number };
}
export interface BreadthBlock {
  total: number; covered: number; coverage: number; advancing: number; declining: number; flat: number;
  ad_ratio: number | null; ad_balance: number | null; pct_advancing: number | null; equal_weight_return: number | null;
  at_high: number; at_low: number; gainers: [string, number][]; losers: [string, number][];
}
export interface SectorRowT {
  sector: string; stocks: number; covered: number; advancing: number; declining: number; equal_weight_return: number | null;
  cap_weight_return: number | null; contribution_pts: number | null; relative_strength: number | null; rank: number | null; weighted_rv: number | null;
}
export interface BreakoutQuality { score: number | null; coverage: number; components: Record<string, number | null>; missing: string[]; weights: Record<string, number>; is_probability: boolean }
export interface BreakoutState {
  direction: "up" | "down"; status: "UNCONFIRMED" | "DEVELOPING" | "CONFIRMED" | "FAILED" | "INVALIDATED" | "EXPIRED";
  first_minute: number; beyond: number; clear: number; extension_ow: number | null; last_price: number | null; invalidation: number; or_minutes: number;
  previous?: string; quality: BreakoutQuality;
}
export interface OpeningRange { minutes: number; state: "forming" | "complete" | "no_data"; high: number | null; low: number | null; mid: number | null; width: number | null }
export interface PriceStructure {
  as_of: string; data: "LIVE" | "HISTORICAL"; completed_minutes: number; candle_note: string; ranges: OpeningRange[]; breakout: BreakoutState | null;
  structure: { label: string; last_swing_high: number | null; last_swing_low: number | null; break: string | null; swing_rule: string } | null;
}
export interface SideClass { label: string | null; reading: string | null; reason: string | null; premium_change?: number; oi_change?: number; strikes_used?: number }
export interface PositioningBlock {
  status: string; data?: string; as_of?: string; reference_minutes?: number;
  pcr_windows?: Record<string, { strikes: number; pcr_oi: number | null; pcr_volume: number | null; ce_oi: number | null; pe_oi: number | null }>;
  oi_change_pcr_since_open?: { value: number | null; reason: string | null; ce_change?: number | null; pe_change?: number | null };
  classification?: { available: boolean; reason?: string; limits: string; calls?: SideClass; puts?: SideClass };
  concentration?: { calls: { top3_share: number | null; max_strike: number | null }; puts: { top3_share: number | null; max_strike: number | null }; note: string };
  concentration_shift_since_open?: { calls: { top3_share_change: number | null; max_strike_from: number | null; max_strike_to: number | null }; puts: { top3_share_change: number | null; max_strike_from: number | null; max_strike_to: number | null } } | null;
}
export interface GreekRow { strike: number; side: "CE" | "PE"; price: number | null; otm: boolean; iv: number | null; delta: number | null; gamma: number | null; theta_day: number | null; vega_pt: number | null }
export interface VolatilityBlock {
  status: string; model?: string; rate_assumed?: number; dividends?: string; time_to_expiry_days?: number | null; data?: string; as_of?: string;
  forward?: number; forward_source?: string; atm_strike?: number; atm_iv?: number | null; atm_call_iv?: number | null; atm_put_iv?: number | null; near_atm_iv?: number | null;
  skew_25d_put_minus_call?: number | null; rows?: GreekRow[]; straddle?: number | null; expected_move_straddle_pts?: number | null; expected_move_iv_1sd_pts?: number | null;
  expected_move_note?: string;
  term_structure?: { rows: { expiry: string; days: number; atm_iv: number | null }[]; shape: string | null; iv_far_minus_near?: number; reason: string | null }; iv_change_pts?: Record<string, number | null>; realized_vol_60m?: number | null; iv_minus_realized?: number | null; interpretation?: string[];
}
export interface FutureVwap {
  price: number; vwap: number; distance_pts: number; distance_pct: number; distance_atr: number | null; side: "above" | "below" | "at";
  slope_pts_per_15m: number | null; crosses: number; minutes_above: number; minutes_below: number; events: { event: string; minute: number }[]; samples: number; note: string;
}
export interface Participation {
  above_vwap: { above: number; below: number; at: number; covered: number; missing: number; pct_above: number | null };
  opening_range: { above_high: number; below_low: number; inside: number; covered: number; missing: number; pct_above_high: number | null; pct_below_low: number | null; minutes: number } | null;
  momentum: { window_minutes: number; breadth_momentum: number | null; index_move_pct: number | null; state: string };
}
export interface FlowStats {
  symbol: string; estimated: boolean; since: string | null; buy_volume: number; sell_volume: number; unclassified_volume: number;
  cvd: number; cvd_pct: number | null; classified_share: number | null; quote_rule_share: number | null; volume: number | null; last_price: number | null;
  depth_imbalance: number | null; depth_imbalance_avg: number | null; updated: string | null;
  divergence: { window_minutes: number; price_change_pct: number; cvd_change: number; cvd_share_of_volume: number | null; state: string } | null;
  relative_volume?: number | null; relative_volume_reference?: string | null;
}
export interface TechnicalRead {
  symbol: string; bars: number; last_session: string | null; last_close: number | null; sma20: number | null; sma50: number | null; rsi14: number | null;
  atr14: number | null; atr_pct: number | null; high20: number | null; low20: number | null; avg_volume20: number | null; trend: string | null;
  price_vs_sma20_pct: number | null; range_position: number | null; enough_history: boolean;
}
export interface FlowBlock {
  futures: FlowStats | null; futures_contract: string | null; futures_note: string;
  heavy5: { basis: string; stocks: { symbol: string; weight: number | null; change_pct: number | null; volume: number | null; relative_volume: number | null; flow: FlowStats | null; technical: TechnicalRead }[] };
  baseline: { profile_sessions_futures: number; futures_profile_ready: boolean; stock_profile_ready: boolean; needs_sessions: number };
}
export interface MarketSummary {
  generated_at: string; elapsed_minutes: number; index_change_pct: number | null;
  sources: {
    lists: { nifty50: { stocks: number; fetched_utc: string } | null; nifty500: { stocks: number; fetched_utc: string } | null };
    tokens: { day: string | null; found: number; of: number };
    weights: { as_of: string; source: string; stocks: number; approximate: boolean; rolled_to?: string | null; age_days?: number; stale?: boolean } | null;
    volume_baseline: { sessions: number; stocks: number; needs_sessions: number; history_sessions?: number };
    list_changes?: { index: string; detected: string; added: string[]; removed: string[] }[];
    live: { stocks_with_ticks: number; subscribed: number };
  };
  nifty50: {
    breadth: BreadthBlock;
    contribution: { weight_covered: number; weight_loaded: number; cap_weight_return: number | null; net_points_pct: number | null; top5_share: number | null; top10_share: number | null; stocks_for_half: number | null } | null;
    volume: { covered: number; weighted_rv: number | null; reference: string; up_volume_share: number | null; low_volume_names: string[] } | null;
    quality: { state: string; reasons: string[]; provisional: boolean };
    stocks: { symbol: string; sector: string | null; weight: number | null; change_pct: number | null; contribution: number | null; volume: number | null; relative_volume: number | null }[];
    weights: { as_of: string; source: string; approximate: boolean; rolled_to?: string | null } | null;
  };
  nifty500: { breadth: BreadthBlock };
  flow?: FlowBlock;
  participation?: Participation;
  sectors: { nifty50: SectorRowT[]; nifty500: SectorRowT[]; rotation: { sector: string; from_rank: number; to_rank: number; direction: string }[] };
}
export interface IntradayScoreRow { sample_utc: string; spot: number | null; score: number | null; label: string; coverage: number; regime: string | null }

// ---- Storage and end-of-day (/api/storage/status)
export interface StorageStatus {
  data_dir_bytes: number; logs_bytes: number;
  categories: { name: string; class: string; files: number; bytes: number; rule: string }[];
  disk: { free_bytes: number; total_bytes: number; free_gb: number };
  growth_bytes_per_day: number; runway_days: number | null; growth_note: string;
  pressure: "ok" | "watch" | "low" | "critical";
  snapshot_pruning_plan: { executed: boolean; approved: boolean; older_than_days: number; eligible_days: number; files: number; bytes: number; blocked: { day: string; reason: string }[] };
  end_of_day: {
    enabled: boolean; runs_after_ist: string; backup_after_ist: string; pending_days: string[]; sessions_archived: number; complete_sessions: number;
    last_attempt_at: string | null; last_result: { state: string; [k: string]: unknown };
    last_backup: { day: string; ok: boolean; files: number; removed: string[]; problems: string[] } | null; last_tidy: { files_removed: number; bytes_freed: number } | null;
    backups_enabled: boolean; snapshot_retention: { raw_days: number; normalized_days: number; last_run: { raw_files: number; normalized_files: number } | null };
  };
  daily_models: { when: string; intraday_model: string };
}

// ---- Intraday model research (/api/intraday/research)
export interface ModelMetrics { log_loss: number; brier: number; accuracy: number; balanced_accuracy: number | null; n: number; calibration: { ece: number } }
export interface ResearchReport {
  status: "insufficient" | "experimental" | "validated"; sessions: number; rows: number; horizon_minutes: number; reason?: string;
  test_sessions?: number; models?: Record<string, ModelMetrics>; dropped?: { ambiguous: number; missing: number }; effective_observations?: number;
  gate?: { status: string; show_probabilities: boolean; reasons: string[]; label: string | null; beat_share?: number; ece?: number }; note?: string;
}

// ---- Setup monitor (read-only decision support), replay and paper trading
export interface SetupCandidate {
  setup: string; direction: "long" | "short" | null; status: "ACTIVE" | "WATCH" | "BLOCKED" | "REJECTED"; entry_condition: string; entry_ref?: number; stop?: number; target?: number;
  risk_pts?: number; reward_pts?: number; reward_risk?: number | null; net_reward_after_costs_pts?: number; costs_pts?: number; lots?: number; max_loss_rs?: number;
  holding_horizon_min?: number; probability: null; probability_note: string; liquidity?: { spread_pts: number } | null; data_quality: string; reason: string; invalidation: string;
  rejected_because?: string[]; blocked_because?: string[]; levels?: number[];
}
export interface SetupsBlock {
  candidates: SetupCandidate[]; decision: string; active: number; global_blockers: string[]; read_only: boolean; note?: string;
  risk?: { max_loss_per_trade_rs: number; max_daily_loss_rs: number; max_trades: number; max_consecutive_losses: number; min_reward_risk: number; cutoff: string };
}
export interface ReplaySessions { sessions: { session: string; samples: number; expiries: string[] }[] }
export interface ReplayResult {
  status: string; replay?: boolean; session: string; at: string; last_sample_at?: string; summary?: IntradaySummary;
  after_the_fact?: Record<string, { outcome: string; reason?: string; minutes_to_touch?: number; barrier_pts?: number; mfe_pts?: number; mae_pts?: number } | undefined> | null; after_the_fact_note?: string;
}
export interface PaperReport {
  sessions: number; trades: number; min_trades_for_a_conclusion: number; conclusion: string; net_rupees: number; gross_rupees_before_costs?: number; costs_and_slippage_rupees?: number;
  win_rate?: number; expectancy_rupees?: number; profit_factor?: number | null; max_drawdown_rupees?: number; by_setup?: Record<string, { trades: number; net_rupees: number; wins: number }>;
  assumptions?: { instrument: string; lot_size: number; slippage_pts_per_side: number };
}
