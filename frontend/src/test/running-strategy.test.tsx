// The running-strategy chart widgets of the Eagles view: what they show with no strategy, with one running, with only a future, and when the server cannot be reached.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningMtmChart, RunningTimeChart } from "../components/RunningStrategy";
import { expiries } from "./fixtures";

vi.mock("../components/StrategyMtm", () => ({ StrategyMtm: ({ legs, liveNow, lotSize }: { legs: unknown[]; liveNow: number | null; lotSize: number | null }) => <div data-testid="mtm" data-legs={legs.length} data-live={String(liveNow)} data-lot={String(lotSize)} /> }));
vi.mock("../components/StrategyTimeChart", () => ({ StrategyTimeChart: ({ legs, rules }: { legs: { type: string }[]; rules: { sl: number | null } }) => <div data-testid="timechart" data-legs={legs.length} data-types={legs.map((l) => l.type).join(",")} data-sl={String(rules.sl)} /> }));

const leg = (over: Record<string, unknown>) => ({ id: "a", type: "CE", action: "SELL", strike: 25800, expiry: "2026-12-01", lots: 1, premium: 230, enabled: true, ...over });
const rules = { sl: 5000, target: null, lockAt: null, lockProfit: null, trailEvery: null, trailBy: null };

function mount(opts: { doc: unknown; running: boolean; fail?: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    if (opts.fail && url.startsWith("/api/strategies/running")) return new Response(JSON.stringify({ detail: { code: "x", message: "down" } }), { status: 500 });
    const routes: Record<string, unknown> = {
      "/api/strategies/running": { doc: opts.doc, checking: { live: true, last_check_at: null, error: null } },
      "/api/strategies/running/pnl": { at: "2026-11-25T09:00:00Z", running: opts.running, live: true, name: "Short straddle", booked: 0, open: 1250, total: 1250, missing: [] },
      "/api/expiries": expiries,
    };
    const hit = routes[url];
    return hit === undefined ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const ui = (el: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
  return ui;
}
afterEach(() => vi.unstubAllGlobals());

describe("the running-strategy widgets", () => {
  it("say so plainly when no strategy is running", async () => {
    mount({ doc: null, running: false })(<RunningMtmChart />);
    expect((await screen.findByTestId("running-none")).textContent).toContain("No strategy is running");
    expect(screen.queryByTestId("mtm")).toBeNull();
  });

  it("draw the mark-to-market of the running strategy with the server's live P&L and its lot size, lots multiplied by the strategy's multiplier", async () => {
    mount({ doc: { lotSize: 65, mult: 2, legs: [leg({ id: "a" }), leg({ id: "b", type: "PE", strike: 25800 })], rules }, running: true })(<RunningMtmChart />);
    const m = await screen.findByTestId("mtm");
    expect(m.getAttribute("data-legs")).toBe("2");
    expect(m.getAttribute("data-live")).toBe("1250");
    expect(m.getAttribute("data-lot")).toBe("65");
  });

  it("draw the price-and-P&L chart from the open option legs only, with the strategy's own stop rule", async () => {
    mount({ doc: { lotSize: 65, legs: [leg({ id: "a" }), leg({ id: "b", type: "PE" }), leg({ id: "f", type: "FUT", strike: 0 }), leg({ id: "x", type: "CE", strike: 26000, enabled: false })], rules }, running: true })(<RunningTimeChart />);
    const c = await screen.findByTestId("timechart");
    expect(c.getAttribute("data-types")).toBe("CE,PE"); // the future and the switched-off leg are not drawn
    expect(c.getAttribute("data-sl")).toBe("5000");
  });

  it("explain a strategy that is only a future instead of drawing an empty chart", async () => {
    mount({ doc: { lotSize: 65, legs: [leg({ id: "f", type: "FUT", strike: 0 })], rules }, running: true })(<RunningTimeChart />);
    expect((await screen.findByTestId("running-no-options")).textContent).toContain("no open option leg");
  });

  it("report a server that cannot be reached as an error, not as 'no strategy'", async () => {
    mount({ doc: null, running: false, fail: true })(<RunningMtmChart />);
    expect((await screen.findByTestId("running-error")).textContent).toContain("could not be loaded");
  });
});
