import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionMonitor } from "../components/PositionMonitor";
import { place, polyline, type PositionMonitorData } from "../lib/positionMonitor";

// The server's account of a short 25850 straddle (one lot of 65) sold at 329.10 (CE 149.70 + PE 179.40) and now at 338.00, NIFTY 25,780. By hand:
//   P&L = 329.10 - 338.00 = -8.90 points = -8.9 x 65 = -₹578.5 -> -₹579;   loss against the entry premium = 8.9 / 329.1 = 2.7 %
//   time +9.2, volatility -3.1, NIFTY move -14.9, other -0.1: sum -8.9;   NIFTY cost / time income = 14.9 / 9.2 = 1.62 -> 1.6x
//   distance 25,780 - 25,850 = -70 points = 70 % of the 100-point re-strike
const data: PositionMonitorData = {
  available: true, live: true, as_of: "2026-11-27T07:40:00+00:00", limits: "Model estimates on last traded prices, before costs. The levels are provisional and not validated. Paper only.",
  name: "Managed straddle", expiry: "2026-12-01", lot_size: 65, mult: 1, since: "2026-11-27T05:30:00+00:00",
  legs: [{ label: "SELL 25850 CE", entry: 149.7, now: 155.2, delta: 0.43, iv_pct: 14.1 }, { label: "SELL 25850 PE", entry: 179.4, now: 182.8, delta: -0.57, iv_pct: 14.3 }],
  pnl: { points: -8.9, rupees: -579, booked_other_rupees: 0 },
  premium: { entry: 329.1, now: 338.0, loss_pct: 2.7, watch_pct: 15, stop_pct: 30, credit: true },
  delta: { net: 0.14, units: 9 },
  attribution: { theta: 9.2, vol: -3.1, spot: -14.9, other: -0.1, total: -8.9, ratio: 1.62, steps: 130 },
  distance: { spot: 25780, strike: 25850, points: -70, restrike_points: 100, share_of_restrike: 0.7, expected_move: 131.3, share_of_expected: 0.53, minutes_left: 125 },
  status: { level: "watch", text: "Watch: nifty is 70% of the way to the re-strike distance", reasons: ["NIFTY is 70% of the way to the re-strike distance.", "NIFTY's move has cost 1.6 times what time has paid."] },
  series: { t: ["2026-11-27T05:30:00+00:00", "2026-11-27T06:30:00+00:00", "2026-11-27T07:40:00+00:00"], theta: [0, 4.5, 9.2], vol: [0, -1, -3.1], spot: [0, -7, -14.9], total: [0, -3.5, -8.9] },
  events: [{ at: "2026-11-27T07:32:00+00:00", text: "NIFTY's move has cost more than time has paid." }, { at: "2026-11-27T05:30:00+00:00", text: "The monitor started following this position." }],
};
let answer: () => Response;
let calls: string[];

beforeEach(() => {
  calls = [];
  answer = () => new Response(JSON.stringify(data), { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return answer(); }));
});
afterEach(() => vi.unstubAllGlobals());
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PositionMonitor /></QueryClientProvider>);

describe("Position monitor", () => {
  it("shows the server's account: P&L, premium against entry, delta, cost against income, and where the P&L came from", async () => {
    mount();
    const m = await screen.findByTestId("position-monitor");
    expect(calls[0]).toBe("/api/strategies/running/monitor");
    expect(within(m).getByTestId("pm-pnl")).toHaveTextContent("−8.9 pts");
    expect(within(m).getByTestId("pm-pnl")).toHaveTextContent("−₹579 per lot");
    expect(within(m).getByTestId("pm-premium")).toHaveTextContent("+2.7%");
    expect(within(m).getByTestId("pm-premium")).toHaveTextContent("338.0 now, 329.1 sold");
    expect(within(m).getByTestId("pm-delta")).toHaveTextContent("+0.14");
    expect(within(m).getByTestId("pm-delta")).toHaveTextContent("gains if NIFTY rises");
    expect(within(m).getByTestId("pm-ratio")).toHaveTextContent("1.6×");
    expect(within(m).getByTestId("pm-ratio")).toHaveTextContent("14.9 paid, 9.2 earned");
    expect(within(m).getByTestId("pm-attr-theta")).toHaveTextContent("+9.2");
    expect(within(m).getByTestId("pm-attr-vol")).toHaveTextContent("−3.1");
    expect(within(m).getByTestId("pm-attr-spot")).toHaveTextContent("−14.9");
    expect(within(m).getByTestId("pm-attr-other")).toHaveTextContent("−0.1");
    expect(within(m).getByTestId("pm-attr-total")).toHaveTextContent("−8.9");
  });

  it("shows the status, its reasons, the distance gauge, the premium gauge, the chart and the log", async () => {
    mount();
    const m = await screen.findByTestId("position-monitor");
    expect(within(m).getByTestId("pm-status")).toHaveTextContent("Watch");
    expect(within(m).getByTestId("pm-reasons")).toHaveTextContent("70% of the way to the re-strike distance");
    const dist = within(m).getByTestId("pm-distance");
    expect(dist).toHaveTextContent("strike 25850"); expect(dist).toHaveTextContent("re-strike −100"); expect(dist).toHaveTextContent("re-strike +100"); expect(dist).toHaveTextContent("NIFTY 25780 (−70)");
    expect(dist).toHaveTextContent("70% of the way to the re-strike"); expect(dist).toHaveTextContent("125 minutes left");
    expect(within(m).getByTestId("pm-premium-gauge")).toHaveTextContent("sold 329.1");
    expect(within(m).getByTestId("pm-premium-gauge")).toHaveTextContent("now 338.0 (+2.7%)");
    expect(within(m).getByTestId("pm-premium-gauge")).toHaveTextContent("stop zone 30%");
    expect(within(m).getByTestId("pm-chart")).toBeInTheDocument();
    const events = within(m).getByTestId("pm-events");
    expect(events).toHaveTextContent("The monitor started following this position."); expect(events.textContent).toContain("13:02"); // 07:32 UTC
    expect(within(m).getByTestId("pm-limits")).toHaveTextContent("provisional and not validated");
  });

  it("says plainly that the figures are stale when the stream is not live", async () => {
    answer = () => new Response(JSON.stringify({ ...data, live: false }), { status: 200 });
    mount();
    expect(await screen.findByTestId("pm-notlive")).toHaveTextContent("last readings, not the market now");
  });

  it("explains why there is no reading instead of showing zeros", async () => {
    answer = () => new Response(JSON.stringify({ available: false, reason: "No open option leg in the running strategy.", as_of: data.as_of, limits: data.limits }), { status: 200 });
    mount();
    expect(await screen.findByTestId("pm-unavailable")).toHaveTextContent("No open option leg in the running strategy.");
    expect(screen.queryByTestId("position-monitor")).toBeNull();
  });

  it("names a failed request", async () => {
    answer = () => new Response(JSON.stringify({ detail: { code: "monitor_unavailable", message: "the position monitor is not running" } }), { status: 503 });
    mount();
    expect(await screen.findByTestId("pm-error")).toHaveTextContent("could not be loaded");
    await waitFor(() => expect(screen.queryByTestId("pm-premium")).toBeNull());
  });

  it("tells a held position that is not yet 15 minutes old that the ratio needs more readings", async () => {
    answer = () => new Response(JSON.stringify({ ...data, attribution: { ...data.attribution!, ratio: null, steps: 6 }, status: { level: "ok", text: "Within its limits", reasons: [] } }), { status: 200 });
    mount();
    expect(await screen.findByTestId("pm-ratio")).toHaveTextContent("needs 15 minutes of readings");
    expect(screen.getByTestId("pm-status")).toHaveTextContent("Within its limits");
    expect(screen.queryByTestId("pm-reasons")).toBeNull();
  });

  it("draws a position that is not a straddle without the distance gauge", async () => {
    answer = () => new Response(JSON.stringify({ ...data, distance: null }), { status: 200 });
    mount();
    await screen.findByTestId("position-monitor");
    expect(screen.queryByTestId("pm-distance")).toBeNull();
  });
});

describe("position monitor helpers", () => {
  it("places a value on a track and clamps it", () => {
    expect(place(0, -15, 45)).toBe(25); // 15 of 60
    expect(place(-30, -15, 45)).toBe(0);
    expect(place(99, -15, 45)).toBe(100);
    expect(place(5, 5, 5)).toBe(50);
  });
  it("scales a series into a box and skips missing values", () => {
    expect(polyline([0, 10, 5], 0, 10, 100, 50)).toBe("0,50 50,0 100,25");
    expect(polyline([0, null, 10], 0, 10, 100, 50)).toBe("0,50 100,0");
    expect(polyline([4], 0, 10, 100, 50)).toBe("0,30");
  });
});
