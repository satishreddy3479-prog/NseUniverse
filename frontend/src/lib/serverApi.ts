// Server Management Centre client. Reads are plain GETs; every change sends the X-NSE-Action header the backend requires.

export class ServerApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" }, ...init });
  } catch {
    throw new ServerApiError(0, "network", "Backend unreachable.");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { detail?: { code?: string; message?: string } };
      if (b.detail?.code) code = b.detail.code;
      if (b.detail?.message) message = b.detail.message;
    } catch { /* non-JSON error body */ }
    throw new ServerApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}
const post = <T,>(path: string, body: unknown, method = "POST") =>
  call<T>(path, { method, headers: { Accept: "application/json", "Content-Type": "application/json", "X-NSE-Action": "server-mgmt" }, body: JSON.stringify(body) });
const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};

export interface MetricRow {
  id: number; ts_utc: string; status: "ok" | "partial" | "failed"; error: string | null;
  cpu_pct: number | null; load1: number | null; load5: number | null; load15: number | null;
  mem_total: number | null; mem_avail: number | null; swap_total: number | null; swap_used: number | null;
  disk_total: number | null; disk_used: number | null; disk_avail: number | null;
  net_rx: number | null; net_tx: number | null; io_read: number | null; io_write: number | null; app_rss: number | null; collect_ms: number | null;
}
export interface Snapshot {
  id: number; snapshot_date: string; kind: string; ts_utc: string; status: "complete" | "partial" | "failed"; method: string; error: string | null;
  fs_total: number | null; fs_used: number | null; fs_avail: number | null; nse_bytes: number | null; nse_alloc: number | null;
  files: number | null; dirs: number | null; duration_s: number | null; own_db_bytes: number | null;
}
export interface HistoryRow extends Snapshot {
  prev_date: string | null; comparable: boolean; d_fs_used: number | null; d_nse_bytes: number | null; d_files: number | null; parts: Record<string, number>;
}
export interface AlertRow { id: number; key: string; level: "warning" | "critical"; title: string; detail: string | null; first_utc: string; last_utc: string; count: number; resolved_utc: string | null }
export interface Overview {
  now_utc: string; timezone: string;
  host: { hostname: string | null; os: string | null; kernel: string | null; model: string | null; logical_cores: number | null; uptime_s: number | null };
  sample: MetricRow | null; sample_age_s: number | null; stale: boolean; latest_snapshot: Snapshot | null; latest_parts: Record<string, number>;
  growth: HistoryRow | null; history_started: string | null; scan_running: string | null; alerts: AlertRow[]; own_db_bytes: number;
  areas: { id: string; label: string; root: string; exists: boolean }[];
  health: { ok: boolean; status: string; ms: number | null; checked_utc: string; error?: string } | null; thresholds: Record<string, number>;
}
export interface Forecast {
  available: boolean; reason?: string | null; threshold_pct: number; method: string; observations: number; avg_7d?: number | null; avg_30d?: number | null;
  days_to_threshold?: number; projection?: Record<string, number>; since?: string; as_of?: string; fs_used?: number; fs_total?: number; volatile?: boolean;
}
export interface CompareResult {
  a: Snapshot; b: Snapshot; comparable: boolean; note: string | null;
  rows: { name: string; before: number | null; after: number | null; change: number | null; change_pct: number | null }[];
  growing: { name: string; change: number }[]; shrinking: { name: string; change: number }[];
  files: { area: string; path: string; before: number | null; after: number | null; change: number | null; cls: string; protected: boolean; note: string | null }[];
}
export interface ExplorerEntry { name: string; path: string; kind: "dir" | "file" | "link"; size: number | null; files: number | null; partial: boolean; mtime_utc: string; class: string; protected: boolean }
export interface ProcRow { pid: number; name: string; uid: number; state: string; rss: number; cpu_seconds: number; runtime_s: number | null; cpu_pct_lifetime: number | null; mem_pct: number | null }
export interface LogRow { raw: string; ts: string | null; level: string | null; logger: string | null; msg: string | null }
export interface ServiceRow { name: string; available: boolean; reason?: string; active?: string; sub?: string; pid?: number | null; since?: string | null; restarts?: number | null; memory_bytes?: number | null; result?: string; manageable?: boolean }
export interface OpSpec { id: string; title: string; target: string; effect: string; risk: "low" | "medium" | "high"; confirm: boolean; preview: boolean }
export interface AuditRow { id: number; ts_utc: string; actor: string; op: string; target: string | null; mode: string; status: string; detail: string | null; verification: string | null }
export interface ConfigResponse {
  values: Record<string, number | string[]>;
  schema: Record<string, { default: number; min: number; max: number; description: string }>;
  lists: Record<string, { default: string[]; max_items: number }>;
}

export const serverApi = {
  overview: () => call<Overview>("/api/server/overview"),
  metrics: (hours: number) => call<{ hours: number; samples: number; stride: number; rows: MetricRow[]; note: string }>(`/api/server/metrics${qs({ hours })}`),
  processes: (o: { sort?: string; limit?: number; q?: string }) => call<{ available: boolean; reason?: string; rows: ProcRow[]; total?: number; note?: string; mem_total?: number | null }>(`/api/server/processes${qs(o)}`),
  history: (o: { date_from?: string; date_to?: string; q?: string; sort?: string; page?: number; size?: number }) =>
    call<{ rows: HistoryRow[]; total: number; page: number; size: number; missing_dates: string[]; first_date: string | null; note: string }>(`/api/server/storage/history${qs(o)}`),
  snapshot: (id: number) => call<{ snapshot: Snapshot; dirs: { area: string; name: string; bytes: number; alloc: number; files: number }[]; files: { area: string; rel_path: string; size: number; mtime_utc: string | null; cls: string; protected: number }[] }>(`/api/server/storage/snapshot/${id}`),
  compare: (a: number, b: number) => call<CompareResult>(`/api/server/storage/compare${qs({ a, b })}`),
  forecast: () => call<Forecast>("/api/server/storage/forecast"),
  explorer: (area?: string, path?: string) => call<{ areas?: { id: string; label: string; exists: boolean }[]; area?: string; path?: string; entries?: ExplorerEntry[]; truncated?: boolean }>(`/api/server/explorer${qs({ area, path })}`),
  logSources: () => call<{ sources: { name: string; bytes: number; mtime_utc: string; rotated: boolean }[] }>("/api/server/logs/sources"),
  logs: (o: { source: string; q?: string; level?: string; limit?: number; before?: number | null }) =>
    call<{ source: string; rows: LogRow[]; file_bytes: number; next_before: number | null; truncated_window: boolean }>(`/api/server/logs${qs(o)}`),
  services: () => call<{ services: ServiceRow[]; helper: { installed: boolean; reason?: string; last_run_age_s?: number; stale?: boolean }; last_restart: Record<string, unknown> | null; health: Overview["health"] }>("/api/server/services"),
  jobs: () => call<{ collector_runs: { id: number; kind: string; started_utc: string; finished_utc: string | null; status: string; detail: string | null }[]; daily_prices: Record<string, unknown> | null; schedule: { metrics_every_s: number; daily_snapshot_ist: string } }>("/api/server/jobs"),
  releases: () => call<{ available: boolean; active: string | null; releases: { id: string; created_utc: string; active: boolean; bytes: number | null }[]; rollback?: string; health?: Overview["health"] }>("/api/server/releases"),
  cache: () => call<{ items: { name: string; class: string; files: number; bytes: number; rule: string; cleanable: boolean; where: string }[]; note: string }>("/api/server/cache"),
  alerts: (includeResolved: boolean) => call<{ alerts: AlertRow[] }>(`/api/server/alerts${qs({ include_resolved: includeResolved })}`),
  audit: (limit: number, offset: number) => call<{ rows: AuditRow[]; total: number }>(`/api/server/audit${qs({ limit, offset })}`),
  config: () => call<ConfigResponse>("/api/server/config"),
  saveConfig: (values: Record<string, unknown>) => post<{ values: Record<string, unknown> }>("/api/server/config", { values }, "PUT"),
  maintenance: () => call<{ operations: OpSpec[]; retention_preview: Record<string, number>; helper: { installed: boolean; reason?: string }; last_restart: Record<string, unknown> | null }>("/api/server/maintenance"),
  run: (op: string, o: { dry_run?: boolean; confirm?: boolean; service?: string } = {}) =>
    post<{ id: number; op: string; mode: string; status: string; verification: string | null; at: string; result: unknown }>("/api/server/maintenance/run", { op, ...o }),
};
