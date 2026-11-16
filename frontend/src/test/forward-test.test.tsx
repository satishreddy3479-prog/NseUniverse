import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { expiries, status, summary } from "./fixtures";

// jsdom has no canvas: the chart wrapper is replaced by a stub that exposes the series it was given.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string; data: number[] }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((x) => x.name).join("|")} data-last={(o.series ?? []).map((x) => x.data[x.data.length - 1]).join(",")} />;
  },
}));

// The shape the backend returns (see backend/tests/unit/test_forward.py); the numbers are the hand-calculated results of 16 Nov 2026 for the first position.
const LABELS: Record<string, string> = { hold: "No stop (hold to 15:20)", leg30: "Leg stop 30%", leg40: "Leg stop 40%" };
const variant = (id: string, over: object = {}) => ({ variant: id, label: LABELS[id]!, n: 2, wins: 1, win_rate: 50, total: 741, avg: 370, best: 1500, worst: -760, max_drawdown: -760, profit_factor: 1.9, avg_intraday_worst: -900, stop_rate: 50, ...over });
const cell = (avg: number | null, n = 2) => ({ n, avg, win_rate: avg == null ? null : avg > 0 ? 100 : 0, total: (avg ?? 0) * n });
const overview = (over: object = {}) => ({
  generated_at: new Date().toISOString(), filters: { structure: "all", cohort: "all" },
  meta: { enabled: true, counts: { open: 1, settled: 2, days: 1 }, last_run: null, last_tick: "2026-11-16T08:10:00+00:00", last_error: null, bytes: 4096, min_trades: 20, rules: { trigger: "seller score of the expiry reaches 60", rearm: "x", entry_window: "09:30-14:30 IST", exit: "15:20 IST the same day", lot: 65 } },
  variants: [variant("hold", { total: 1599, avg: 799.5, win_rate: 100, worst: 700, max_drawdown: 0, stop_rate: 0 }), variant("leg30", { total: -858, avg: -429, win_rate: 0 }), variant("leg40", { n: 25 })],
  equity: { times: ["2026-11-16T04:42:00+00:00", "2026-11-16T05:30:00+00:00"], curves: { hold: [900, 1599], leg30: [-100, -858], leg40: [0, -1745] } },
  breakdown: {
    dimension: "regime", title: "Regime at entry", min_trades: 20, options: { regime: "Regime at entry", time: "Time of entry (IST)", flow: "Futures order flow" },
    rows: [{ bucket: "volatility compression", n: 2, cells: { hold: cell(799.5), leg30: cell(-429), leg40: cell(null, 0) } }, { bucket: "volatility expansion", n: 30, cells: { hold: cell(-200, 30), leg30: cell(-500, 3), leg40: cell(-100, 30) } }],
  },
  open: [{ id: 9, session: "2026-11-16", cohort: "weekly", expiry: "2026-11-17", structure: "strangle", n: 2, trigger_at: "2026-11-16T07:30:00+00:00", ce_strike: 25350, pe_strike: 25250, ce0: 60.5, pe0: 71, spot0: 25300, spot: 25290, seller: 63.4, regime: "no clear regime", variants: { hold: { pnl: 520, ce_open: true, pe_open: true, stopped_at: null }, leg30: { pnl: -300, ce_open: true, pe_open: false, stopped_at: "13:01" } } }],
  trades: [{ id: 1, session: "2026-11-16", cohort: "weekly", expiry: "2026-11-17", structure: "straddle", n: 1, trigger_at: "2026-11-16T04:42:00+00:00", spot0: 25277, ce_strike: 25300, pe_strike: 25300, ce0: 92.95, pe0: 107.3, seller: 64.3, buyer: 38.8, regime: "volatility compression", eod: { net_move_pts: -26 }, nets: { hold: 1599, leg30: -858 }, best: { variant: "hold", net: 1599 }, worst: { variant: "leg30", net: -858 } }],
  ...over,
});

let payload: unknown;
function mockApi() {
  const urls: string[] = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const routes: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [], "/api/forward/overview": payload };
    const hit = routes[url.split("?")[0]!];
    return hit === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return urls;
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("forward test page", () => {
  it("explains the rules, shows the counts, the exit-rule scorecard and flags a row with too few positions", async () => {
    payload = overview();
    mockApi();
    renderAt("/tools/forward-test");
    expect(await screen.findByText("Paper test, nothing is sent to a broker")).toBeInTheDocument();
    expect(screen.getByText(/2 settled · 1 open · 1 days · last check 13:40 IST/)).toBeInTheDocument();
    const card = within(screen.getByRole("region", { name: "Exit rules compared" }));
    const rows = card.getAllByRole("row");
    const hold = rows.find((r) => within(r).queryByText("No stop (hold to 15:20)"))!;
    expect(within(hold).getByText("+₹1,599")).toBeInTheDocument();
    expect(within(hold).getByText("100%")).toBeInTheDocument();
    expect(within(hold).getByText("too few")).toBeInTheDocument(); // 2 positions
    const leg40 = rows.find((r) => within(r).queryByText("Leg stop 40%"))!;
    expect(within(leg40).queryByText("too few")).toBeNull(); // 25 positions
    expect(screen.getByRole("status")).toHaveTextContent(/Only 2 settled positions/);
    const chart = screen.getByRole("img", { name: /Cumulative net profit and loss of each exit rule/ });
    expect(chart).toHaveAttribute("data-series", "No stop (hold to 15:20)|Leg stop 30%|Leg stop 40%");
    expect(chart).toHaveAttribute("data-last", "1599,-858,-1745");
  });

  it("shows the open positions with their marks and the recent settled positions", async () => {
    payload = overview();
    mockApi();
    renderAt("/tools/forward-test");
    const open = within(await screen.findByRole("region", { name: "Open now" }));
    expect(open.getByText(/strangle · weekly · #2/)).toBeInTheDocument();
    expect(open.getByText(/Sold 25350 CE \+ 25250 PE at 60.5 \+ 71 = 131.50/)).toBeInTheDocument();
    expect(open.getByText("+₹520")).toBeInTheDocument();
    expect(open.getByText("✕ −₹300")).toBeInTheDocument(); // a stopped leg is marked
    const recent = within(screen.getByRole("region", { name: "Recent positions" }));
    expect(recent.getByText("25300")).toBeInTheDocument();
    expect(recent.getByText("+₹1,599")).toBeInTheDocument();
    expect(recent.getByText(/hold \+₹1,599/)).toBeInTheDocument();
  });

  it("the filters and the breakdown choice ask the server for that view, and the heat table keeps missing cells missing", async () => {
    payload = overview();
    const urls = mockApi();
    renderAt("/tools/forward-test");
    await screen.findByText("Paper test, nothing is sent to a broker");
    await userEvent.click(screen.getByRole("button", { name: "Strangle ±50" }));
    await userEvent.click(screen.getByRole("button", { name: "Monthly" }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes("structure=strangle&cohort=monthly&dim=regime"))).toBe(true));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Break down by" }), "flow");
    await vi.waitFor(() => expect(urls.some((u) => u.includes("structure=strangle&cohort=monthly&dim=flow"))).toBe(true));
    const heat = within(screen.getByRole("region", { name: "By market regime and other conditions" }));
    const compression = heat.getByText("volatility compression").closest("tr")!;
    expect(within(compression).getByText("+₹800")).toBeInTheDocument();
    expect(within(compression).getByText("—")).toBeInTheDocument(); // leg 40 has no position in this bucket: a dash, not zero
    expect(within(heat.getByText("volatility expansion").closest("tr")!).getByText(/30 positions/)).toBeInTheDocument();
    expect(within(compression).getByText(/too few/)).toBeInTheDocument();
  });

  it("says what will happen when nothing has settled yet", async () => {
    payload = overview({ variants: [variant("hold", { n: 0 })], equity: { times: [], curves: { hold: [] } }, breakdown: { dimension: "regime", title: "Regime at entry", min_trades: 20, options: { regime: "Regime at entry" }, rows: [] }, open: [], trades: [], meta: { ...overview().meta, counts: { open: 0, settled: 0, days: 0 }, last_tick: null } });
    mockApi();
    renderAt("/tools/forward-test");
    expect(await screen.findByText(/No open position. One opens the first time the seller score/)).toBeInTheDocument();
    expect(screen.getByText("No settled position yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing to break down yet.")).toBeInTheDocument();
    expect(screen.getByText(/last check not yet/)).toBeInTheDocument();
  });
});
