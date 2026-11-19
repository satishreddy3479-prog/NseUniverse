import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryLab as Page } from "../pages/EntryLab";
import type { EntryLab, LabSummary } from "../lib/entryLab";

vi.mock("../components/EChart", () => ({ EChart: () => <div data-testid="chart" />, useChartColors: () => ({ up: "#0a0", down: "#a00", slate: "#111", rule: "#333", paper: "#eee", muted: "#999", info: "#0af", brass: "#fa0" }) }));

// The numbers are the real replays of 6, 17 and 19 Nov 2026 (fixed ATM straddle from 09:45 to 15:15, net of 2 points): -184.6, +17.0, -108.6 (see backend tests/unit/test_entry_lab.py).
const sum = (over: Partial<LabSummary> = {}): LabSummary => ({
  rule: "entry 09:45, exit 15:15", days: 3, skipped: 0, sufficient: false, min_days: 20, mean: -92.07, median: -108.6, win_pct: 33.3, worst: -184.6, best: 17, mean_max_adverse: 150.2, mean_restrikes: 0, total: -276.2, rupees_per_lot_total: -17953,
  mean_range95: [-184.6, 17], median_range95: [-184.6, 17], leave_one_out: { mean_min: -146.6, mean_max: -45.8, most_influential_day: "2026-11-06", swing: 100.8 },
  by_dte: { "expiry day": { days: 1, mean: 17, median: 17, win_pct: 100, worst: 17 }, "1-2 days": { days: 0 }, "3+ days": { days: 2, mean: -146.6, median: -146.6, win_pct: 0, worst: -184.6 } },
  message: "3 days replayed: a description of those days, not evidence of an edge (at least 20 days are needed before a number here is called a finding).", ...over,
});
const day = (d: string, dte: number, net: number) => ({ day: d, dte, skipped: null, strike: 25200, entry_premium: 300, entry_spot: 25200, gross: net + 2, net, max_adverse: 150, max_favourable: 20, restrikes: 0, exit_reason: "time" as const, exit_at: "15:15", spot_move: -120 });
const payload = (over: Partial<EntryLab> = {}): EntryLab => ({
  status: { days_total: 3, days_loaded: 3, loading: false, failed: {}, first: "2026-11-06", last: "2026-11-19" },
  rule: { label: "entry 09:45, exit 15:15", entry: "09:45", exit: "15:15", stop_pct: null, target_pct: null, roll_pts: null, cost: 2, roll_cost: 2 },
  summary: sum(),
  days: [day("2026-11-06", 3, -184.6), day("2026-11-17", 0, 17), day("2026-11-19", 4, -108.6), { day: "2026-11-18", dte: 5, skipped: "no price for the strike at the entry minute" }],
  presets: { entry_time: [sum({ value: "09:30" }), sum({ value: "09:45" })], re_strike: [sum({ value: null }), sum({ value: 100, mean: 9.9 })], stop: [sum({ value: null }), sum({ value: 20 })], variants_tried: 22, note: "The more variants are tried, the more likely one looks good by luck." },
  assumptions: ["A short ATM straddle booked from the stored last traded prices.", "Past days, in-sample: a description, not a forecast."], ...over,
});

const urls: string[] = [];
function mount(body: () => unknown, status = 200) {
  urls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return new Response(JSON.stringify(body()), { status, headers: { "content-type": "application/json" } }); }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><Page /></QueryClientProvider></MemoryRouter>);
}
afterEach(() => vi.unstubAllGlobals());

describe("the Entry Lab page", () => {
  it("shows the honesty line first, the summary with its ranges, the by-expiry split and every day including a skipped one", async () => {
    mount(() => payload());
    expect(await screen.findByTestId("lab-honesty")).toHaveTextContent("not evidence of an edge");
    const sm = screen.getByTestId("lab-summary");
    expect(within(sm).getByText("Median day").nextSibling?.textContent).toBe("−108.6");
    expect(within(sm).getByText("Worst day").nextSibling?.textContent).toBe("−185");
    expect(sm).toHaveTextContent("95% range −185 to +17");
    expect(sm).toHaveTextContent("₹17,953".replace("₹", "−₹"));
    expect(screen.getByTestId("lab-loo")).toHaveTextContent("the most influential day is 2026-11-06");
    expect(within(screen.getByTestId("lab-dte")).getByText("expiry day")).toBeTruthy();
    const days = screen.getByTestId("lab-days");
    expect(within(days).getByText("2026-11-17")).toBeTruthy();
    expect(days).toHaveTextContent("skipped: no price for the strike at the entry minute");
    expect(screen.getByTestId("lab-variants")).toHaveTextContent("22 variants are compared above");
    expect(screen.getByTestId("lab-assumptions")).toHaveTextContent("Past days, in-sample");
  });

  it("asks the server for the rule on screen and asks again when a control changes or a comparison row is clicked", async () => {
    mount(() => payload());
    await screen.findByTestId("lab-summary");
    expect(urls[0]).toContain("/api/intelligence/entry-lab?");
    expect(urls[0]).toContain("entry=09%3A45");
    expect(urls[0]).not.toContain("stop=");
    fireEvent.change(screen.getByLabelText("Stop (premium up)"), { target: { value: "20" } });
    await waitFor(() => expect(urls.some((u) => u.includes("stop=20"))).toBe(true));
    fireEvent.click(within(screen.getByTestId("lab-sweep-re-strike-distance")).getByText("100 pts away"));
    await waitFor(() => expect(urls.some((u) => u.includes("roll=100"))).toBe(true));
    fireEvent.click(within(screen.getByTestId("lab-sweep-entry-time")).getByText("09:30"));
    await waitFor(() => expect(urls.some((u) => u.includes("entry=09%3A30"))).toBe(true));
  });

  it("says how many recorded days have loaded, and that the numbers use the days loaded so far", async () => {
    mount(() => payload({ status: { days_total: 15, days_loaded: 3, loading: true, failed: {}, first: "2026-10-29", last: "2026-11-19" } }));
    expect(await screen.findByTestId("lab-loading-days")).toHaveTextContent("Loading the recorded days: 3 of 15");
    expect(screen.getByTestId("lab-summary")).toBeTruthy();
  });

  it("names a recorded day that could not be read instead of hiding it", async () => {
    mount(() => payload({ status: { days_total: 4, days_loaded: 3, loading: false, failed: { "2026-11-18": "too few stored minutes" }, first: "2026-11-06", last: "2026-11-19" } }));
    expect(await screen.findByTestId("lab-failed")).toHaveTextContent("2026-11-18 (too few stored minutes)");
  });

  it("has an empty state while nothing has loaded and one for a rule that traded no day", async () => {
    mount(() => payload({ summary: sum({ days: 0, message: "No day could be replayed with this rule." }), days: [], presets: undefined, status: { days_total: 15, days_loaded: 0, loading: true, failed: {}, first: null, last: null } }));
    expect(await screen.findByTestId("lab-empty")).toHaveTextContent("still loading");
  });

  it("shows the server's error instead of an empty page", async () => {
    mount(() => ({ detail: { code: "entry_lab_unavailable", message: "the Entry Lab is not running" } }), 503);
    expect(await screen.findByTestId("lab-error")).toBeTruthy();
  });
});
