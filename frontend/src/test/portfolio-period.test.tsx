// The Strategy portfolio period filter: overall, a year or a month by the IST date of closing. Records are synthetic and say so; sums are hand calculated.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Portfolio } from "../pages/Portfolio";
import { availablePeriods, filterClosed, istYearMonth, normalizePeriod, OVERALL, periodLabel } from "../lib/portfolioPeriod";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

// UTC instants and what the IST calendar says about them
const closed = [
  { id: "a", name: "A new-year close", closedAt: "2025-12-31T18:40:00Z", pnl: 100 }, // 1 Jan 2026 00:10 IST: 2026, not 2025
  { id: "b", name: "B october", closedAt: "2026-10-15T09:00:00Z", pnl: -50 },
  { id: "c", name: "C november", closedAt: "2026-11-10T09:00:00Z", pnl: 200 },
  { id: "d", name: "D month end", closedAt: "2026-11-30T18:20:00Z", pnl: 30 }, // 23:50 IST on 30 Nov: still November
  { id: "e", name: "E december", closedAt: "2026-11-30T18:40:00Z", pnl: 7 }, // 00:10 IST on 1 Dec: December, although it is 30 Nov in UTC
  { id: "f", name: "F older", closedAt: "2025-06-10T09:00:00Z", pnl: -10 },
];

describe("period selection", () => {
  it("uses the IST calendar date of closing", () => {
    expect(istYearMonth("2025-12-31T18:40:00Z")).toEqual({ y: 2026, m: 1 });
    expect(istYearMonth("2026-11-30T18:20:00Z")).toEqual({ y: 2026, m: 11 });
    expect(istYearMonth("2026-11-30T18:40:00Z")).toEqual({ y: 2026, m: 12 });
    expect(istYearMonth("garbage")).toBeNull();
  });
  it("lists the years and months that have data, newest first", () => {
    expect(availablePeriods(closed)).toEqual({ years: [2026, 2025], months: { 2026: [12, 11, 10, 1], 2025: [6] } });
  });
  it("filters by year and month, and overall keeps everything", () => {
    expect(filterClosed(closed, OVERALL)).toHaveLength(6);
    expect(filterClosed(closed, { mode: "year", year: 2026, month: null }).map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(filterClosed(closed, { mode: "month", year: 2026, month: 11 }).map((c) => c.id)).toEqual(["c", "d"]);
    expect(filterClosed(closed, { mode: "month", year: 2026, month: 12 }).map((c) => c.id)).toEqual(["e"]);
    expect(filterClosed(closed, { mode: "year", year: 2025, month: null }).map((c) => c.id)).toEqual(["f"]);
  });
  it("a period with no data falls back: a missing month to its year, a missing year to overall", () => {
    expect(normalizePeriod({ mode: "month", year: 2026, month: 3 }, closed)).toEqual({ mode: "year", year: 2026, month: null });
    expect(normalizePeriod({ mode: "year", year: 2019, month: null }, closed)).toEqual(OVERALL);
    expect(periodLabel({ mode: "month", year: 2026, month: 11 })).toBe("November 2026");
  });
});

function page() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.startsWith("/api/strategies")
      ? new Response(JSON.stringify({ saved: [], closed: closed.map((c) => ({ ...c, snapshotAt: c.closedAt, expiry: "2026-11-24", lotSize: 65, legs: [] })), running: null }), { status: 200 })
      : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Portfolio /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("Portfolio page period dropdown", () => {
  it("overall shows everything; a month shows only that month's closes, tile, statistics and list", async () => {
    page();
    const tiles = await screen.findByTestId("portfolio-tiles");
    // overall: 100 - 50 + 200 + 30 + 7 - 10 = 277 over 6 closes
    await waitFor(() => expect(tiles).toHaveTextContent("+₹277"));
    expect(tiles).toHaveTextContent("6 closed");
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "month" } });
    // newest month with data is December 2026: one close, +7
    await waitFor(() => expect(tiles).toHaveTextContent("1 closed in December 2026"));
    expect(tiles).toHaveTextContent("+₹7");
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "11" } });
    await waitFor(() => expect(tiles).toHaveTextContent("2 closed in November 2026"));
    expect(tiles).toHaveTextContent("+₹230"); // 200 + 30
    const list = screen.getByTestId("portfolio-closed");
    expect(within(list).getByText("C november")).toBeInTheDocument();
    expect(within(list).queryByText("B october")).toBeNull();
    expect(screen.getByRole("button", { name: /Delete all 2 closed in November 2026/ })).toBeInTheDocument();
    // the year view: 2026 holds five closes, 100 - 50 + 200 + 30 + 7 = 287
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "year" } });
    await waitFor(() => expect(tiles).toHaveTextContent("5 closed in 2026"));
    expect(tiles).toHaveTextContent("+₹287");
    expect(screen.getByTestId("portfolio-equity")).toBeInTheDocument();
  });
});
