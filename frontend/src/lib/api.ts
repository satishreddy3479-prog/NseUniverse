import type {
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
  EventItem, FlowsLatest, StorageStatus, IntradayScoreRow, IntradaySummary, NewsStatus, FlowsStatus, HistoryFetchStatus, HistoryResponse, OiChange, OiHeatmap, OiSeries, PremiumDecay, PredictionSummary, SamplerStatus,
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

export const api = {
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
  oiSeries: (expiry: string, strikes: string, since?: string) =>
    request<OiSeries>(
      `/api/history/oi-series?expiry=${encodeURIComponent(expiry)}&strikes=${strikes}` + (since ? `&since=${encodeURIComponent(since)}` : ""),
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
  csvUrl: (id: string) => `/api/snapshots/${encodeURIComponent(id)}/csv`,
};
