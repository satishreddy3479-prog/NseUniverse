// Signal Backtest page: renders what the backend computed and says plainly when the sample is too small. Numbers are arithmetic, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
