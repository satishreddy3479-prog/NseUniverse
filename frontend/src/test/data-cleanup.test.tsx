import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataCleanup } from "../pages/DataCleanup";

const overview = {
  disk: { free_bytes: 12e9, total_bytes: 19e9, free_gb: 12 }, pressure: "ok", data_bytes: 50e6, logs_bytes: 2e6, growth_bytes_per_day: 7.5e6, runway_days: 1600,
  stores: [{ file: "observations.sqlite3", name: "Option-chain observations", holds: "Samples and contract rows.", keep: "Kept forever.", bytes: 40e6, tables: { samples: 500, contracts: 120000 } }],
  files: [{ name: "Daily archive", holds: "One verified file per session.", keep: "Kept forever.", files: 3, bytes: 5e6 }],
  today: { date: "2026-10-30", samples: 135, contract_rows: 9000, contract_bytes_estimate: 300000, snapshot_files: 270, snapshot_bytes: 4e6, note: "Today's data stays until archived.",
    expiries: [{ expiry: "2026-11-03", samples: 135, unchanged: 5, first: "2026-10-30T03:45:00Z", last: "2026-10-30T06:00:00Z" }], intraday: { scores: 135, feature_rows: 120, summaries: 0 } },
  candidates: [
    { id: "raw_snapshots", label: "Raw broker responses older than 7 days", files: 40, bytes: 3e6, why_safe: "Archived.", blocked: 0, enabled: true },
    { id: "contract_rows", label: "Per-contract rows older than the last 2 sessions", files: 0, rows: 20000, bytes: 700000, why_safe: "Archive holds them.", blocked: 1, blocked_detail: [{ day: "2026-10-27", reason: "no verified archive" }], enabled: true },
    { id: "regenerable", label: "Exports older than 14 days and stray temporary files", files: 0, bytes: 0, why_safe: "Can be created again.", blocked: 0, enabled: true },
  ],
  removable_bytes: 3.7e6, never_deleted: [{ name: "Intraday feature rows", why: "training data" }], policy: { raw_days: 7, normalized_days: 14, contract_row_sessions: 2 }, last_runs: { snapshots: null },
};

let posted: unknown = null;
beforeEach(() => {
  posted = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/storage/cleanup" && init?.method === "POST") { posted = JSON.parse(String(init.body)); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); }
    if (url === "/api/storage/cleanup") return new Response(JSON.stringify(overview), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><DataCleanup /></MemoryRouter></QueryClientProvider>);

describe("Data clean-up page", () => {
  it("shows the disk, today's data, the stores and what could be removed, with measured sizes", async () => {
    mount();
    expect(await screen.findByTestId("cleanup-disk")).toHaveTextContent("12 GB free of 19 GB");
    expect(screen.getByTestId("cleanup-today")).toHaveTextContent("135");
    expect(screen.getByTestId("cleanup-today")).toHaveTextContent("120"); // intraday ML rows
    expect(screen.getByTestId("cleanup-stores")).toHaveTextContent("contracts: 1,20,000");
    const c = screen.getByTestId("cleanup-candidates");
    expect(c).toHaveTextContent("3.0 MB");
    expect(c).toHaveTextContent("20,000 rows");
    expect(c).toHaveTextContent("2026-10-27: no verified archive");
    expect(screen.getByLabelText("Select: Exports older than 14 days and stray temporary files")).toBeDisabled(); // nothing to remove
  });

  it("removes nothing until items are selected, reviewed and confirmed", async () => {
    mount();
    await screen.findByTestId("cleanup-candidates");
    expect(screen.getByRole("button", { name: /Review/ })).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Select: Raw broker responses older than 7 days"));
    await userEvent.click(screen.getByLabelText("Select: Per-contract rows older than the last 2 sessions"));
    await userEvent.click(screen.getByRole("button", { name: /Review 2 selected/ }));
    const review = screen.getByTestId("cleanup-review");
    expect(review).toHaveTextContent("about 3.7 MB");
    const remove = within(review).getByRole("button", { name: "Remove now" });
    expect(remove).toBeDisabled(); // needs the acknowledgement
    expect(posted).toBeNull();
    await userEvent.click(within(review).getByRole("checkbox"));
    await userEvent.click(remove);
    await waitFor(() => expect(posted).toEqual({ items: ["raw_snapshots", "contract_rows"], confirm: true }));
    expect(await screen.findByTestId("cleanup-done")).toBeInTheDocument();
  });
});
