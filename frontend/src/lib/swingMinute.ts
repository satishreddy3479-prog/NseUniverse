/** Types of /api/swing/minute: the 1-minute shadow book (live-style swing rules on completed candles, beside the official book). Shadow only: no order is ever placed. */

export interface MinuteWatch { read_at?: string | null; symbol: string; rank: number; score: number; trigger: number; stop: number; max_open: number; min_volume: number; state: string; note: string | null; pace: number | null; last_close: number | null }
export interface MinutePosition {
  id: number; symbol: string; session: string; fill: number; shares: number; initial_sl: number; tsl: number; hh_close: number; last_price: number | null; last_at: string | null; filled_at: string;
  r_now: number | null; stage: string; unrealized_pnl: number; evidence: string;
  level_1_8r?: number; level_2_5r?: number; reached_1_8r?: boolean; reached_2_5r?: boolean; to_stop_pct?: number | null;
}
export interface MinuteClosed {
  id: number; symbol: string; session: string; fill: number; shares: number; filled_at: string; exit_at: string | null; exit_price: number | null; exit_reason: string | null; exit_basis: string | null;
  gross_pnl: number | null; costs: number | null; pnl: number | null; evidence: string;
}
export interface MinuteEvent { id: number; at: string; symbol: string; kind: string; price: number | null; detail: Record<string, unknown> }
export interface MinuteEntryCompare { symbol: string; rank: number; official: string; shadow: string; official_filled: boolean; shadow_filled: boolean; same: boolean; fill_diff_pct: number | null; states: string[] }
export interface MinuteExitCompare { symbol: string; official: string; shadow: string | null; shadow_took_it: boolean; exit_diff_pct: number | null }
export interface MinuteComparison {
  session: string; at: string; entries: MinuteEntryCompare[]; exits: MinuteExitCompare[];
  summary: { orders: number; both_filled: number; only_official: number; only_shadow: number; neither: number; exits_compared: number };
}
export interface MinuteView {
  mode: "shadow"; enabled: boolean; rules: string[]; market_open: boolean; session: string; volume_basis: "profile" | "straight-line"; expected_share_of_day_now: number; profile_ready: boolean;
  book: { cash: number; equity: number; capital: number; open: number; closed: number; slots: number; realised_pnl: number; unrealised_pnl: number };
  positions: MinutePosition[]; watching: MinuteWatch[]; recent_closed: MinuteClosed[];
  closed_trades?: MinuteClosedTrade[]; analytics?: MinuteAnalytics; equity_curve?: MinuteEquityPoint[]; started?: { first_fill_at: string | null; equity_recorded_from: string | null }; events: MinuteEvent[]; comparisons: MinuteComparison[];
  data: { symbols_with_bars: number; bars_today: number; expected_bars_per_symbol: number; coverage: Record<string, number | null>; last_poll_at: string | null; note: string };
  windows: { entry_from: string; entry_until: string; day1_check: string };
  updated_at: string;
}

// ---- the live paper book as a portfolio: analytics, equity curve, levels, dates (added with the single Live paper book page)
export interface MinuteAnalytics {
  trades: number; wins: number; losses: number; win_rate_pct: number | null; net_pnl: number | null; gross_pnl: number | null; costs: number | null;
  avg_win: number | null; avg_loss: number | null; profit_factor: number | null; expectancy: number | null; avg_r: number | null; avg_hold_minutes: number | null;
  best: { symbol: string; pnl: number } | null; worst: { symbol: string; pnl: number } | null; return_pct: number | null; max_drawdown_pct: number | null;
  equity_points: number; equity_from: string | null;
}
export interface MinuteEquityPoint { at: string; equity: number }
export interface MinuteClosedTrade extends MinuteClosed { initial_sl: number; r: number | null }
export interface MinutePositionLevels { level_1_8r?: number; level_2_5r?: number; reached_1_8r?: boolean; reached_2_5r?: boolean; to_stop_pct?: number | null }
