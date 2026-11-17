import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { cohortStatus } from "../components/ForwardTest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { expiries, status, summary } from "./fixtures";

// jsdom has no canvas: the chart wrapper is replaced by a stub that exposes what it was given.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string; data: (number | null)[] }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((x) => x.name).join("|")} data-first={(o.series ?? [])[0]?.data.join(",")} />;
  },
}));

// Six closed trades of one rule (net P&L in rupees, oldest first): +1500, -400, +800, -900, -300, +200. Hand calculation:
//   wins 1500 + 800 + 200 = 2500 (3), losses -400 - 900 - 300 = -1600 (3), net +900, win rate 50 %, loss rate 50 %, profit factor 2500 / 1600 = 1.56, expectancy 150
//   cumulative 1500, 1100, 1900, 1000, 700, 900: peak 1900, max drawdown 1900 - 700 = 1200, current drawdown 1900 - 900 = 1000
//   streaks in order + - + - - +: longest win 1, longest loss 2, now a win; highest win 1500, lowest win 200, highest loss -900, smallest loss -300
//   stops fired on trades 2, 4, 5 = 50 %; the deepest dip of each trade -100, -700, -200, -1000, -500, -50 averages -425
const NETS = [1500, -400, 800, -900, -300, 200];
const DIPS = [-100, -700, -200, -1000, -500, -50];
const STOPPED = [false, true, false, true, true, false];
const trade = (i: number) => ({
  id: i + 1, session: `2026-11-1${i}`, cohort: i % 2 ? "monthly" : "weekly", structure: "straddle", n: 1, expiry: i % 2 ? "2026-11-24" : "2026-11-17", trigger_at: `2026-11-1${i}T05:00:00+00:00`,
  settled_at: `2026-11-1${i}T09:50:00+00:00`, spot0: 25250, ce_strike: 25250, pe_strike: 25250, ce0: 90, pe0: 85, ce_exit: 60.5, pe_exit: 70, gross: NETS[i]! + 100, cost: 100, net: NETS[i]!, worst: DIPS[i]!,
  reason: STOPPED[i] ? "stop" : "close 15:20", stopped_at: STOPPED[i] ? "10:46" : null, regime: "volatility compression", seller: 64.3, buyer: 38.8, net_move: -26,
});
const rule = (variant: string, label: string, over: object = {}) => ({ variant, label, n: 6, wins: 3, win_rate: 50, total: 900, avg: 150, best: 1500, worst: -900, max_drawdown: -1200, profit_factor: 1.56, avg_intraday_worst: -425, stop_rate: 50, ...over });
const overview = (over: object = {}, filters: object = {}) => ({
  generated_at: new Date().toISOString(),
  today: { session: "2026-11-17", in_window: true, cap: 3, threshold: 60, rearm_minutes: 30, cohorts: [
    { cohort: "weekly", expiry: "2026-11-17", seller: 78.2, score_at: "2026-11-17T04:37:00+00:00", count: 1, armed: false, below_since: null, opened: ["2026-11-17T04:00:00+00:00"] },
    { cohort: "monthly", expiry: "2026-11-24", seller: 55, score_at: "2026-11-17T04:37:00+00:00", count: 1, armed: false, below_since: "2026-11-17T04:30:00+00:00", opened: ["2026-11-17T04:27:00+00:00"] },
  ] },
  filters: { structure: "straddle", cohort: "all", rule: "hold", rule_label: "No stop (hold to 15:20)", ...filters },
  meta: { enabled: true, counts: { open: 1, settled: 6, days: 6 }, last_run: null, last_tick: "2026-11-16T08:10:00+00:00", last_error: null, bytes: 4096, min_trades: 20, setup: { trigger: "x", rearm: "y", entry_window: "09:30-14:30 IST", exit: "15:20 IST the same day", lot: 65 } },
  rules: [rule("hold", "No stop (hold to 15:20)"), rule("leg40", "Leg stop 40%", { total: -2000, avg: -333, win_rate: 33.3, max_drawdown: -2500 })],
  portfolio: NETS.map((_, i) => trade(i)),
  breakdown: { dimension: "regime", title: "Regime at entry", min_trades: 20, options: { regime: "Regime at entry", time: "Time of entry (IST)" }, rows: [{ bucket: "volatility compression", n: 6, win_rate: 50, avg: 150, total: 900, worst: -900, stop_rate: 50 }] },
  open: [{ id: 9, session: "2026-11-16", cohort: "weekly", expiry: "2026-11-17", structure: "straddle", n: 2, trigger_at: "2026-11-16T07:30:00+00:00", ce_strike: 25300, pe_strike: 25300, ce0: 60.5, pe0: 71, spot0: 25300, spot: 25290, seller: 63.4, regime: "no clear regime", variants: { hold: { pnl: 520, ce_open: true, pe_open: true, stopped_at: null }, leg40: { pnl: -300, ce_open: true, pe_open: false, stopped_at: "13:01" } } }],
  ...over,
});

let payload: (url: string) => unknown;
function mockApi() {
  const urls: string[] = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const routes: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [] };
    const path = url.split("?")[0]!;
    const hit = path === "/api/forward/overview" ? payload(url) : routes[path];
    return hit === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return urls;
}
const param = (url: string, k: string) => new URL(url, "http://x").searchParams.get(k);
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
const stat = (label: string) => within(screen.getByTestId("forward-stats")).getByText(label).parentElement!;

describe("forward test portfolio page", () => {
  it("opens on the straddle, all expiries and no stop, with the filters on top and the selection said in words", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    const filters = within(await screen.findByLabelText("Filters"));
    expect(within(filters.getByRole("group", { name: "Structure" })).getByRole("button", { name: "Straddle" })).toHaveAttribute("aria-pressed", "true");
    expect(within(filters.getByRole("group", { name: "Expiry" })).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    const stops = within(filters.getByRole("group", { name: "Stop loss" }));
    expect(stops.getByRole("button", { name: "No stop" })).toHaveAttribute("aria-pressed", "true");
    for (const n of ["Stop 30%", "Stop 40%", "Stop 50%", "Stop 60%", "Stop 70%", "Stop 80%", "40% + cost", "Combined +15%", "Combined +25%", "Combined +40%"]) expect(stops.getByRole("button", { name: n })).toBeInTheDocument();
    expect(screen.getByTestId("forward-selection")).toHaveTextContent("Showing: ATM straddle · weekly and monthly expiry · No stop (hold to 15:20)");
    expect(screen.getByText(/Paper portfolio, nothing is sent to a broker/)).toBeInTheDocument();
    expect(screen.getByText(/6 settled · 1 open · 6 days · last check 13:40 IST/)).toBeInTheDocument();
  });

  it("shows the portfolio statistics of the closed trades: counts, win and loss rate, drawdown, best and worst, streaks", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    await screen.findByTestId("forward-stats");
    expect(stat("Net P&L")).toHaveTextContent("+₹900");
    expect(stat("Trades")).toHaveTextContent("6");
    expect(stat("Trades")).toHaveTextContent("3 won · 3 lost");
    expect(stat("Win rate")).toHaveTextContent("50.0%");
    expect(stat("Loss rate")).toHaveTextContent("50.0%");
    expect(stat("Max drawdown")).toHaveTextContent("−₹1,200");
    expect(stat("Current drawdown")).toHaveTextContent("−₹1,000");
    expect(stat("Highest win")).toHaveTextContent("+₹1,500");
    expect(stat("Lowest win")).toHaveTextContent("+₹200");
    expect(stat("Highest loss")).toHaveTextContent("−₹900");
    expect(stat("Lowest loss")).toHaveTextContent("−₹300");
    expect(stat("Longest win streak")).toHaveTextContent("1");
    expect(stat("Longest win streak")).toHaveTextContent("now 1 in a row");
    expect(stat("Longest loss streak")).toHaveTextContent("2");
    expect(stat("Profit factor")).toHaveTextContent("1.56");
    expect(stat("Expectancy")).toHaveTextContent("+₹150");
    expect(stat("Recovery factor")).toHaveTextContent("0.75");
    expect(stat("Stop hit rate")).toHaveTextContent("50.0%");
    expect(stat("Average dip while open")).toHaveTextContent("−₹425");
    expect(screen.getByRole("img", { name: /Cumulative net P&L of the selected trades/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Only 6 closed trades in this selection/);
  });

  it("choosing a structure, an expiry and a stop-loss asks the server for that portfolio and says what is shown", async () => {
    payload = (url) => overview({}, { structure: param(url, "structure"), cohort: param(url, "cohort"), rule: param(url, "rule"), rule_label: param(url, "rule") === "leg40" ? "Leg stop 40%" : "No stop (hold to 15:20)" });
    const urls = mockApi();
    renderAt("/tools/forward-test");
    await screen.findByTestId("forward-stats");
    await userEvent.click(screen.getByRole("button", { name: "Strangle ±50" }));
    await userEvent.click(screen.getByRole("button", { name: "Weekly" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop 40%" }));
    await vi.waitFor(() => expect(urls.some((u) => param(u, "structure") === "strangle" && param(u, "cohort") === "weekly" && param(u, "rule") === "leg40")).toBe(true));
    await vi.waitFor(() => expect(screen.getByTestId("forward-selection")).toHaveTextContent("Showing: Strangle ±50 · weekly expiry · Leg stop 40%"));
    expect(screen.getByRole("button", { name: "Stop 40%" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "No stop" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Both" }));
    await vi.waitFor(() => expect(urls.some((u) => param(u, "structure") === "all" && param(u, "rule") === "leg40")).toBe(true));
    // clicking a row of the comparison table picks that rule
    await userEvent.click(within(screen.getByRole("region", { name: "Stop-loss rules compared" })).getByRole("row", { name: "Show the portfolio of No stop (hold to 15:20)" }));
    await vi.waitFor(() => expect(urls.at(-1)).toContain("rule=hold"));
  });

  it("lists every closed trade with what was sold, how it exited and its net and cumulative result, newest first", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    const log = within(await screen.findByRole("table", { name: "Closed trades" }));
    const rows = log.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent("+₹200"); // the sixth trade is first
    expect(rows[0]).toHaveTextContent("+₹900"); // its cumulative result
    expect(rows[1]).toHaveTextContent("stop at 10:46"); // the fifth trade (-300) was stopped
    expect(rows[2]).toHaveTextContent("stop at 10:46"); // so was the fourth (-900)
    expect(rows[3]).toHaveTextContent("close 15:20");
    expect(rows[5]).toHaveTextContent("+₹1,500");
    expect(rows[5]).toHaveTextContent("25250 CE + PE");
    expect(rows[5]).toHaveTextContent("175.0"); // 90 + 85
    expect(rows[5]).toHaveTextContent("CE 60.5 · PE 70.0");
    expect(rows[5]).toHaveTextContent("₹1,600 − ₹100");
  });

  it("shows the open positions of the selected rule and the breakdown of that rule", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    const open = within(await screen.findByRole("region", { name: "Open now" }));
    expect(open.getByText("+₹520")).toBeInTheDocument(); // the no-stop mark
    expect(open.getByText(/Sold 25300 CE \+ PE at 60.5 \+ 71 = 131.50/)).toBeInTheDocument();
    const b = within(screen.getByRole("table", { name: "Breakdown" }));
    expect(b.getByText("volatility compression")).toBeInTheDocument();
    expect(b.getByText("too few")).toBeInTheDocument();
  });

  it("says what will happen when nothing has settled yet", async () => {
    payload = () => overview({ portfolio: [], rules: [rule("hold", "No stop (hold to 15:20)", { n: 0 })], open: [], breakdown: { dimension: "regime", title: "Regime at entry", min_trades: 20, options: { regime: "Regime at entry" }, rows: [] }, meta: { ...overview().meta, counts: { open: 0, settled: 0, days: 0 }, last_tick: null } });
    mockApi();
    renderAt("/tools/forward-test");
    expect(await screen.findByText(/No closed trade for this selection yet\. below about 20/)).toBeInTheDocument();
    expect(screen.getByTestId("forward-stats")).toHaveTextContent("Net P&L");
    expect(within(screen.getByRole("region", { name: "Closed trades" })).getByText("No closed trade for this selection yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing to break down yet.")).toBeInTheDocument();
    expect(screen.getByText(/No open position\. One opens the first time the seller score/)).toBeInTheDocument();
    expect(screen.getByText(/last check not yet/)).toBeInTheDocument();
  });
});

describe("forward test today panel", () => {
  it("says whether the test is running: positions open now, each expiry's score, its trades today and what it waits for", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    const today = within(await screen.findByTestId("forward-today"));
    expect(today.getByText(/position open now, closing at 15:20/)).toBeInTheDocument();
    expect(today.getByText(/weekly expiry 2026-11-17/)).toBeInTheDocument();
    expect(today.getByText(/seller 78 at 10:07 · 1 of 3 trades today \(09:30\)/)).toBeInTheDocument();
    expect(today.getByText(/seller 55 at 10:07 · 1 of 3 trades today \(09:57\)/)).toBeInTheDocument();
    expect(today.getByText(/the score fell below 60 at 10:00: the next trade opens if it stays there 30 minutes and then reaches 60 again\./)).toBeInTheDocument();
    expect(today.getByText(/a trade is open: the next one needs the score to fall below 60 for 30 minutes and reach 60 again\./)).toBeInTheDocument();
  });

  it("describes every state of an expiry in words", () => {
    const t = { session: "2026-11-17", in_window: true, cap: 3, threshold: 60, rearm_minutes: 30, cohorts: [] };
    const c = { cohort: "weekly", expiry: "2026-11-17", seller: 70, score_at: null, count: 0, armed: true, below_since: null, opened: [] };
    expect(cohortStatus(t, c)).toBe("score is 60 or more: a trade opens at the next stored price");
    expect(cohortStatus(t, { ...c, seller: 50 })).toBe("waiting for the seller score to reach 60");
    expect(cohortStatus(t, { ...c, seller: null })).toBe("waiting for a seller score");
    expect(cohortStatus({ ...t, in_window: false }, c)).toBe("ready, but the entry window (09:30 to 14:30 IST) is closed");
    expect(cohortStatus(t, { ...c, count: 3, armed: false })).toBe("all 3 trades of the day are open or done: no more today");
  });
});

describe("forward positions open in the strategy builder", () => {
  it("clicking an open position hands it to the builder as a temporary view: its legs, strikes, entry prices, the selected stop rule and the entry time, and leaves the user's own working copy alone", async () => {
    localStorage.setItem("nse.builder.working.v1", JSON.stringify({ legs: [], marker: "mine" }));
    payload = (url) => overview({}, { rule: param(url, "rule"), rule_label: param(url, "rule") });
    mockApi();
    renderAt("/tools/forward-test");
    await userEvent.click(await screen.findByRole("button", { name: "Stop 40%" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Stop 40%" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(await screen.findByRole("button", { name: "Open weekly straddle #2 in the Strategy builder" }));
    const w = JSON.parse(sessionStorage.getItem("nse.builder.temp.v1")!);
    expect(w.name).toBe("Forward weekly straddle #2, 16 Nov 13:00");
    expect(w.expiry).toBe("2026-11-17");
    expect(w.legs.map((l: { type: string; strike: number; premium: number; stop: number }) => [l.type, l.strike, l.premium, l.stop])).toEqual([["CE", 25300, 60.5, 84.7], ["PE", 25300, 71, 99.4]]); // 40 % above each entry
    expect(w.holdFrom).toBe("2026-11-16T07:30:00+00:00");
    expect(JSON.parse(localStorage.getItem("nse.builder.working.v1")!).marker).toBe("mine"); // the user's own strategy in this browser is untouched
    expect(w.legs[0].exitPrice).toBeUndefined();
    expect(w.legs.every((l: { enteredAt: string }) => l.enteredAt === "2026-11-16T07:30:00+00:00")).toBe(true);
  });

  it("clicking a closed trade opens it with its exits", async () => {
    payload = () => overview();
    mockApi();
    renderAt("/tools/forward-test");
    const row = (await screen.findAllByRole("row", { name: /^Open the trade of .* in the Strategy builder$/ }))[2]!; // the fourth trade (index 3), newest first: stopped, -900
    await userEvent.click(row);
    const w = JSON.parse(sessionStorage.getItem("nse.builder.temp.v1")!);
    expect(w.legs.map((l: { exitPrice: number }) => l.exitPrice)).toEqual([60.5, 70]);
    expect(w.legs[0].exitedAt).toBe("2026-11-13T09:50:00+00:00"); // hold: closed at the end of that day (13 Nov, 15:20 IST)
  });
});
