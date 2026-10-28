import type {
  AppStatus,
  StreamStatus,
  ChainResponse,
  ConfigStatus,
  ErrorEvent,
  ExpirySelection,
  FlowsStatus, HistoryFetchStatus, HistoryResponse, OiChange, OiHeatmap, PredictionSummary, SamplerStatus,
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
  oiChange: (expiry: string, baseline: string, strikes: string, at?: string) =>
    request<OiChange>(
      `/api/oi/change?expiry=${encodeURIComponent(expiry)}&baseline=${baseline}&strikes=${strikes}` +
        (at ? `&at=${encodeURIComponent(at)}` : ""),
    ),
  oiHeatmap: (expiry: string, side: "CE" | "PE", baseline: string, strikes: string) =>
    request<OiHeatmap>(
      `/api/oi/heatmap?expiry=${encodeURIComponent(expiry)}&side=${side}&baseline=${baseline}&strikes=${strikes}`,
    ),
  predictionSummary: () => request<PredictionSummary>("/api/prediction/summary"),
  flowsStatus: () => request<FlowsStatus>("/api/prediction/flows/status"),
  flowsRefresh: () => request<FlowsStatus>("/api/prediction/flows/refresh", { method: "POST" }),
  historyStatus: () => request<HistoryFetchStatus>("/api/prediction/history/status"),
  historyRefresh: () => request<HistoryFetchStatus>("/api/prediction/history/refresh", { method: "POST" }),
  sampler: () => request<SamplerStatus>("/api/sampler/status"),
  history: (expiry: string, strikes: number) =>
    request<HistoryResponse>(`/api/history/observations?expiry=${encodeURIComponent(expiry)}&strikes=${strikes}`),
  csvUrl: (id: string) => `/api/snapshots/${encodeURIComponent(id)}/csv`,
};
