import type { SwingLiveView, SwingMetrics, SwingPaperOrder, SwingPaperView, SwingReport, SwingTrade } from "../lib/types";

export const istToday = (offsetDays = 0): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));

const metrics = (over: Partial<SwingMetrics>): SwingMetrics => ({
  bars: 948, years: 3.85, final_equity: 1_954_376.93, net_profit: 954_376.93, return_pct: 95.44, cagr_pct: 19.03,
  max_drawdown_pct: 14.16, calmar: 1.34, sharpe_rf0: 0.99, trades: 467, wins: 159, win_rate_pct: 34.0,
  avg_win_over_avg_loss: 2.57, profit_factor: 1.33, avg_r: 0.14, avg_hold_win: 16.2, avg_hold_loss: 2.8,
  nifty_return_pct: 32.34, nifty_cagr_pct: 7.56, ...over,
});

export const trade = (over: Partial<SwingTrade> = {}): SwingTrade => ({
  symbol: "TITAN", sector: "CNXFMCG", archetype: "BLUE_SKY", score: 70, signal_date: "2024-03-01", entry_date: "2024-03-04",
  entry: 3500, pivot: 3490, initial_sl: 3300, shares: 50, exit_date: "2024-03-20", exit: 3800, reason: "STOP",
  pnl: 15000, return_pct: 8.57, r_mult: 1.5, hold_days: 12, ...over,
});

export function swingReport(over: Partial<SwingReport> = {}): SwingReport {
  const dates = ["2022-12-30", "2023-01-02", "2023-01-03", "2023-01-04"];
  return {
    schema: 1,
    meta: {
      generated_at_utc: "2026-11-04T18:27:00Z", data_through: istToday(), period_start: "2022-12-30",
      universe_fetched_at_utc: "2026-11-04T17:00:00Z", universe_size: 791, stocks_with_data: 791,
      scan_clause: "( {cash} ( market cap >= 300 ) )", price_basis: "Yahoo daily bars, split-adjusted",
      cost_per_side_pct: 0.15, params: { min_score: 65 },
    },
    kpis: { gross: metrics({}), net: metrics({ return_pct: 48.63, cagr_pct: 10.85, max_drawdown_pct: 17.08, profit_factor: 1.18, win_rate_pct: 24.8 }) },
    equity: {
      dates, gross: [1_000_000, 1_010_000, 1_020_000, 1_015_000], net: [1_000_000, 1_005_000, 1_010_000, 1_004_000],
      nifty: [1_000_000, 1_001_000, 1_002_000, 1_003_000], gross_dd: [0, 0, 0, -0.49], net_dd: [0, 0, 0, -0.59],
    },
    year_returns: [
      { year: 2023, gross_pct: 37.7, net_pct: 26.5, nifty_pct: 20.0 },
      { year: 2024, gross_pct: 25.0, net_pct: 15.0, nifty_pct: 8.8 },
    ],
    concentration: { top10_pnl: 898_902, total_pnl: 954_377, pnl_without_top10: 55_475, top10_share_pct: 94.2 },
    by_exit_reason: [
      { key: "STOP", trades: 229, win_rate_pct: 60.7, pnl: 2_126_796, avg_r: 0.67, pnl_pct_of_capital: 212.7 },
      { key: "D1_FAIL_CLOSE", trades: 155, win_rate_pct: 0, pnl: -776_730, avg_r: -0.35, pnl_pct_of_capital: -77.7 },
    ],
    by_archetype: [{ key: "BLUE_SKY", trades: 165, win_rate_pct: 35.2, pnl: 565_886, avg_r: 0.19, pnl_pct_of_capital: 56.6 }],
    by_sector: [{ key: "CNXINFRA", trades: 235, win_rate_pct: 33.6, pnl: 341_946, avg_r: 0.12, pnl_pct_of_capital: 34.2 }],
    by_year: [{ key: 2023, trades: 154, win_rate_pct: 33.8, pnl: 332_140, avg_r: 0.17, pnl_pct_of_capital: 33.2 }],
    trades: [
      trade({ symbol: "TITAN" }),
      trade({ symbol: "ARIS", entry_date: "2025-05-05", reason: "D1_FAIL_CLOSE", pnl: -3000, return_pct: -0.9, r_mult: -0.3, hold_days: 0, archetype: "CLASSIC_PIVOT" }),
      trade({ symbol: "KMEW", entry_date: "2025-06-02", reason: "D1_STOP", pnl: -9000, return_pct: -5.4, r_mult: -1, hold_days: 0 }),
    ],
    robustness: [
      { group: "Minimum score", label: "score ≥ 64", trades: 512, gross_return_pct: 21.5, net_return_pct: -9.4, gross_max_dd_pct: 22, gross_profit_factor: 1.08, net_profit_factor: 0.95 },
      { group: "Minimum score", label: "score ≥ 65  (rule)", trades: 467, gross_return_pct: 95.4, net_return_pct: 48.6, gross_max_dd_pct: 14.2, gross_profit_factor: 1.33, net_profit_factor: 1.18 },
    ],
    original_ledger: { source: "User-supplied audit ledger (402 trades), not independently verified", trades: 402, return_pct: 80.01, max_drawdown_pct: 13.91, profit_factor: 1.33, win_rate_pct: 33.58, costs: "none applied", prices: "dividend-adjusted", note: "PDF headline says 1.77." },
    caveats: ["Universe is today's Chartink list; survivorship flatters the test."],
    ...over,
  };
}

export function paperView(over: Partial<SwingPaperView> = {}): SwingPaperView {
  const order = (rank: number, symbol: string, score: number, over2: Partial<SwingPaperOrder> = {}): SwingPaperOrder => ({
    id: rank, session: istToday(), symbol, sector: "CNXINFRA", archetype: "BLUE_SKY", score, pillars: [24, 17, 20, 12],
    close: 3329.9, dist_pct: -2.32, pivot: 3409, trigger: 3419.23, max_open: 3494.23, initial_sl: 3168.01, risk_pct: 7.35,
    atr14: 110, min_volume: 52000, rank, ...over2,
  });
  return {
    status: { enabled: true, runs_after_ist: "17:00", running: false, done_today: true, last_result: "ok", last_run_at: "2026-11-04T12:00:00Z", started_session: "2026-10-30", rule_version: "swing-v1", progress: null },
    book: { capital: 1_000_000, equity: 1_024_500, cash: 612_000, invested: 412_500, open_positions: 1, slots: 5, return_pct: 2.45, as_of: istToday(), started: "2026-10-30", sessions: 4, nifty_return_pct: 1.1 },
    positions: [{
      symbol: "TITAN", sector: "CNXFMCG", archetype: "BLUE_SKY", score: 70, pivot: 3490, entry_session: "2026-11-02", entry_no: 2,
      fill: 3500, shares: 100, initial_sl: 3300, tsl: 3507, hh: 3720, last_close: 3650, value: 365_000, unrealized_pnl: 15_000,
      unrealized_pct: 4.29, stop_stage: "breakeven", risk_to_stop_pct: 3.9,
    }],
    orders: [order(1, "KMEW", 73), order(2, "ARIS", 68, { close: 147.38, trigger: 148.19, max_open: 151.44, initial_sl: 139.27, risk_pct: 6.02, min_volume: 410000 })],
    scan: {
      session: istToday(), ran_at: "2026-11-04T12:00:00Z", universe_size: 791, fetched_ok: 788, sectors_defaulted: 6, nifty_close: 23960.6,
      nifty_sma50: 23227.75, nifty_ok: true, sectors: [{ code: "CNXIT", ok: true }, { code: "CNXFMCG", ok: false }], candidates: 2, blocked_by_gate: 1, note: "",
    },
    decisions: [
      { decided_on: "2026-11-04", outcome: "filled", reason: "", fill: 3500, shares: 100, symbol: "TITAN", sector: "CNXFMCG", score: 70, signal_session: "2026-11-03", trigger_price: 3500, max_open: 3577, initial_sl: 3300, rank: 1 },
      { decided_on: "2026-11-04", outcome: "skipped", reason: "opened 102.60, above the no-chase limit 102.50", fill: null, shares: null, symbol: "ABC", sector: "CNXIT", score: 66, signal_session: "2026-11-03", trigger_price: 100.3, max_open: 102.5, initial_sl: 97, rank: 2 },
    ],
    trades: [{ id: 1, symbol: "ARIS", sector: "CNXINFRA", archetype: "CLASSIC_PIVOT", score: 68, entry_session: "2026-10-31", entry: 148.19, pivot: 147.75, initial_sl: 139.27, shares: 500, exit_session: "2026-10-31", exit: 146.9, reason: "D1_FAIL_CLOSE", gross_pnl: -645, costs: 220, pnl: -865, r_mult: -0.14, hold_sessions: 0 }],
    trade_totals: { closed: 1, wins: 0, net_pnl: -865, costs: 220 },
    equity: [
      { session: "2026-10-30", session_no: 1, equity: 1_000_000, cash: 1_000_000, invested: 0, open_positions: 0, nifty_close: 23700 },
      { session: "2026-11-04", session_no: 4, equity: 1_024_500, cash: 612_000, invested: 412_500, open_positions: 1, nifty_close: 23960.6 },
    ],
    recent_runs: [],
    config: { capital: 1_000_000, slots: 5, risk_pct: 2, min_score: 65, cost_per_side_pct: 0.15, cooldown: 3, rule_version: "swing-v1" },
    ...over,
  };
}

export function liveView(over: Partial<SwingLiveView> = {}): SwingLiveView {
  const base = { has_token: true, day_open: null, day_high: null, day_low: null, tick_age_s: 1.2, stale: false, note: "" };
  return {
    enabled: true, mode: "shadow", market: "open", feed_state: "streaming", note: null, updated_at: "2026-11-05T05:30:00Z",
    watching: [
      { ...base, symbol: "KMEW", kind: "order", rank: 1, ltp: 3405, prev_close: 3330, change_pct: 2.25, volume: 90_000, pace: 0.82,
        state: "waiting", trigger: 3419.23, max_open: 3494.23, stop: 3168.01, min_volume: 149_133 },
      { ...base, symbol: "TITAN", kind: "position", ltp: 3650, prev_close: 3600, change_pct: 1.39, volume: 1_200_000, state: "holding",
        fill: 3500, shares: 100, stop: 3507, r_now: 0.78, level_1_8r: 3860, level_2_5r: 4000, reached_1_8r: false, reached_2_5r: false,
        unrealized_pnl: 15_000 },
    ],
    events: [{ at: "2026-11-05T04:10:00Z", kind: "entry_trigger", symbol: "ARIS", price: 148.4, volume: 800_000, detail: {} }],
    ...over,
  };
}

