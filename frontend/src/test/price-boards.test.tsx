import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { bigChain, expiries, status } from "./fixtures";
import type { HistoryResponse, Observation, StrikeSeries } from "../lib/types";

// jsdom has no canvas: the chart wrapper is replaced by a stub that exposes the lines it was given.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel, group }: { option: unknown; ariaLabel: string; group?: string }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[] };
    return <div role="img" aria-label={ariaLabel} data-group={group} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} data-points={(o.series ?? []).map((s) => s.data.length).join(",")} />;
  },
}));

const obs = (retrieved_at: string): Observation => ({
  snapshot_id: retrieved_at, retrieved_at, session_id: "x", underlying_ltp: 24050, underlying_prev_close: 24100, atm_strike: 24050,
  atm_call_ltp: 100, atm_put_ltp: 100, straddle: 200, total_ce_premium: 700, total_pe_premium: 700, total_ce_oi: 7000, total_pe_oi: 7000,
  total_ce_volume: 70, total_pe_volume: 70, strikes_in_universe: 7, missing_ltp: 0, same_as_previous: false,
});
const history = (times: string[]): HistoryResponse => ({ underlying: "NIFTY", expiry: "2026-11-03", strikes_each_side: 10, observations: times.map(obs), distinct_observations: times.length, definitions: {}, note: "" });

// 04 Nov 2026 09:20 / 09:21 IST: inside the session
const IN_SESSION = ["2026-11-04T03:50:00Z", "2026-11-04T03:51:00Z"];
const series = (strikes: number[]): StrikeSeries => {
  const per = (v: (k: number) => (number | null)[]) => Object.fromEntries(strikes.map((k) => [String(k), v(k)]));
  return {
    underlying: "NIFTY", expiry: "2026-11-03", strikes, atm_strike: 24050, times: IN_SESSION, spot: [24050, 24060],
    ce_price: per(() => [100, 110]), pe_price: per(() => [90, 80]), ce_oi: per(() => [400_000, 410_000]), pe_oi: per(() => [800_000, 790_000]),
    ce_change: per(() => [10, 20]), pe_change: per(() => [-5, -6]), stride: 1, warnings: [], definitions: {},
  };
};

function mockApi(hist: HistoryResponse) {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [], "/api/option-chain": bigChain(),
    "/api/history/observations": hist,
    "/api/history/strike-series": (u: string) => series(new URL(u, "http://x").searchParams.get("strikes")!.split(",").map((x) => (x === "atm" ? 24050 : Number(x)))),
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    return new Response(JSON.stringify(typeof hit === "function" ? (hit as (u: string) => unknown)(String(input)) : hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("Price vs OI page", () => {
  it("shows the six linked charts of one strike, not the old OI-change table", async () => {
    mockApi(history(IN_SESSION));
    renderAt("/tools/price-vs-oi");
    const board = await screen.findByTestId("price-oi-board");
    for (const t of ["Price (Call vs Put)", "24,050 Straddle Price + PCR", "24,050 CE Price vs OI", "24,050 PE Price vs OI", "OI (Call vs Put)", "OI Change (Call vs Put)"]) {
      expect(await within(board).findByRole("region", { name: t })).toBeInTheDocument();
    }
    const charts = within(board).getAllByRole("img");
    expect(charts).toHaveLength(6);
    expect(new Set(charts.map((c) => c.getAttribute("data-group")))).toEqual(new Set(["price-tools"])); // one shared crosshair
    expect(screen.queryByRole("table", { name: "Price and OI" })).toBeNull();
    expect(within(board).getByRole("img", { name: /call and put OI change/ }).getAttribute("data-series")).toBe("24,050 CE OI Change|24,050 PE OI Change");
    // the price tools are tabs of one family
    expect(screen.getByRole("navigation", { name: "Price tools" })).toBeInTheDocument();
  });

  it("says why nothing is drawn when only after-hours samples are stored", async () => {
    mockApi(history(["2026-11-04T18:01:00Z", "2026-11-04T18:02:00Z"])); // 23:31 IST
    renderAt("/tools/price-vs-oi");
    expect(await screen.findByText("No session samples stored yet")).toBeInTheDocument();
  });
});

describe("MultiStrike and Multi-Straddle", () => {
  it("MultiStrike plots calls and puts of the chosen strikes and switches what is plotted", async () => {
    mockApi(history(IN_SESSION));
    renderAt("/tools/multistrike-chart");
    const calls = await screen.findByRole("img", { name: "Call contracts of the chosen strikes" });
    expect(calls.getAttribute("data-series")?.split("|")).toHaveLength(3); // ATM and its two neighbours by default
    await userEvent.click(screen.getByRole("button", { name: "OI change" }));
    expect(await screen.findByRole("region", { name: "Calls · OI change" })).toBeInTheDocument();
  });

  it("Multi-Straddle draws one straddle line per strike", async () => {
    mockApi(history(IN_SESSION));
    renderAt("/tools/multi-straddle");
    const chart = await screen.findByRole("img", { name: "Straddle price of the chosen strikes" });
    expect(chart.getAttribute("data-series")?.split("|").every((n) => n.endsWith("Straddle"))).toBe(true);
  });
});

describe("Vega Analysis page and section tabs", () => {
  it("draws call vega, put vega and NIFTY through the session with a table, not only the by-strike bars", async () => {
    mockApi(history(IN_SESSION));
    renderAt("/tools/vega-analysis");
    const chart = await screen.findByRole("img", { name: "Call vega, put vega and NIFTY through the session" });
    expect(chart.getAttribute("data-series")).toBe("Call Vega|Put Vega|Put − Call|NIFTY");
    expect(screen.getByRole("group", { name: "Timeframe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vega (Greek)" })).toHaveAttribute("aria-pressed", "true"); // the Greek is the default, not OI-weighted
    expect(await screen.findByRole("table", { name: "Vega table" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(screen.queryByRole("table", { name: "Vega table" })).toBeNull();
  });

  it("every tool page lists the tools of its section as tabs, with the current one marked", async () => {
    mockApi(history(IN_SESSION));
    renderAt("/tools/vega-analysis");
    const nav = await screen.findByRole("navigation", { name: "Popular tools" });
    for (const name of ["PE-CE Difference", "Timeseries", "Strategy Chart", "Smart OI", "Vega Analysis"]) expect(within(nav).getByRole("link", { name: new RegExp(name) })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Vega Analysis/ })).toHaveAttribute("aria-current", "page");
  });
});
