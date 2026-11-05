// The Gamma Exposure tool page, rendered from option prices generated with Black-76 (formula checks, not market data):
// 40 one-minute samples on Mon 2 Nov 2026, expiry 3 Nov, spot drifting around 24 050.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { bigChain, expiries, status } from "./fixtures";
import type { HistoryResponse, Observation } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} data-points={(o.series ?? []).map((s) => s.data.length).join(",")} />;
  },
}));

const N = 40;
const T0 = Date.parse("2026-11-02T03:50:00Z"); // 09:20 IST, Monday
const times = Array.from({ length: N }, (_, i) => new Date(T0 + i * 60_000).toISOString());
const spot = times.map((_, i) => 24040 + 30 * Math.sin(i / 6));

// normal CDF (Abramowitz & Stegun 7.1.26) and Black-76 price
const erf = (x: number) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const ncdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
const black = (F: number, K: number, T: number, s: number, call: boolean) => {
  const v = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * v * v) / v, d2 = d1 - v;
  return call ? F * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - F * ncdf(-d1);
};
const T = (i: number) => (Date.parse("2026-11-03T10:00:00Z") - (T0 + i * 60_000)) / (365 * 86_400_000);

const obs = (i: number): Observation => ({
  snapshot_id: `s${i}`, retrieved_at: times[i]!, session_id: "x", underlying_ltp: spot[i]!, underlying_prev_close: 24000, atm_strike: 24050, atm_call_ltp: 100, atm_put_ltp: 100,
  straddle: 200, total_ce_premium: 700, total_pe_premium: 700, total_ce_oi: 7000, total_pe_oi: 7000, total_ce_volume: 70, total_pe_volume: 70, strikes_in_universe: 7, missing_ltp: 0, same_as_previous: false,
});
const hist: HistoryResponse = { underlying: "NIFTY", expiry: "2026-11-03", strikes_each_side: 10, observations: times.map((_, i) => obs(i)), distinct_observations: N, definitions: {}, note: "" };

function strikeSeries(url: string) {
  const strikes = (new URL(url, "http://x").searchParams.get("strikes") ?? "24050").split(",").map((x) => (x === "atm" ? 24050 : Number(x)));
  const per = (f: (k: number, i: number) => number) => Object.fromEntries(strikes.map((k) => [String(k), times.map((_, i) => f(k, i))]));
  return {
    underlying: "NIFTY", expiry: "2026-11-03", strikes, atm_strike: 24050, times, spot,
    ce_price: per((k, i) => black(spot[i]!, k, T(i), 0.15, true)), pe_price: per((k, i) => black(spot[i]!, k, T(i), 0.15, false)),
    ce_oi: per(() => 400_000), pe_oi: per(() => 800_000), ce_change: per(() => 0), pe_change: per(() => 0), stride: 1, warnings: [], definitions: {},
  };
}

function mockApi() {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [], "/api/option-chain": bigChain(),
    "/api/history/observations": hist, "/api/history/strike-series": strikeSeries,
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    return new Response(JSON.stringify(typeof hit === "function" ? (hit as (u: string) => unknown)(String(input)) : hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/tools/gamma-exposure"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("Gamma Exposure page", () => {
  it("shows the seven level cards, the regime with its sign convention, and the corridor reading", async () => {
    mockApi();
    renderPage();
    const cards = within(await screen.findByTestId("gamma-cards"));
    for (const l of ["Spot price", "Max pain", "Call wall", "Put wall", "Peak gamma", "Gamma flip", "Aggregate net GEX"]) expect(cards.getByText(l)).toBeInTheDocument();
    const regime = within(screen.getByTestId("gamma-regime"));
    expect(regime.getByText(/Positive Gamma|Negative Gamma|Near the gamma flip/)).toBeInTheDocument();
    expect(regime.getByText(/Sign convention: calls positive, puts negative/)).toBeInTheDocument();
    expect(regime.getByText(/if the real positioning were the reverse, the profile would invert/)).toBeInTheDocument();
    const reading = within(screen.getByTestId("gamma-reading"));
    for (const l of ["Regime", "Corridor", "Position against the flip"]) expect(reading.getByText(l)).toBeInTheDocument();
    expect(screen.getByText(/No entry, target or stop is derived here/)).toBeInTheDocument(); // levels only, nothing invented
  });

  it("draws the profile, the density and the by-strike bars, and the display type switches the bars", async () => {
    mockApi();
    renderPage();
    const profile = await screen.findByRole("img", { name: "Gamma exposure by strike" });
    expect(profile.getAttribute("data-series")).toBe("Net GEX|Absolute GEX");
    await userEvent.click(screen.getByRole("button", { name: "Calls only" }));
    expect(screen.getByRole("img", { name: "Gamma exposure by strike" }).getAttribute("data-series")).toBe("Call GEX");
    await userEvent.click(screen.getByRole("button", { name: "Puts only" }));
    expect(screen.getByRole("img", { name: "Gamma exposure by strike" }).getAttribute("data-series")).toBe("Put GEX");
    expect(screen.getByRole("img", { name: "Absolute and net gamma exposure by strike" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Smoothed call, put and total gamma/ }).getAttribute("data-series")).toBe("Sell gamma (calls)|Buy gamma (puts)|Total");
    expect(screen.getByTestId("gamma-density-note")).toHaveTextContent("Sell × buy intersection");
  });

  it("lists up to ten strikes by size of net GEX with a type and what it implies", async () => {
    mockApi();
    renderPage();
    const table = within(await screen.findByTestId("gamma-table"));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows[0]).toHaveTextContent(/Call wall|Put wall|\+GEX|−GEX/);
    expect(rows[0]).toHaveTextContent(/Stabilizing|Amplifying|concentration/);
  });

  it("draws the session structure from the stored samples and says how it was built", async () => {
    mockApi();
    renderPage();
    const chart = await screen.findByRole("img", { name: /Spot, walls, peak and gamma flip with net GEX/ });
    expect(chart.getAttribute("data-series")).toBe("Spot|Call wall|Put wall|Peak gamma|Gamma flip|Net GEX|GEX change per minute");
    expect(screen.getByTestId("gamma-structure-note")).toHaveTextContent("21 strikes around the open at-the-money strike");
    expect(screen.getByRole("group", { name: "Timeframe" })).toBeInTheDocument();
  });
});
