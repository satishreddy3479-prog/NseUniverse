// Test fixtures shaped like backend responses. Used only by tests.
import type {
  AppStatus, ChainResponse, ExpirySelection, LiveTick, SnapshotSummary, StreamStatus,
} from "../lib/types";

export const now = "2026-10-28T09:00:00Z";

export function streamStatus(over: Partial<StreamStatus> = {}): StreamStatus {
  return {
    implemented: true, state: "stopped", state_since: now, effective_state: "stopped",
    freshness: "none", data_source: "none", phase: "idle", test_subscription_result: "not_run",
    message_count: 0, tick_count: 0, instruments_with_data: 0, subscribed_tokens: 0,
    acknowledged_tokens: 0, reconnect_count: 0, connected_since: null, last_message_at: null,
    last_market_data_at: null, data_age_seconds: null, stale_after_seconds: 30, expiries: [],
    market: { state: "unknown", code: null, text: null, exchange_segment: null, received_at: null, source: "none" },
    recent_errors: [], note: "", ...over,
  };
}

export function liveTick(over: Partial<LiveTick> = {}): LiveTick {
  return {
    key: "nse_fo|101", kind: "scrip", exchange_segment: "nse_fo", instrument_token: "101",
    trading_symbol: "N101", ltp: 110, open: null, high: null, low: null, prev_close: 80, volume: 130,
    oi: null, net_change: null, net_change_pct: null, last_trade_time_raw: null,
    last_update_time_raw: null, received_at: now, seq: 1, source: "live", ...over,
  };
}

export function status(over: Partial<AppStatus> = {}): AppStatus {
  return {
    session_id: "sess-1", started_at: now,
    underlying: "NIFTY", broker: "kotak_neo",
    auth: { state: "authenticated", last_attempt_at: now, last_success_at: now, last_error: null },
    snapshots: { last_attempt_at: null, last_success_at: null, last_error: null, in_progress: false, captured_count: 0 },
    stream: streamStatus(),
    snapshot_stale_after_seconds: 300, server_time: now, ...over,
  };
}

export const expiries: ExpirySelection = {
  underlying: "NIFTY", as_of: "2026-10-28", available: ["2026-11-03", "2026-11-24"],
  weekly: "2026-11-03", monthly: "2026-11-24", monthly_is_next_month: true,
  weekly_equals_monthly: false, source: "snapshot", retrieved_at: now, warnings: [],
};

export function summary(over: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    snapshot_id: "20261028T090000Z_NIFTY_20261103_abc", session_id: "sess-1", underlying: "NIFTY",
    expiry: "2026-11-03", expiry_kinds: ["weekly"], source: "snapshot", retrieved_at: now,
    completeness: "complete", strikes: 2, ce_count: 2, pe_count: 2,
    file_ref: "snapshots/2026-10-28/x.json", underlying_ltp: 22698.85, underlying_prev_close: 22749.75, ...over,
  };
}

export function chain(over: Partial<ChainResponse> = {}): ChainResponse {
  const q = (t: "CE" | "PE", ltp: number | null) => ({
    exchange_segment: "nse_fo", instrument_token: "1", trading_symbol: `X${t}`, option_type: t,
    ltp, open: null, high: null, low: null, prev_close: null, close: null, volume: 10, oi: 100,
    oi_previous: 90, oi_change: 10, oi_change_pct: 11.1, moneyness: "OTM", invalid_fields: [],
  });
  return {
    snapshot: {
      ...summary(), exchange_timestamp: null, lot_size: 75, multiplier: 1, requested_strike_count: 2,
      rows: [{ strike: 24000, call: q("CE", 101.5), put: q("PE", null) }], warnings: [],
    },
    age_seconds: 3600, stale: true, display_source: "stored", ...over,
  };
}

/** A chain with several strikes; ATM at 24050. Prices are fixtures only. */
export function bigChain(): ChainResponse {
  const q = (t: "CE" | "PE", strike: number, over: Record<string, unknown> = {}) => ({
    exchange_segment: "nse_fo", instrument_token: `${strike}${t}`, trading_symbol: `N${strike}${t}`,
    option_type: t, ltp: 100, open: null, high: null, low: null, prev_close: 80, close: null,
    volume: 10, oi: 1000, oi_previous: 900, oi_change: 100, oi_change_pct: 11.1,
    moneyness: strike === 24050 ? "ATM" : "OTM", invalid_fields: [], ...over,
  });
  const strikes = [23900, 23950, 24000, 24050, 24100, 24150, 24200];
  const base = chain();
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      rows: strikes.map((k) => ({
        strike: k,
        call: q("CE", k, k === 24000 ? { ltp: null, prev_close: null } : {}),
        put: q("PE", k),
      })),
    },
    age_seconds: 5, stale: false, display_source: "snapshot",
  };
}
