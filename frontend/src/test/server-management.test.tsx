// Server Management Centre pages: what is shown for missing data, comparisons, confirmation for risky operations and the request headers.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM } from "../components/TopNav";
import { rates } from "../components/servermgmt/ResourceTabs";
import { ServerManagement } from "../pages/ServerManagement";
import type { HistoryRow, MetricRow, Overview } from "../lib/serverApi";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

type Handler = (url: string, init?: RequestInit) => unknown | Response;
const calls: { url: string; init?: RequestInit }[] = [];
function mock(routes: Record<string, Handler>) {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => url.startsWith(k));
    if (!hit) return new Response(JSON.stringify({ detail: { code: "nf", message: "not found" } }), { status: 404 });
    const r = hit[1](url, init);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }));
}
const view = (tab: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/server?tab=${tab}`]}><ServerManagement /></MemoryRouter>
  </QueryClientProvider>,
);
afterEach(() => vi.unstubAllGlobals());

const NOW = "2026-11-06T06:00:00+00:00";
const snap = (over: object = {}) => ({ id: 1, snapshot_date: "2026-11-05", kind: "daily", ts_utc: NOW, status: "complete", method: "m", error: null, fs_total: 20e9, fs_used: 8e9, fs_avail: 12e9, nse_bytes: 3e9, nse_alloc: 3e9, files: 1000, dirs: 50, duration_s: 4.2, own_db_bytes: 1e5, ...over });
const overview = (over: Partial<Overview> = {}): Overview => ({
  now_utc: NOW, timezone: "Asia/Kolkata", host: { hostname: "box", os: "Ubuntu 24.04", kernel: "6.8", model: "vCPU", logical_cores: 1, uptime_s: 86400 * 3 },
  sample: { id: 1, ts_utc: NOW, status: "ok", error: null, cpu_pct: 12.5, load1: 0.2, load5: 0.3, load15: 0.4, mem_total: 1e9, mem_avail: 4e8, swap_total: 0, swap_used: 0, disk_total: 20e9, disk_used: 8e9, disk_avail: 12e9, net_rx: 1, net_tx: 1, io_read: 1, io_write: 1, app_rss: 2e8, collect_ms: 3 },
  sample_age_s: 60, stale: false, latest_snapshot: snap() as never, latest_parts: { project: 2e9, data: 1e9, logs: 5e6, "project/cache": 1e6, "project/releases": 9e8 },
  growth: { ...snap(), prev_date: "2026-11-04", comparable: true, d_fs_used: 5e6, d_nse_bytes: 4e6, d_files: 3, parts: {} } as never, history_started: "2026-11-01", scan_running: null,
  alerts: [], own_db_bytes: 1e5, areas: [], health: { ok: true, status: "ok", ms: 5, checked_utc: NOW }, thresholds: { disk_warn_pct: 80, disk_crit_pct: 90, ram_warn_pct: 85, ram_crit_pct: 92, cpu_warn_pct: 85 }, ...over,
});
const forecastNo = { available: false, reason: "needs 5 comparable daily observations, has 2", threshold_pct: 90, method: "avg", observations: 2 };

describe("navigation", () => {
  it("the System menu has Server Management Centre in place of Data clean-up", () => {
    expect(SYSTEM.find((x) => x.to === "/server")?.label).toBe("Server Management Centre");
    expect(SYSTEM.some((x) => x.label === "Data clean-up")).toBe(false);
  });
});

describe("Overview", () => {
  it("shows measured values with their collection time, and a dash (never 0) where a value is unavailable", async () => {
    const o = overview();
    o.sample = { ...o.sample!, cpu_pct: null, load1: null, status: "partial", error: "unavailable: load1" };
    mock({ "/api/server/overview": () => o, "/api/server/storage/forecast": () => forecastNo });
    view("overview");
    expect(await screen.findByTestId("sm-overview")).toBeInTheDocument();
    expect(screen.getByText(/Live sample/)).toBeInTheDocument();
    expect(screen.getByText("partial")).toBeInTheDocument();
    const cpu = screen.getByRole("region", { name: "CPU and load" });
    expect(within(cpu).getByText("CPU use").nextSibling).toHaveTextContent("—");
    expect(cpu.textContent).not.toMatch(/0\.0%/);
    expect(screen.getByRole("region", { name: "Memory" })).toHaveTextContent("60.0% of 1.00 GB"); // 1e9 total, 4e8 available
    expect(screen.getByTestId("sm-growth-cards")).toHaveTextContent("+5.0 MB");
    await waitFor(() => expect(screen.getByText(/Forecast unavailable: needs 5 comparable/)).toBeInTheDocument());
  });
  it("flags stale data and lists open alerts", async () => {
    mock({ "/api/server/overview": () => overview({ stale: true, sample_age_s: 3600, alerts: [{ id: 1, key: "disk", level: "critical", title: "Disk almost full", detail: "93% used", first_utc: NOW, last_utc: NOW, count: 3, resolved_utc: null }] }), "/api/server/storage/forecast": () => forecastNo });
    view("overview");
    expect(await screen.findByText("stale")).toBeInTheDocument();
    expect(screen.getByTestId("sm-open-alerts")).toHaveTextContent("Disk almost full");
    expect(screen.getByRole("button", { name: /Alerts/ })).toHaveTextContent("1");
  });
  it("says so when there is no sample or snapshot yet instead of showing zeros", async () => {
    mock({ "/api/server/overview": () => overview({ sample: null, sample_age_s: null, stale: true, latest_snapshot: null, latest_parts: {}, growth: null, history_started: null }), "/api/server/storage/forecast": () => forecastNo });
    view("overview");
    expect(await screen.findByText("No metric sample has been recorded yet.")).toBeInTheDocument();
    expect(screen.getByTestId("sm-storage-cards").textContent).not.toMatch(/\b0 B\b/);
    expect(screen.getAllByText(/no snapshot yet|none yet/).length).toBeGreaterThan(0);
  });
  it("shows an error state when the backend is unavailable", async () => {
    mock({ "/api/server/overview": () => new Response(JSON.stringify({ detail: { code: "unavailable", message: "the server-management module is not running" } }), { status: 503 }) });
    view("overview");
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});

describe("Storage analytics", () => {
  const row = (date: string, id: number, used: number | null, d: number | null, status = "complete"): HistoryRow => ({ ...snap({ id, snapshot_date: date, fs_used: used, status }), prev_date: null, comparable: d != null, d_fs_used: d, d_nse_bytes: d, d_files: null, parts: { project: 2e9, data: 1e9, logs: 5e6, "project/cache": 1e6, "project/releases": 9e8 } }) as unknown as HistoryRow;
  const history = (rows: HistoryRow[], extra: object = {}) => ({ rows, total: rows.length, page: 1, size: 20, missing_dates: [], first_date: rows[0]?.snapshot_date ?? null, note: rows.length ? "Historical data collection began on 2026-11-01. Earlier storage usage is unavailable." : "No storage snapshot has been recorded yet.", ...extra });
  it("explains an empty history instead of inventing rows", async () => {
    mock({ "/api/server/overview": () => overview(), "/api/server/storage/history": () => history([]), "/api/server/storage/forecast": () => forecastNo });
    view("storage");
    expect(await screen.findByTestId("sm-history-empty")).toHaveTextContent("No storage snapshot has been recorded yet.");
    expect(screen.getByTestId("sm-forecast-unavailable")).toHaveTextContent("needs 5 comparable");
  });
  it("lists days with unavailable change as a dash, flags missing dates and compares two chosen days", async () => {
    const rows = [row("2026-11-03", 3, 8.2e9, null), row("2026-11-02", 2, 8.1e9, 1e8), row("2026-11-01", 1, null, null, "failed")];
    mock({
      "/api/server/overview": () => overview(), "/api/server/storage/forecast": () => forecastNo,
      "/api/server/storage/history": () => history(rows, { missing_dates: ["2026-11-04"] }),
      "/api/server/storage/compare": () => ({ a: snap({ id: 2, snapshot_date: "2026-11-02" }), b: snap({ id: 3, snapshot_date: "2026-11-03" }), comparable: true, note: null,
        rows: [{ name: "project/cache", before: 1e6, after: 6e6, change: 5e6, change_pct: 500 }], growing: [], shrinking: [], files: [] }),
    });
    view("storage");
    const table = await screen.findByTestId("sm-history-table");
    expect(screen.getByTestId("sm-missing-dates")).toHaveTextContent("2026-11-04");
    const failedRow = within(table).getByText("2026-11-01").closest("tr")!;
    expect(failedRow).toHaveTextContent("failed");
    expect(failedRow.textContent).not.toMatch(/\b0 B\b/); // a failed day has no numbers, not zeros
    expect(within(table).getByText("2026-11-03").closest("tr")!.textContent).toContain("—"); // not comparable: unavailable
    fireEvent.click(screen.getByLabelText("Select 2026-11-02"));
    fireEvent.click(screen.getByLabelText("Select 2026-11-03"));
    fireEvent.click(screen.getByRole("button", { name: /Compare selected \(2\/2\)/ }));
    const cmp = await screen.findByTestId("sm-compare");
    expect(cmp).toHaveTextContent("project/cache");
    expect(cmp).toHaveTextContent("+500%");
    expect(calls.some((c) => c.url.includes("/storage/compare?a=2&b=3"))).toBe(true);
  });
  it("shows a forecast only when the backend produced one", async () => {
    mock({ "/api/server/overview": () => overview(), "/api/server/storage/history": () => history([row("2026-11-03", 3, 8e9, 1e8)]), "/api/server/storage/forecast": () => ({ available: true, threshold_pct: 90, method: "avg", observations: 8, avg_7d: 1e8, avg_30d: null, days_to_threshold: 72.5, projection: { "30": 11e9, "90": 17e9 } }) });
    view("storage");
    const f = await screen.findByTestId("sm-forecast");
    expect(f).toHaveTextContent("about 72.5");
    expect(f).toHaveTextContent("not enough days"); // the 30-day average is withheld, not shown as 0
  });
});

describe("Resources and processes", () => {
  it("turns cumulative counters into per-second rates and leaves a gap at a counter reset", () => {
    const m = (t: string, rx: number | null) => ({ ts_utc: t, net_rx: rx } as MetricRow);
    const out = rates([m("2026-11-06T06:00:00Z", 1000), m("2026-11-06T06:01:00Z", 7000), m("2026-11-06T06:02:00Z", 100), m("2026-11-06T06:03:00Z", null)], (r) => r.net_rx);
    expect(out).toEqual([null, 100, null, null]); // 6000 bytes in 60 s = 100/s; a reboot or a missing value is a gap
  });
  it("says why when process information is unavailable", async () => {
    mock({ "/api/server/processes": () => ({ available: false, reason: "process information is not readable on this host", rows: [] }) });
    view("processes");
    expect(await screen.findByTestId("sm-procs-unavailable")).toHaveTextContent("not readable");
  });
  it("shows too-few-samples text instead of an empty chart", async () => {
    mock({ "/api/server/metrics": () => ({ hours: 24, samples: 1, stride: 1, rows: [], note: "n" }), "/api/server/processes": () => ({ available: true, rows: [] }) });
    view("resources");
    expect(await screen.findByTestId("sm-resources-empty")).toHaveTextContent("Not enough samples");
  });
});

describe("Maintenance", () => {
  const ops = { operations: [
    { id: "scan_storage", title: "Scan storage now", target: "areas", effect: "Reads sizes", risk: "low", confirm: false, preview: false },
    { id: "retention_cleanup", title: "Monitoring retention cleanup", target: "own tables", effect: "Deletes old monitoring rows", risk: "medium", confirm: true, preview: true },
    { id: "restart_service", title: "Restart nse-universe", target: "service", effect: "Restarts the application", risk: "high", confirm: true, preview: false },
  ], retention_preview: { metric_samples: 12, runs: 0 }, helper: { installed: false, reason: "the privileged helper has not run on this server" }, last_restart: null };
  it("needs an explicit tick before a destructive operation can run, sends the action header, and shows the verification", async () => {
    mock({
      "/api/server/maintenance/run": (_u, init) => { const b = JSON.parse(String(init?.body)); return { id: 7, op: b.op, mode: b.dry_run ? "preview" : "execute", status: "ok", verification: b.dry_run ? "preview: {}" : "deleted: {\"metric_samples\":12}", at: NOW, result: {} }; },
      "/api/server/maintenance": () => ops, "/api/storage/cleanup": () => new Response("{}", { status: 404 }),
    });
    view("maintenance");
    const card = await screen.findByTestId("sm-op-retention_cleanup");
    expect(screen.getByTestId("sm-retention-preview")).toHaveTextContent("metric_samples 12");
    fireEvent.click(within(card).getByRole("button", { name: "Run…" }));
    const go = within(card).getByRole("button", { name: "Confirm and run" });
    expect(go).toBeDisabled();
    fireEvent.click(within(card).getByRole("checkbox"));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(await screen.findByTestId("sm-op-result-retention_cleanup")).toHaveTextContent("deleted");
    const post = calls.find((c) => c.url.endsWith("/maintenance/run"))!;
    expect((post.init?.headers as Record<string, string>)["X-NSE-Action"]).toBe("server-mgmt");
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ op: "retention_cleanup", confirm: true });
    expect(screen.getByTestId("sm-helper-missing")).toHaveTextContent("privileged helper");
  });
  it("a preview sends dry_run and changes nothing", async () => {
    mock({ "/api/server/maintenance/run": () => ({ id: 8, op: "retention_cleanup", mode: "preview", status: "ok", verification: "preview: {}", at: NOW, result: {} }), "/api/server/maintenance": () => ops, "/api/storage/cleanup": () => new Response("{}", { status: 404 }) });
    view("maintenance");
    const card = await screen.findByTestId("sm-op-retention_cleanup");
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    await screen.findByTestId("sm-op-result-retention_cleanup");
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/maintenance/run"))!.init?.body))).toMatchObject({ dry_run: true });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/maintenance/run"))!.init?.body)).confirm).toBeUndefined();
  });
  it("shows the server's refusal", async () => {
    mock({ "/api/server/maintenance/run": () => new Response(JSON.stringify({ detail: { code: "refused", message: "the privileged helper has not run on this server" } }), { status: 409 }), "/api/server/maintenance": () => ops, "/api/storage/cleanup": () => new Response("{}", { status: 404 }) });
    view("maintenance");
    const card = await screen.findByTestId("sm-op-scan_storage");
    fireEvent.click(within(card).getByRole("button", { name: "Run" }));
    expect((await within(card).findByRole("alert")).textContent).toContain("privileged helper");
  });
});

describe("Configuration and audit", () => {
  const conf = { values: { sample_interval_s: 300, disk_warn_pct: 80, excluded_dirs: [] }, schema: { sample_interval_s: { default: 300, min: 60, max: 3600, description: "Seconds between samples" }, disk_warn_pct: { default: 80, min: 50, max: 99, description: "Disk warning" } }, lists: { excluded_dirs: { default: [], max_items: 50 } } };
  it("sends only the changed values and shows a rejection from the server", async () => {
    mock({ "/api/server/config": (_u, init) => (init?.method === "PUT" ? new Response(JSON.stringify({ detail: { code: "bad_config", message: "disk_warn_pct must be below disk_crit_pct" } }), { status: 422 }) : conf) });
    view("config");
    const input = await screen.findByLabelText("Disk warning");
    fireEvent.change(input, { target: { value: "95" } }); // inside the field limits, but not below the critical threshold: only the server can tell
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("must be below disk_crit_pct");
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init?.body))).toEqual({ values: { disk_warn_pct: 95 } });
    expect((put.init?.headers as Record<string, string>)["X-NSE-Action"]).toBe("server-mgmt");
  });
  it("lists the audit history and says when it is empty", async () => {
    mock({ "/api/server/audit": () => ({ rows: [{ id: 1, ts_utc: NOW, actor: "operator", op: "scan_storage", target: "areas", mode: "execute", status: "ok", detail: null, verification: "snapshot 3 complete" }], total: 1 }) });
    view("audit");
    expect(await screen.findByTestId("sm-audit")).toHaveTextContent("snapshot 3 complete");
    vi.unstubAllGlobals();
    mock({ "/api/server/audit": () => ({ rows: [], total: 0 }) });
    view("audit");
    expect((await screen.findAllByText("No management action has been recorded yet.")).length).toBeGreaterThan(0);
  });
});

describe("Filesystem, logs, services and releases", () => {
  it("lists a folder and refuses nothing silently: an API error is shown", async () => {
    mock({ "/api/server/explorer": (u) => (u.includes("area=") ? { area: "project", path: "", entries: [{ name: "releases", path: "releases", kind: "dir", size: 9e8, files: 100, partial: false, mtime_utc: NOW, class: "kept data", protected: true }], truncated: false } : { areas: [{ id: "project", label: "Project root", exists: true }] }), "/api/server/history": () => ({}), "/api/server/storage/history": () => ({ rows: [], total: 0, page: 1, size: 5, missing_dates: [], first_date: null, note: "" }) });
    view("explorer");
    const t = await screen.findByTestId("sm-explorer-table");
    expect(t).toHaveTextContent("releases/");
    expect(t).toHaveTextContent("protected");
  });
  it("shows log lines newest first and a message when no log file exists", async () => {
    mock({ "/api/server/logs/sources": () => ({ sources: [] }) });
    view("logs");
    await waitFor(() => expect(screen.getByTestId("sm-logs-none")).toHaveTextContent("No log files were found"));
  });
  it("shows service state, an unavailable service with its reason, and the missing helper", async () => {
    mock({ "/api/server/services": () => ({ services: [{ name: "nse-universe", available: true, active: "active", sub: "running", manageable: true, restarts: 0, memory_bytes: 3e8, since: "Thu 2026-11-05" }, { name: "caddy", available: false, reason: "systemctl unavailable" }], helper: { installed: false, reason: "not installed" }, last_restart: null, health: { ok: true, status: "ok", ms: 4, checked_utc: NOW } }) });
    view("services");
    await screen.findByText("active / running");
    const t = screen.getByTestId("sm-services");
    expect(t).toHaveTextContent("active / running");
    expect(t).toHaveTextContent("unavailable: systemctl unavailable");
    expect(t).toHaveTextContent("not installed");
  });
  it("says there are no releases on a host without a releases directory", async () => {
    mock({ "/api/server/releases": () => ({ available: false, releases: [], active: null }) });
    view("releases");
    expect(await screen.findByTestId("sm-releases-none")).toBeInTheDocument();
  });
});
