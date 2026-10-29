import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoragePanel } from "../components/StoragePanel";
import type { StorageStatus } from "../lib/types";

const base: StorageStatus = {
  data_dir_bytes: 44_000_000, logs_bytes: 1_600_000,
  categories: [
    { name: "observations", class: "core", files: 3, bytes: 4_300_000, rule: "kept forever; checkpointed nightly, never pruned" },
    { name: "snapshots", class: "core", files: 194, bytes: 2_980_000, rule: "kept; pruning needs the owner's approval" },
    { name: "exports", class: "regenerable", files: 1, bytes: 9_300_000, rule: "removed after 14 days" },
    { name: "archive", class: "verified copy", files: 0, bytes: 0, rule: "kept" },
  ],
  disk: { free_bytes: 7_000_000_000, total_bytes: 15_000_000_000, free_gb: 7 },
  growth_bytes_per_day: 14_000_000, runway_days: 500, growth_note: "estimate", pressure: "ok",
  snapshot_pruning_plan: { executed: false, approved: false, older_than_days: 30, eligible_days: 2, files: 1500, bytes: 20_000_000, blocked: [] },
  end_of_day: {
    enabled: true, runs_after_ist: "15:45", backup_after_ist: "19:00", pending_days: ["2026-10-29"], sessions_archived: 3, complete_sessions: 2,
    last_attempt_at: "2026-10-28T10:30:00Z", last_result: { state: "ok" },
    last_backup: { day: "2026-10-28", ok: true, files: 7, removed: [], problems: [] }, last_tidy: null, backups_enabled: true,
    snapshot_retention: { raw_days: 0, normalized_days: 0, last_run: null },
  },
  daily_models: { when: "retrained on each new final daily bar, after 18:30 IST, off market hours", intraday_model: "not trained: needs 60 complete sessions" },
};

function mount(body: StorageStatus | null) {
  vi.stubGlobal("fetch", vi.fn(async () => body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 500 })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StoragePanel /></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("StoragePanel", () => {
  it("shows free space, categories with their rules, and the end-of-day state", async () => {
    mount(base);
    const p = await screen.findByTestId("storage-panel");
    expect(within(p).getByText("Disk ok")).toBeInTheDocument();
    expect(within(p).getByText(/7 GB free of 15 GB/)).toBeInTheDocument();
    expect(within(p).getByText("snapshots")).toBeInTheDocument();
    expect(within(p).queryByText("archive")).toBeNull(); // empty categories are hidden
    expect(within(p).getByText(/removed after 14 days/)).toBeInTheDocument();
    const eod = within(p).getByTestId("eod-status");
    expect(eod).toHaveTextContent("3 sessions archived · 2 complete · waiting: 2026-10-29");
    expect(eod).toHaveTextContent(/backup 2026-10-28 verified/);
  });

  it("says nothing is removed without approval and how much a limit would free", async () => {
    mount(base);
    expect(await screen.findByTestId("prune-note")).toHaveTextContent(/nothing is removed without your approval.*30-day limit, 1500 files/);
  });

  it("says when retention is on, and warns on a failed backup or a tight disk", async () => {
    mount({ ...base, pressure: "low", end_of_day: { ...base.end_of_day, last_backup: { ...base.end_of_day.last_backup!, ok: false }, snapshot_retention: { raw_days: 7, normalized_days: 30, last_run: null } } });
    expect(await screen.findByText("Disk low")).toBeInTheDocument();
    expect(screen.getByTestId("eod-status")).toHaveTextContent(/FAILED/);
    expect(screen.getByTestId("prune-note")).toHaveTextContent(/retention is on.*7 days.*30 days/);
  });

  it("reports an unavailable backend plainly", async () => {
    mount(null);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not available/);
  });
});
