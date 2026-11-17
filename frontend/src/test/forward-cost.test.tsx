import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { expiries, status, summary } from "./fixtures";

// jsdom has no canvas: the chart wrapper is replaced by a stub.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

// The 16 Nov 2026 position (call 92.95, put 107.30 sold at 10:25): the 30% put stop fired at 10:34 at 143.00, the call then closed at its cost at 12:10 at 103.50.
// Hand calculation: -3,006 with SL to cost (the call: (92.95 - 103.50) x 65 = -686; the put: (107.30 - 143.00) x 65 = -2,320; sum -3,006); the plain 30% stop kept the call to the close at 70.45: +1,462 - 2,320 = -858.
const trade = (net: number) => ({
  id: 1, session: "2026-11-16", cohort: "weekly", structure: "straddle", n: 1, expiry: "2026-11-17", trigger_at: "2026-11-16T04:55:00+00:00", settled_at: "2026-11-16T09:50:00+00:00", spot0: 25277, ce_strike: 25300, pe_strike: 25300,
  ce0: 92.95, pe0: 107.3, ce_exit: 103.5, pe_exit: 143, gross: net + 100, cost: 100, net, worst: -3200, reason: "stop, stop at cost", stopped_at: "10:34", regime: "volatility compression", seller: 64.3, buyer: 38.8, net_move: -26, ce_at: "12:10", pe_at: "10:34",
});
const plain = (variant: string, label: string, over: object = {}) => ({ variant, label, n: 4, wins: 1, win_rate: 25, total: -3432, avg: -858, best: 400, worst: -1200, max_drawdown: -3432, profit_factor: 0.2, stop_rate: 100, ...over });
const rule = (variant: string, label: string, twin: object, over: object = {}) => ({ variant, label, n: 4, wins: 1, win_rate: 25, total: -12024, avg: -3006, best: -100, worst: -3500, max_drawdown: -12024, profit_factor: 0, stop_rate: 100, twin, ...over });
const overview = (family: string, r: string, over: object = {}) => ({
  generated_at: new Date().toISOString(),
  today: { session: "2026-11-17", in_window: true, cap: 3, threshold: 60, rearm_minutes: 30, cohorts: [] },
  filters: { structure: "straddle", cohort: "all", rule: r, rule_label: r === "leg30_cost" ? "Stop 30% + SL to cost" : "Stop 40% + SL to cost", family },
  meta: { enabled: true, counts: { open: 1, settled: 4, days: 1 }, last_run: null, last_tick: "2026-11-17T04:30:00+00:00", last_error: null, bytes: 4096, min_trades: 20, setup: { trigger: "x", rearm: "y", entry_window: "09:30-14:30 IST", exit: "15:20 IST the same day", lot: 65 } },
  rules: [
    rule("leg30_cost", "Stop 30% + SL to cost", plain("leg30", "Leg stop 30%", { total: -3432 })),
    rule("leg40_cost", "Stop 40% + SL to cost", plain("leg40", "Leg stop 40%", { total: -2000 }), { total: -1000 }),
    rule("leg50_cost", "Stop 50% + SL to cost", plain("leg50", "Leg stop 50%", { n: 0 }), { n: 0 }),
  ],
  portfolio: [trade(-3006)],
  breakdown: { dimension: "regime", title: "Regime at entry", min_trades: 20, options: { regime: "Regime at entry" }, rows: [] },
  open: [{ id: 9, session: "2026-11-17", cohort: "weekly", expiry: "2026-11-17", structure: "straddle", n: 1, trigger_at: "2026-11-17T04:00:00+00:00", ce_strike: 25300, pe_strike: 25300, ce0: 74.4, pe0: 48.95, spot0: 25300, spot: 25490, seller: 76, regime: "volatility compression",
    variants: { [r]: { pnl: -300, ce_open: true, pe_open: false, stopped_at: "10:50", ce_exit: null, pe_exit: 68.55, ce_last: 80, pe_last: 70, ce_at: null, pe_at: "10:50" } } }],
  ...over,
});

let urls: string[];
function mockApi() {
  urls = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url, "http://x");
    const routes: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [] };
    const hit = u.pathname === "/api/forward/overview" ? overview(u.searchParams.get("family")!, u.searchParams.get("rule")!) : routes[u.pathname];
    return hit === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe("the Forward Test with SL to cost is a separate page", () => {
  it("is its own tool next to the plain one, and asks the server for the cost test", async () => {
    mockApi();
    renderAt("/tools/forward-test-cost");
    expect(await screen.findByText(/Paper portfolio with Move SL to cost/)).toBeInTheDocument();
    await vi.waitFor(() => expect(urls.some((u) => u.includes("family=cost") && u.includes("rule=leg40_cost"))).toBe(true));
    expect(screen.getByText(/A separate test from the plain stop-loss one/)).toBeInTheDocument();
    renderAt("/tools/forward-test");
    await vi.waitFor(() => expect(urls.some((u) => u.includes("family=plain") && u.includes("rule=hold"))).toBe(true));
  });

  it("offers only the six stops with SL to cost, starting on 40%, and says what is shown", async () => {
    mockApi();
    renderAt("/tools/forward-test-cost");
    const stops = within(await screen.findByRole("group", { name: "Stop loss" }));
    for (const n of ["Stop 30% + cost", "Stop 40% + cost", "Stop 50% + cost", "Stop 60% + cost", "Stop 70% + cost", "Stop 80% + cost"]) expect(stops.getByRole("button", { name: n })).toBeInTheDocument();
    expect(stops.queryByRole("button", { name: "No stop" })).toBeNull();
    expect(stops.queryByRole("button", { name: "Combined +15%" })).toBeNull();
    expect(stops.getByRole("button", { name: "Stop 40% + cost" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(stops.getByRole("button", { name: "Stop 30% + cost" }));
    await vi.waitFor(() => expect(screen.getByTestId("forward-selection")).toHaveTextContent("Showing: ATM straddle · weekly and monthly expiry · Stop 30% + SL to cost"));
    expect(urls.some((u) => u.includes("family=cost") && u.includes("rule=leg30_cost"))).toBe(true);
  });

  it("puts each rule next to the plain stop of the same percentage and shows what moving the stop to cost changed", async () => {
    mockApi();
    renderAt("/tools/forward-test-cost");
    const t = within(await screen.findByRole("table", { name: "Stop-loss rules compared" }));
    const row30 = t.getByRole("row", { name: "Show the portfolio of Stop 30% + SL to cost" });
    expect(row30).toHaveTextContent("−₹12,024"); // this rule's net
    expect(row30).toHaveTextContent("−₹3,432"); // the plain 30% stop on the same trades
    expect(row30).toHaveTextContent("−₹8,592"); // the difference: -12,024 - (-3,432)
    const row40 = t.getByRole("row", { name: "Show the portfolio of Stop 40% + SL to cost" });
    expect(row40).toHaveTextContent("+₹1,000"); // -1,000 against the plain -2,000: moving the stop to cost gained 1,000
    const row50 = t.getByRole("row", { name: "Show the portfolio of Stop 50% + SL to cost" });
    expect(row50).toHaveTextContent("—"); // no trades for this pair: a dash, not zero
    expect(screen.getByText(/put each rule next to the plain stop of the same percentage/)).toBeInTheDocument();
  });

  it("shows the trade with both exits and opens it in the builder with Move SL to cost on and each leg's own exit time", async () => {
    mockApi();
    renderAt("/tools/forward-test-cost");
    await userEvent.click(await screen.findByRole("button", { name: "Stop 30% + cost" })); // the 30% rule is the one this trade was stopped by
    await vi.waitFor(() => expect(screen.getByTestId("forward-selection")).toHaveTextContent("Stop 30% + SL to cost"));
    const log = within(await screen.findByRole("table", { name: "Closed trades" }));
    const row = log.getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("stop, stop at cost");
    expect(row).toHaveTextContent("CE 103.5 · PE 143.0");
    expect(row).toHaveTextContent("−₹3,006");
    await userEvent.click(row);
    const w = JSON.parse(sessionStorage.getItem("nse.builder.temp.v1")!);
    expect(w.moveToCost).toBe(true);
    expect(w.legs.map((l: { exitPrice: number; exitedAt: string; exitReason: string }) => [l.exitPrice, l.exitedAt, l.exitReason])).toEqual([[103.5, "2026-11-16T12:10:00+05:30", "stop"], [143, "2026-11-16T10:34:00+05:30", "stop"]]);
    expect(w.legs[0].stop).toBe(120.85); // 92.95 x 1.3 = 120.835 on the 30% rule, rounded to the 0.05 tick
  });
});
