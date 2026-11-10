import type {
  ForwardCheck,
  PaperReport,
  ReplayResult,
  ReplaySessions,
  ResearchReport,
  AppStatus,
  StreamStatus,
  ChainResponse,
  ConfigStatus,
  ErrorEvent,
  ExpirySelection,
  EventItem, FlowsLatest, StorageStatus, IntradayScoreRow, IntradaySummary, NewsStatus, FlowsStatus, HistoryFetchStatus, HistoryResponse, OiChange, OiHeatmap, OiSeries, StrikeSeries, FuturesSeries, HvReport, IvChart, IvSkew, IvSeries, IndexBars, PremiumDecay, PredictionSummary, SamplerStatus, SwingReport, SwingPaperView, SwingLiveView,
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
  legs?: import("./strategy").Leg[]; rules?: import("./strategy").StrategyRules; rstate?: import("./strategy").RulesState | null; rearmAt?: string | null; hold?: import("./strategy").HoldRule; holdFrom?: string | null; baseline?: import("./strategy").Leg[]; serverEvents?: { at: string; text: string }[];
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

export const api = {
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
  intradayIvSkew: (expiry: string) => request<IvSkew>(`/api/intraday/iv-skew?expiry=${encodeURIComponent(expiry)}`),
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
  predictionRecompute: (model: "T1" | "T5" | "all") => request<PredictionSummary>(`/api/prediction/summary/recompute?model=${model}`, { method: "POST" }),
  predictionSummary: () => request<PredictionSummary>("/api/prediction/summary"),
  intradayResearch: (horizon: number) => request<ResearchReport>(`/api/intraday/research?horizon=${horizon}`),
  intradayReplaySessions: () => request<ReplaySessions>("/api/intraday/replay"),
  intradayReplay: (session: string, expiry: string, at: string) => request<ReplayResult>(`/api/intraday/replay?session=${session}&expiry=${expiry}&at=${encodeURIComponent(at)}`),
  intradayForward: (expiry: string) => request<ForwardCheck>(`/api/intraday/forward?expiry=${expiry}`),
  intradayPaper: () => request<PaperReport>("/api/intraday/paper"),
  intradaySummary: (expiry: string) => request<IntradaySummary>(`/api/intraday/summary?expiry=${encodeURIComponent(expiry)}`),
  intradayScores: (expiry: string) =>
    request<{ session: string; expiry: string; rows: IntradayScoreRow[] }>(`/api/intraday/scores?expiry=${encodeURIComponent(expiry)}`),
  flowsLatest: () => request<FlowsLatest>("/api/prediction/flows/latest?limit=15"),
  events: () => request<{ events: EventItem[] }>("/api/prediction/events?days=45"),
  newsStatus: () => request<NewsStatus>("/api/prediction/news/status"),
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
  swingRun: () => request<{ started: boolean; status: SwingPaperView["status"] }>("/api/swing/paper/run", { method: "POST" }),
  csvUrl: (id: string) => `/api/snapshots/${encodeURIComponent(id)}/csv`,
};
