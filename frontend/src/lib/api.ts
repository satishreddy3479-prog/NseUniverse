import type {
  ForwardCheck,
  PaperReport,
  ReplayResult,
  ReplaySessions,
  AppStatus,
  StreamStatus,
  ChainResponse,
  ConfigStatus,
  ErrorEvent,
  ExpirySelection,
  FlowsLatest, StorageStatus, IntradayScoreRow, IntradaySummary, FlowsStatus, HistoryFetchStatus, HistoryResponse, OiChange, OiHeatmap, OiSeries, StrikeSeries, FuturesSeries, HvReport, IvChart, IvSkew, IvSeries, IndexBars, PremiumDecay, SamplerStatus, SwingReport, SwingPaperView, SwingLiveView,
  SessionInfo,
  SnapshotSummary,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" }, ...init });
  } catch {
    throw new ApiError(0, "network", "Backend unreachable. Is it running on port 8000?");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: { code?: string; message?: string } };
      if (body.detail?.code) code = body.detail.code;
      if (body.detail?.message) message = body.detail.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/** The strategy the builder is managing, as the server holds it; the server checks its stops and targets every second. */
export interface RunningDoc {
  rev?: number; auto?: boolean; lotSize?: number | null; mult?: number; expiry?: string | null; name?: string; loaded?: string | null;
  legs?: import("./strategy").Leg[]; rules?: import("./strategy").StrategyRules; rstate?: import("./strategy").RulesState | null; rearmAt?: string | null; hold?: import("./strategy").HoldRule; moveToCost?: boolean; holdFrom?: string | null; baseline?: import("./strategy").Leg[]; serverEvents?: { at: string; text: string }[];
}
export interface RunningResponse { doc: RunningDoc | null; checking: { live: boolean; last_check_at: string | null; error: string | null } }

/** What /api/market/summary returns for the NIFTY 50 tools; only the fields the pages use. Missing stays null. */
export interface MarketStockRow { symbol: string; sector: string | null; weight: number | null; change_pct: number | null; contribution: number | null; volume: number | null; relative_volume: number | null }
export interface MarketSectorRow { sector: string; stocks: number; covered: number; advancing: number; declining: number; equal_weight_return: number | null; cap_weight_return: number | null; contribution_pts: number | null; relative_strength: number | null; rank: number | null }
export interface MarketSummary {
  generated_at: string; index_change_pct: number | null;
  nifty50: {
    breadth: { total: number; covered: number; advancing: number; declining: number; flat: number; ad_ratio: number | null; pct_advancing: number | null; equal_weight_return: number | null; at_high: number; at_low: number; coverage: number };
    contribution: { weight_covered: number; weight_loaded: number; cap_weight_return: number | null; net_points_pct: number | null; top5_share: number | null; top10_share: number | null; stocks_for_half: number | null } | null;
    stocks: MarketStockRow[];
    weights: { as_of: string; source: string; approximate: boolean; rolled_to: string | null } | null;
  };
  sectors: { nifty50: MarketSectorRow[] };
}

export interface StoredStrategies { saved: Record<string, unknown>[]; closed: Record<string, unknown>[] }

export interface MarketSessionInfo {
  open: string; close: string; label: string; source: string; configured: string;
  observed: { day: string; closed_at: string; close: string | null }[];
  pending_change: { close: string; day: string; note: string } | null;
  holidays: string[]; holiday_coverage: [string, string];
}

export interface CleanupCandidate {
  id: string; label: string; files: number; rows?: number; bytes: number; why_safe: string; blocked: number; enabled: boolean;
  days?: string[]; blocked_detail?: { day: string; reason: string }[];
}
export interface CleanupOverview {
  disk: { free_bytes: number; total_bytes: number; free_gb: number }; pressure: "ok" | "watch" | "low" | "critical";
  data_bytes: number; logs_bytes: number; growth_bytes_per_day: number; runway_days: number | null;
  stores: { file: string; name: string; holds: string; keep: string; bytes: number; tables: Record<string, number> }[];
  files: { name: string; holds: string; keep: string; files: number; bytes: number }[];
  today: {
    date: string; samples: number; contract_rows: number; contract_bytes_estimate: number; snapshot_files: number; snapshot_bytes: number; note: string;
    expiries: { expiry: string; samples: number; unchanged: number; first: string; last: string }[];
    intraday: { scores: number; feature_rows: number; summaries: number };
  };
  candidates: CleanupCandidate[]; removable_bytes: number; never_deleted: { name: string; why: string }[];
  policy: { raw_days: number; normalized_days: number; contract_row_sessions: number };
  last_runs: Record<string, unknown>;
}

export interface OpsAlert { key: string; level: "critical" | "warning"; text: string }
export interface OpsAlerts { available: boolean; checked_at: string | null; alerts: OpsAlert[]; release: string | null }

export interface HolidayEntry { date: string; name: string }
export interface HolidaysView {
  reference: { coverage: [string, string]; holidays: HolidayEntry[]; special_sessions: HolidayEntry[] };
  user: { coverage_to: string | null; source: string | null; updated_at: string | null; holidays: HolidayEntry[]; special_sessions: HolidayEntry[] };
  effective_coverage: [string, string];
}
export interface HolidaysUpdate { coverage_to: string; source: string; holidays: HolidayEntry[]; special_sessions: HolidayEntry[]; confirm_complete: boolean }

export interface GlobalItem {
  key: string; name: string; unit: string; decimals: number; kind: string; core: boolean; yield: boolean;
  price: number | null; status: string; change?: number | null; change_pct?: number | null; bp?: number | null; prev_close?: number | null;
  as_of?: string; age_s?: number; session?: string; spark?: number[]; chart_url?: string; note?: string; delay_min?: number;
}
export interface GlobalOverview {
  generated_at: string; groups: { key: string; title: string; items: GlobalItem[] }[];
  meta: { source: string; last_poll_ok: string | null; last_poll_age_s: number | null; last_error: string | null; stale: boolean };
}
export interface GlobalSeries { key: string; name?: string; unit?: string; decimals?: number; yield?: boolean; status?: string | null; prev_close?: number | null; source_url?: string; times: string[]; prices: number[]; error?: string }
export interface CalEvent {
  id: string; time_ist: string; all_day: boolean; country: string; name: string; impact: string; actual: string | null; forecast: string | null; previous: string | null;
  source: string; note: string | null; state: "upcoming" | "released" | "past"; minutes_to: number | null;
  /** how the actual came out against the forecast (null: nothing to compare yet, or the two readings cannot be compared) */
  outcome?: { status: "BEAT" | "MISS" | "HOT" | "COOLING" | "INLINE" | "ABOVE" | "BELOW"; label: string; tone: "up" | "down" | "flat"; diff: number; diff_text: string } | null;
}
export interface CalendarView {
  generated_at: string; today: string; note: string; next: CalEvent | null;
  sections: { key: string; title: string; events: CalEvent[] }[];
  sources: { name: string; last_ok: string | null; last_error: unknown }[];
}
export interface HeadsUpReminder { key: string; event_id: string; phase: string; name: string; country: string; impact: string; time_ist: string; minutes_to: number; previous: string | null; forecast: string | null }
export interface HeadsUpNews { key: string; title: string; link: string; source: string; topics: string[]; age_min: number }
export interface HeadsUpTradeAlert { key: string; source: "strategy" | "swing"; kind: string; level: "good" | "bad" | "warn" | "info"; title: string; text: string; at: string; link: string }
export interface HeadsUpTrades { generated_at: string; alerts: HeadsUpTradeAlert[] }
export interface HeadsUp { generated_at: string; reminders: HeadsUpReminder[]; news: HeadsUpNews[] }
export interface ForwardVariant { variant: string; label: string; n: number; wins?: number; win_rate?: number; total?: number; avg?: number; best?: number; worst?: number; max_drawdown?: number; profit_factor?: number | null; avg_intraday_worst?: number | null; stop_rate?: number; twin?: ForwardVariant }
export interface ForwardPortfolioTrade {
  id: number; session: string; cohort: string; structure: string; n: number; expiry: string; trigger_at: string; settled_at: string | null; spot0: number; ce_strike: number; pe_strike: number;
  ce0: number; pe0: number; ce_exit: number; pe_exit: number; gross: number; cost: number; net: number; worst: number | null; reason: string; stopped_at: string | null;
  regime: string | null; seller: number | null; buyer: number | null; net_move: number | null; ce_at: string | null; pe_at: string | null;
}
export interface ForwardOpen {
  id: number; session: string; cohort: string; expiry: string; structure: string; n: number; trigger_at: string; ce_strike: number; pe_strike: number; ce0: number; pe0: number; spot0: number; spot: number | null;
  seller: number | null; regime: string | null; variants: Record<string, { pnl: number | null; ce_open: boolean; pe_open: boolean; stopped_at: string | null; ce_exit: number | null; pe_exit: number | null; ce_last: number | null; pe_last: number | null; ce_at: string | null; pe_at: string | null }>;
}
export interface ForwardBreakdownRow { bucket: string; n: number; win_rate?: number; avg?: number; total?: number; worst?: number; stop_rate?: number }
export interface ForwardToday {
  session: string; in_window: boolean; cap: number; threshold: number; rearm_minutes: number;
  cohorts: { cohort: string; expiry: string | null; seller: number | null; score_at: string | null; count: number; armed: boolean; below_since: string | null; opened: string[] }[];
}
export interface ForwardOverview {
  generated_at: string; today: ForwardToday; filters: { structure: string; cohort: string; rule: string; rule_label: string; family: string; dte: string; dte_counts: Record<string, number> };
  meta: { enabled: boolean; counts: { open: number; settled: number; days: number }; last_run: { at: string; ok: boolean } | null; last_tick: string | null; last_error: string | null; bytes: number; min_trades: number; setup: { trigger: string; rearm: string; entry_window: string; exit: string; lot: number } };
  rules: ForwardVariant[]; portfolio: ForwardPortfolioTrade[];
  breakdown: { dimension: string; title: string; options: Record<string, string>; min_trades: number; rows: ForwardBreakdownRow[] };
  open: ForwardOpen[];
}
export interface StraddleScores { available: boolean; session?: string; at?: string; age_s?: number; expiry?: string; seller?: number; buyer?: number; regime?: string | null; seller_15m?: number | null; buyer_15m?: number | null }
export interface NewsItem { id: string; title: string; link: string; summary: string; source: string; section: string; published: string; age_min: number; fetched: string; topics: string[] }
export interface NewsView {
  generated_at: string; india: NewsItem[]; global: NewsItem[];
  meta: { last_poll_ok: string | null; stale: boolean; last_error: unknown; sources: string[]; note: string };
}

export const api = {
  globalOverview: () => request<GlobalOverview>("/api/global/overview"),
  globalSeries: (symbol: string, hours: number) => request<GlobalSeries>(`/api/global/series?symbol=${encodeURIComponent(symbol)}&hours=${hours}`),
  calendar: () => request<CalendarView>("/api/calendar"),
  straddleScores: () => request<StraddleScores>("/api/intelligence/straddle/scores"),
  forward: (structure: string, cohort: string, rule: string, dim: string, family: string, dte = "all") => request<ForwardOverview>(`/api/forward/overview?structure=${structure}&cohort=${cohort}&rule=${rule}&dim=${dim}&family=${family}&dte=${dte}`),
  headsUp: () => request<HeadsUp>("/api/global/headsup"),
  headsUpTrades: () => request<HeadsUpTrades>("/api/headsup/trades"),
  news: () => request<NewsView>("/api/news"),
  holidays: () => request<HolidaysView>("/api/market/holidays"),
  putHolidays: (body: HolidaysUpdate) =>
    request<HolidaysView>("/api/market/holidays", { method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  opsAlerts: () => request<OpsAlerts>("/api/ops/alerts"),
  cleanupOverview: () => request<CleanupOverview>("/api/storage/cleanup"),
  cleanupRun: (items: string[]) =>
    request<{ ok: boolean; result: Record<string, unknown> }>("/api/storage/cleanup", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ items, confirm: true }),
    }),
  marketSession: () => request<MarketSessionInfo>("/api/market/session"),
  strategies: () => request<StoredStrategies>("/api/strategies"),
  putStrategy: (kind: "saved" | "closed", key: string, doc: unknown) =>
    // the name goes in the body: names like "straddle 30/10/2026" contain slashes that a proxy would split into path parts
    request<{ ok: boolean }>(`/api/strategies/${kind}`, {
      method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ key, doc }),
    }),
  marketSummary: () => request<MarketSummary>("/api/market/summary"),
  runningGet: () => request<RunningResponse>("/api/strategies/running"),
  runningPut: (doc: unknown, baseRev: number | null) =>
    request<{ ok: boolean; rev: number }>("/api/strategies/running", {
      method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ doc, base_rev: baseRev }),
    }),
  deleteStrategy: (kind: "saved" | "closed", key: string) =>
    request<{ ok: boolean; deleted: boolean }>(`/api/strategies/${kind}?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  importStrategies: (saved: Record<string, unknown>, closed: Record<string, unknown>) =>
    request<{ added: number }>("/api/strategies/import", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ saved, closed }),
    }),
  status: () => request<AppStatus>("/api/status"),
  config: () => request<ConfigStatus>("/api/config/status"),
  errors: () => request<ErrorEvent[]>("/api/errors"),
  expiries: (refresh = false) =>
    request<ExpirySelection>(`/api/expiries${refresh ? "?refresh=true" : ""}`),
  snapshots: (limit = 50) => request<SnapshotSummary[]>(`/api/snapshots?limit=${limit}`),
  snapshot: (id: string) => request<ChainResponse>(`/api/snapshots/${encodeURIComponent(id)}`),
  sessions: () => request<SessionInfo[]>("/api/sessions"),
  optionChain: (expiry: string) => request<ChainResponse>(`/api/option-chain?expiry=${encodeURIComponent(expiry)}`),
  /** any listed expiry, fetched live and not stored (the Strategy builder's calendar and multi-expiry strategies) */
  optionChainOnDemand: (expiry: string) => request<ChainResponse>(`/api/option-chain/on-demand?expiry=${encodeURIComponent(expiry)}`),
  capture: (expiry?: string) =>
    request<SnapshotSummary[]>(
      `/api/snapshots/capture${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ""}`,
      { method: "POST" },
    ),
  login: () => request<AppStatus["auth"]>("/api/auth/login", { method: "POST" }),
  streamStart: () => request<StreamStatus>("/api/stream/start", { method: "POST" }),
  streamStop: () => request<StreamStatus>("/api/stream/stop", { method: "POST" }),
  oiChange: (expiry: string, baseline: string, strikes: string, at?: string, until?: string) =>
    request<OiChange>(
      `/api/oi/change?expiry=${encodeURIComponent(expiry)}&baseline=${baseline}&strikes=${strikes}` +
        (at ? `&at=${encodeURIComponent(at)}` : "") + (until ? `&until=${encodeURIComponent(until)}` : ""),
    ),
  indexBars: () => request<IndexBars>("/api/market/index-bars"),
  intradayHv: () => request<HvReport>("/api/intraday/hv"),
  intradayIvChart: (hv: number) => request<IvChart>(`/api/intraday/iv-chart?hv=${hv}`),
  intradayIvSeries: (expiry: string, o: { session?: string; tf?: number; maxPoints?: number } = {}) =>
    request<IvSeries>(`/api/intraday/iv-series?expiry=${encodeURIComponent(expiry)}${o.session ? `&session=${o.session}` : ""}${o.tf ? `&tf=${o.tf}` : ""}${o.maxPoints ? `&max_points=${o.maxPoints}` : ""}`),
  intradayIvSessions: () => request<{ sessions: string[] }>("/api/intraday/iv-sessions"),
  intradayIvMomentum: (expiry: string, tf = 1) => request<import("./types").IvMomentum>(`/api/intraday/iv-momentum?expiry=${encodeURIComponent(expiry)}&tf=${tf}`),
  intradayStrikePositioning: (expiry: string, window = "15") => request<import("./types").StrikePositioning>(`/api/intraday/strike-positioning?expiry=${encodeURIComponent(expiry)}&window=${window}`),
  intradayBacktest: (expiry: string, sessions = 15, cost = 5, universe = "dynamic") => request<import("./types").Backtest>(`/api/intraday/backtest?expiry=${encodeURIComponent(expiry)}&sessions=${sessions}&cost_bps=${cost}&universe=${universe}`),
  intradayGexHistory: (expiry: string, universe = "dynamic", session?: string) => request<import("./types").GexHistory>(`/api/intraday/gex-history?expiry=${encodeURIComponent(expiry)}&universe=${universe}${session ? `&session=${session}` : ""}`),
  intradayPremiumBaskets: (expiry: string, window = "10", kind = "fixed") => request<import("./types").PremiumBaskets>(`/api/intraday/premium-baskets?expiry=${encodeURIComponent(expiry)}&window=${window}&kind=${kind}`),
  intradayIvSkew: (expiry: string, session?: string) => request<IvSkew>(`/api/intraday/iv-skew?expiry=${encodeURIComponent(expiry)}${session ? `&session=${encodeURIComponent(session)}` : ""}`),
  futuresSeries: (since?: string) => request<FuturesSeries>("/api/futures/series" + (since ? `?since=${encodeURIComponent(since)}` : "")),
  oiSeries: (expiry: string, strikes: string, since?: string, maxPoints?: number) =>
    request<OiSeries>(
      `/api/history/oi-series?expiry=${encodeURIComponent(expiry)}&strikes=${strikes}` + (since ? `&since=${encodeURIComponent(since)}` : "") + (maxPoints ? `&max_points=${maxPoints}` : ""),
    ),
  strikeSeries: (expiry: string, strikes: string, since?: string, until?: string) =>
    request<StrikeSeries>(
      `/api/history/strike-series?expiry=${encodeURIComponent(expiry)}&strikes=${encodeURIComponent(strikes)}` + (since ? `&since=${encodeURIComponent(since)}` : "") + (until ? `&until=${encodeURIComponent(until)}` : "") + "&max_points=1000",
    ),
  premiumDecay: (expiry: string, strikes: string, since?: string) =>
    request<PremiumDecay>(
      `/api/history/premium-decay?expiry=${encodeURIComponent(expiry)}&strikes=${strikes}` + (since ? `&since=${encodeURIComponent(since)}` : ""),
    ),
  oiHeatmap: (expiry: string, side: "CE" | "PE", baseline: string, strikes: string) =>
    request<OiHeatmap>(
      `/api/oi/heatmap?expiry=${encodeURIComponent(expiry)}&side=${side}&baseline=${baseline}&strikes=${strikes}`,
    ),
  storageStatus: () => request<StorageStatus>("/api/storage/status"),
  intradayReplaySessions: () => request<ReplaySessions>("/api/intraday/replay"),
  intradayReplay: (session: string, expiry: string, at: string) => request<ReplayResult>(`/api/intraday/replay?session=${session}&expiry=${expiry}&at=${encodeURIComponent(at)}`),
  intradayForward: (expiry: string) => request<ForwardCheck>(`/api/intraday/forward?expiry=${expiry}`),
  intradayPaper: () => request<PaperReport>("/api/intraday/paper"),
  intradaySummary: (expiry: string) => request<IntradaySummary>(`/api/intraday/summary?expiry=${encodeURIComponent(expiry)}`),
  intradayScores: (expiry: string) =>
    request<{ session: string; expiry: string; rows: IntradayScoreRow[] }>(`/api/intraday/scores?expiry=${encodeURIComponent(expiry)}`),
  flowsLatest: () => request<FlowsLatest>("/api/prediction/flows/latest?limit=30"),
  flowsCash: () => request<{ rows: { session: string; category: string; buy: number; sell: number; net: number }[]; window_sessions: number }>("/api/prediction/flows/cash"),
  importCash: (csv: string) => request<{ rows: number; added: number; removed_old: number; sessions_kept: number }>("/api/prediction/flows/cash/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv }) }),
  flowsStatus: () => request<FlowsStatus>("/api/prediction/flows/status"),
  flowsRefresh: () => request<FlowsStatus>("/api/prediction/flows/refresh", { method: "POST" }),
  historyStatus: () => request<HistoryFetchStatus>("/api/prediction/history/status"),
  historyRefresh: () => request<HistoryFetchStatus>("/api/prediction/history/refresh", { method: "POST" }),
  sampler: () => request<SamplerStatus>("/api/sampler/status"),
  history: (expiry: string, strikes: number) =>
    request<HistoryResponse>(`/api/history/observations?expiry=${encodeURIComponent(expiry)}&strikes=${strikes}`),
  swingReport: () => request<SwingReport>("/api/swing/report"),
  swingPaper: () => request<SwingPaperView>("/api/swing/paper"),
  swingLive: () => request<SwingLiveView>("/api/swing/live"),
  /** The straddle analysis of the latest stored session; with ``session`` and ``asOf`` (an ISO time with a zone) it is that session as it stood at that moment: a replay. */
  straddleDecay: (o: { session?: string; asOf?: string } = {}) =>
    request<import("./straddleDecay").StraddleDecay>(
      "/api/intelligence/straddle" + (o.session || o.asOf ? `?${[o.session ? `session=${encodeURIComponent(o.session)}` : "", o.asOf ? `as_of=${encodeURIComponent(o.asOf)}` : ""].filter(Boolean).join("&")}` : ""),
    ),
  straddleValidation: () => request<import("./straddleDecay").StraddleValidation>("/api/intelligence/straddle/validation"),
  intelligenceSummary: (expiry?: string) => request<import("./intelligence").Intelligence>(`/api/intelligence/summary${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ""}`),
  intelligenceTimeline: (session?: string) => request<import("./intelligence").Timeline>(`/api/intelligence/timeline${session ? `?session=${encodeURIComponent(session)}` : ""}`),
  swingMinute: () => request<import("./swingMinute").MinuteView>("/api/swing/minute"),
  swingRun: () => request<{ started: boolean; status: SwingPaperView["status"] }>("/api/swing/paper/run", { method: "POST" }),
  csvUrl: (id: string) => `/api/snapshots/${encodeURIComponent(id)}/csv`,
};
