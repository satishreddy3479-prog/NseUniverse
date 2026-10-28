import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import type { HistoryFetchStatus } from "../lib/types";
import { expiries, status, summary } from "./fixtures";

function hist(over: Partial<HistoryFetchStatus> = {}): HistoryFetchStatus {
  return {
    enabled: true, source: "Yahoo Finance via yfinance (unofficial, personal use)", running: false, progress: "",
    last_run: { run_id: "r1", started_at: "2026-10-28T13:30:00Z", finished_at: "2026-10-28T13:31:00Z",
      summary: { ok_symbols: 2, failed_symbols: [], empty_symbols: [], new_bars: 4800, disagreements: 0 } },
    symbols: [
      { key: "NIFTY50", yahoo: "^NSEI", name: "NIFTY 50", kind: "india_index", timing_verified: true, has_data: true, first: "2007-09-17", last: "2026-10-28", bars: 4700, disagreements: 0 },
      { key: "SPX", yahoo: "^GSPC", name: "S&P 500", kind: "global_index", timing_verified: false, has_data: false },
    ],
    ...over,
  };
}

function api(h: HistoryFetchStatus | null, posted: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0]!;
    if (url === "/api/prediction/history/status")
      return h ? new Response(JSON.stringify(h), { status: 200 }) : new Response("{}", { status: 404 });
    if (url === "/api/prediction/history/refresh" && init?.method === "POST") {
      posted.push(url);
      return new Response(JSON.stringify({ ...hist({ running: true, progress: "NIFTY50 (1/2)" }), started: true }), { status: 200 });
    }
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()] };
    return map[url] === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
}

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/settings"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());
const panel = () => screen.findByRole("region", { name: "Prediction data: daily price history" });

describe("prediction data panel", () => {
  it("shows what is stored per series and what is not", async () => {
    api(hist());
    renderSettings();
    const p = await panel();
    const t = await within(p).findByRole("table", { name: "Price history coverage" });
    expect(within(t).getByText("4,700")).toBeInTheDocument();
    expect(within(t).getByText("2007-09-17")).toBeInTheDocument();
    const spx = within(t).getByText("S&P 500").closest("tr")!;
    expect(within(spx).getAllByText("—").length).toBeGreaterThan(0); // no data: dashes, never zero
    expect(within(spx).getByText("Not yet")).toBeInTheDocument();
    expect(within(p).getByTestId("history-last-run")).toHaveTextContent("2 symbols OK, 4,800 new bars");
    expect(p.textContent).toMatch(/unofficial and for personal use/);
  });

  it("surfaces failures, empty series and bars that disagree with what is stored", async () => {
    api(hist({ last_run: { run_id: "r2", started_at: "2026-10-28T13:30:00Z", finished_at: null,
      summary: { ok_symbols: 1, failed_symbols: ["HSI"], empty_symbols: ["NIFTYIT"], new_bars: 10, disagreements: 3 } } }));
    renderSettings();
    const note = await within(await panel()).findByTestId("history-last-run");
    expect(note).toHaveTextContent("failed: HSI");
    expect(note).toHaveTextContent("no data: NIFTYIT");
    expect(note).toHaveTextContent("3 bars differ from what is stored (logged, not applied)");
  });

  it("Download now starts a run and disables itself while one is running", async () => {
    const posted: string[] = [];
    api(hist(), posted);
    renderSettings();
    const p = await panel();
    await userEvent.click(await within(p).findByRole("button", { name: "Download now" }));
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  it("is disabled and shows progress during a run", async () => {
    api(hist({ running: true, progress: "NIFTYBANK (3/25)" }));
    renderSettings();
    const p = await panel();
    expect(await within(p).findByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(p.textContent).toMatch(/Now: NIFTYBANK \(3\/25\)/);
  });

  it("explains an off switch and an older backend", async () => {
    api(hist({ enabled: false }));
    const first = renderSettings();
    expect(await within(await panel()).findByText(/Automatic updates are off/)).toBeInTheDocument();
    first.unmount();
    api(null);
    renderSettings();
    expect(await within(await panel()).findByText(/does not have the prediction module yet/)).toBeInTheDocument();
  });
});
