// Signal Backtest page: renders what the backend computed and says plainly when the sample is too small. Numbers are arithmetic, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gexHistoryExample } from "../components/GexHistoryChart";
import { backtestExample, SignalBacktestBody } from "../components/SignalBacktest";
import { toolById } from "../lib/tools";
import type { Backtest, BacktestResult, BacktestSide } from "../lib/types";

afterEach(() => vi.unstubAllGlobals());

const side = (o: Partial<BacktestSide> = {}): BacktestSide => ({ events: 0, others: 0, unavailable: 0, enough: false, ...o });
const good: BacktestResult = {
  id: "skew_negative", title: "Negative 25-delta skew then NIFTY up", rule: "event: skew25 ≤ 0; long next 30 min", side: 1, target: "ret_pct", cost_bps: 5, status: "ok",
  sessions: { in_sample: ["2026-11-02"], out_of_sample: ["2026-11-05", "2026-11-06"] },
  in_sample: side({ events: 12, others: 30 }),
  out_of_sample: side({ events: 24, others: 40, enough: true, net_return_pct: { n: 24, win_rate: 58.3, mean: 0.0412, total: 0.989, ci95: [-0.01, 0.0924], max_drawdown: 0.35, risk_reward: 1.3 } }),
};
const thin: BacktestResult = { ...good, id: "put_momentum", title: "Put IV strengthening then NIFTY down", side: -1, status: "insufficient out-of-sample sample: 3 events (need 20)", out_of_sample: side({ events: 3, others: 9, net_return_pct: { n: 3, win_rate: 33.3, mean: -0.02, total: -0.06, ci95: [-0.3, 0.26], max_drawdown: 0.1, risk_reward: 0.5 } }) };
const data: Backtest = {
  status: "ok", expiry: "2026-11-10", sessions: ["2026-11-02", "2026-11-05", "2026-11-06"], snapshots: 220, horizon_minutes: 30, oos_share: 0.4, min_events: 20, cost_bps: 5, tests: [good, thin],
  not_testable: [{ id: "gex_vs_rv", title: "Net GEX versus realised intraday volatility", reason: "no server-side GEX series is stored yet." }], note: "Signals are tested against NIFTY, not against an options position.",
};

describe("Signal Backtest", () => {
  it("is a ready page tool", () => expect(toolById("signal-backtest")?.page).toBe("backtest"));
  it("the worked example restates the first result's own numbers", () => {
    const ex = backtestExample(data.tests).join("\n");
    expect(ex).toContain("24 non-overlapping events");
    expect(ex).toContain("Mean = total / n = 0.989 / 24 = 0.0412 %");
    expect(ex).toContain("later than the in-sample sessions");
  });
  it("shows out-of-sample first, flags the thin row as insufficient, lists what cannot be tested, and keeps the methodology closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SignalBacktestBody expiry="2026-11-10" /></QueryClientProvider>);
    const rows = await screen.findAllByTestId("bt-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("58.3%");
    expect(rows[1]!.textContent).toContain("insufficient out-of-sample sample: 3 events (need 20)");
    expect(screen.getByTestId("bt-note").textContent).toContain("not against an options position");
    expect(screen.getByTestId("bt-untestable").textContent).toContain("Net GEX versus realised intraday volatility");
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getAllByTestId("methodology-backtest_construction")).toHaveLength(1);
  });
  it("says so when nothing is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...data, status: "no stored sessions with a solvable chain for this expiry", tests: [], sessions: [], snapshots: 0 }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SignalBacktestBody expiry="2026-11-10" /></QueryClientProvider>);
    expect((await screen.findByTestId("bt-empty")).textContent).toContain("no stored sessions");
  });
});

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

describe("Signal Backtest: GEX history, progress and reconstruction report", () => {
  const corr: BacktestResult = { ...good, id: "gex_vs_rv", title: "Net GEX (net / absolute) versus subsequent realised volatility", side: 0, target: "corr", out_of_sample: { events: 31, others: 0, unavailable: 4, enough: true, correlation: { r: -0.213, n: 31, ci95: [-0.52, 0.15] } }, in_sample: { events: 20, others: 0, unavailable: 2, enough: true, correlation: { r: -0.1, n: 20, ci95: null } } };
  const withGex: Backtest = { ...data, universe: "dynamic", tests: [good, corr], reconstruction: { snapshots_with: { net: 218, flip: 190, call_wall: 220, put_wall: 201, peak: 220, near_net: 220 }, snapshots_skipped: { "not computed: less than 15 minutes to expiry (or expired)": 2 }, opening_atm: { "2026-11-02": 24000 } }, timing: { total_ms: 812, computed: 12, cached: 208 } };
  const hist = { status: "ok", expiry: "2026-11-10", session: "2026-11-06", universe: "dynamic", opening_atm: 24000, skipped: [{ at: "x", reason: "r" }], units: "₹ crore per 1 % move; calls +, puts − (model sign)",
    points: [{ at: "2026-11-06T09:15:00+05:30", spot: 24000, ce: 150, pe: -100, net: 50, abs: 250, flip: 23900, near_net: 20, call_wall: 24100, put_wall: 23900, peak: 24000, used: 21 }, { at: "2026-11-06T09:20:00+05:30", spot: 24010, ce: 152, pe: -101, net: 51, abs: 253, flip: null, near_net: 21, call_wall: 24100, put_wall: 23900, peak: 24000, used: 21 }] };
  it("shows a correlation row with its interval, the reconstruction counts, the skipped snapshots, and the rebuilt GEX history with its example", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/gex-history") ? hist : withGex), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SignalBacktestBody expiry="2026-11-10" /></QueryClientProvider>);
    const rows = await screen.findAllByTestId("bt-row");
    expect(rows[1]!.textContent).toContain("r = -0.213");
    expect(rows[1]!.textContent).toContain("-0.520 to 0.150");
    expect(screen.getByTestId("bt-recon").textContent).toContain("flip 190");
    expect(screen.getByTestId("bt-skipped").textContent).toContain("2 (not computed: less than 15 minutes to expiry (or expired))");
    expect(await screen.findByTestId("gexhist-chart")).toBeTruthy();
    expect(screen.getByTestId("gexhist-note").textContent).toContain("1 skipped");
    const gx = screen.getAllByTestId("methodology-gex_reconstruction");
    expect(gx.length).toBeGreaterThanOrEqual(1);
    expect(gexHistoryExample(hist as never).join("\n")).toContain("Net = 152 + (−101) = 51.00 cr"); // the newest rebuilt snapshot: call 152, put −101
  });
  it("a large run shows its progress and polls instead of freezing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "computing", expiry: "2026-11-10", progress: { done: 300, total: 1200 }, tests: [] }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SignalBacktestBody expiry="2026-11-10" /></QueryClientProvider>);
    expect((await screen.findByTestId("bt-progress")).textContent).toContain("300 of 1200 snapshots, 25%");
  });
  it("says when another large run is already using the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "busy", message: "another large backtest is running; try again when it finishes", progress: { done: 1, total: 2 }, tests: [] }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SignalBacktestBody expiry="2026-11-10" /></QueryClientProvider>);
    expect((await screen.findByTestId("bt-progress")).textContent).toContain("another large backtest is running");
  });
});
