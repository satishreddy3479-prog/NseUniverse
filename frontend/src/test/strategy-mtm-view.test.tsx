// The MTM tab component with stored series served by a stubbed fetch: the numbers on screen are the hand sums of strategy-mtm.test.ts.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyMtm } from "../components/StrategyMtm";
import type { Leg } from "../lib/strategy";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: { series?: { name?: string; data: unknown[] }[] }; ariaLabel: string }) => <div role="img" aria-label={ariaLabel} data-series={JSON.stringify((option.series ?? []).map((s) => s.name))} data-points={JSON.stringify(option.series?.find((s) => s.name === "MTM")?.data ?? [])} />,
}));

const EXP = "2026-11-24";
const at = (hm: string) => `2026-11-20T${hm}:00.000Z`;
const times = [at("03:50"), at("03:51"), at("03:52"), at("03:53"), at("03:54")];
const STRIKES = { underlying: "NIFTY", expiry: EXP, strikes: [25800], atm_strike: 25800, times, spot: [], ce_price: { "25800": [100, 100, 105, 110, 95] }, pe_price: { "25800": [90, 90, 85, 80, 92] }, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {} };
const FUTS = { day: "2026-11-20", contract: "NIFTY26NOVFUT", expiry: EXP, times, future: [25800, 25800, 25790, 25770, 25810] };
const leg = (o: Partial<Leg>): Leg => ({ id: "x", expiry: EXP, strike: 25800, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", enteredAt: at("03:51"), ...o }) as Leg;
const legs = [leg({ id: "ce", enteredAt: at("03:50") }), leg({ id: "pe", type: "PE", premium: 90 }), leg({ id: "f", type: "FUT", strike: 0, action: "BUY", premium: 25800 })];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/history/strike-series") ? STRIKES : url.includes("/api/futures/series") ? FUTS : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function mount(ls: Leg[], hist = [EXP]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StrategyMtm legs={ls} historyExpiries={hist} lotSize={65} liveNow={900} /></QueryClientProvider>);
}

describe("MTM tab", () => {
  it("draws the strategy P&L from the stored series and states peak, trough and drawdown (hand sums 0, -650, -1950, +845)", async () => {
    mount(legs);
    const chart = await screen.findByRole("img", { name: "Strategy mark-to-market through time" });
    const pts = JSON.parse(chart.getAttribute("data-points")!) as [number, number][];
    // the stored samples, with one point at exactly zero added where the line crosses it between -1950 and +845 (at 1950 / 2795 of the way)
    expect(pts.map((p) => p[1])).toEqual([0, -650, -1950, 0, 845]);
    expect(pts[3]![0]).toBeCloseTo(pts[2]![0] + (1950 / 2795) * (pts[4]![0] - pts[2]![0]), 3);
    const opt = JSON.parse(chart.getAttribute("data-series") ?? "[]") as string[];
    expect(opt).toEqual(["above zero", "below zero", "line above zero", "line below zero", "MTM"]); // green and red areas, the line in two colours, the tooltip series
    const box = within(await screen.findByTestId("mtm"));
    expect(box.getByText("Now (stored)").nextElementSibling).toHaveTextContent("+₹845");
    expect(box.getByText("Live now").nextElementSibling).toHaveTextContent("+₹900"); // the builder's own value, shown beside the stored one
    expect(box.getByText("Peak").nextElementSibling).toHaveTextContent("+₹845 · 09:24");
    expect(box.getByText("Trough").nextElementSibling).toHaveTextContent("−₹1,950 · 09:23");
    expect(box.getByText("Max drawdown").nextElementSibling).toHaveTextContent("−₹1,950 · 09:21→09:23");
    expect(screen.getByTestId("mtm-note")).toHaveTextContent("The future is priced from the stored future series");
  });

  it("says so when the expiry's prices are not stored, and when a leg has no entry time", async () => {
    mount(legs, []);
    expect(await screen.findByTestId("mtm-nohistory")).toHaveTextContent(EXP);
  });
  it("a leg without an entry time explains why there is no line", async () => {
    mount([leg({ enteredAt: null })]);
    expect(await screen.findByTestId("mtm-reason")).toHaveTextContent("no recorded entry time");
  });
});
