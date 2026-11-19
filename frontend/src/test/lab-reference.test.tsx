import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabReferenceCard } from "../components/intelligence/LabReference";
import type { LabReference } from "../lib/entryLab";

// The 09:45 entry on the three real sessions of 6, 17 and 19 Nov 2026, net of 2 points: -184.6, +17.0, -75.85 (backend tests/unit/test_entry_lab.py).
const b = { days: 3, sufficient: false, min_days: 20, mean: -81.15, median: -75.85, win_pct: 33.3, worst: -184.6, best: 17, mean_range95: null, message: "" };
const ref = (over: Partial<LabReference> = {}): LabReference => ({
  entry: "09:45", exit: "15:15", lot: 65, status: { days_total: 3, days_loaded: 3, loading: false, failed: {}, first: "2026-11-06", last: "2026-11-19" }, caution: "A description of those days, not a forecast and not an edge.",
  plain: b, stop20: { ...b, mean: -20, median: -10, worst: -75 }, ...over,
});

function mount(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><LabReferenceCard /></QueryClientProvider></MemoryRouter>);
}
afterEach(() => vi.unstubAllGlobals());

describe("what the recorded days say", () => {
  it("shows the typical day and the worst day in points and rupees a lot, with the stop variant and the caution", async () => {
    mount(ref());
    expect(await screen.findByTestId("labref-lead")).toHaveTextContent("sold at 09:45 and held to 15:15, on the 3 recorded days");
    const plain = screen.getByTestId("labref-plain");
    expect(plain).toHaveTextContent("−75.8"); // the median (-75.85 shown to one place)
    expect(plain).toHaveTextContent("−185 (₹11,999 a lot)"); // 184.6 x 65 = 11,999
    expect(screen.getByTestId("labref-stop")).toHaveTextContent("−75 (₹4,875 a lot)");
    expect(screen.getByTestId("labref-caution")).toHaveTextContent("Only 3 days (at least 20 before this is a finding)");
    expect(screen.getByTestId("labref-caution")).toHaveTextContent("not a forecast and not an edge");
  });

  it("says the days are still loading, and shows an error instead of an empty card", async () => {
    const { unmount } = mount(ref({ plain: { ...b, days: 0 }, status: { days_total: 15, days_loaded: 4, loading: true, failed: {}, first: null, last: null } }));
    expect(await screen.findByTestId("labref-empty")).toHaveTextContent("Loading the recorded days (4 of 15)");
    unmount();
    mount({ detail: "x" }, 503);
    expect(await screen.findByTestId("labref-error")).toBeTruthy();
  });
});

describe("an answer that is not the reference", () => {
  it("shows the error state instead of crashing the page", async () => {
    mount({ status: "unavailable", message: "Fewer than two usable stored samples." });
    expect(await screen.findByTestId("labref-error")).toBeTruthy();
  });
});
