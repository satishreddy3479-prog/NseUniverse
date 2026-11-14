// Replay on the tool pages: off until pressed; then every chart shows only what was stored up to the replay time, and the chain is the
// stored snapshot of that time. Generated one-minute samples (formula checks, not market data): 40 samples on Mon 2 Nov 2026, expiry 3 Nov.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const oiSeries = {
  underlying: "NIFTY", expiry: "2026-11-03", strikes: [24050], atm_strike: 24050, times, spot,
  ce_oi: times.map((_, i) => 400_000 + 1000 * i), pe_oi: times.map((_, i) => 800_000 + 2000 * i), ce_volume: times.map((_, i) => 1000 * i), pe_volume: times.map((_, i) => 1500 * i),
  ce_change: times.map((_, i) => 100 * i), pe_change: times.map((_, i) => 200 * i), stride: 1, warnings: [], definitions: {},
};
const asked: string[] = [];
let missingFrom = Infinity; // snapshots with an index from here on are "not stored" (404)
function mockApi() {
  asked.length = 0;
  missingFrom = Infinity;
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [], "/api/option-chain": bigChain(),
    "/api/history/observations": hist, "/api/history/strike-series": strikeSeries, "/api/history/oi-series": oiSeries, "/api/market/index-bars": { day: null, bars: [], note: "" },
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0]!;
    asked.push(path);
    const snapNo = /^\/api\/snapshots\/s(\d+)$/.exec(path)?.[1];
    if (snapNo != null && Number(snapNo) >= missingFrom) return new Response(JSON.stringify({ detail: { code: "not_found", message: "snapshot not found" } }), { status: 404 });
    const hit = path.startsWith("/api/snapshots/") && !path.endsWith("/csv") ? bigChain() : routes[path];
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

/** the number of plotted points over every chart on the page */
const plotted = () => screen.getAllByRole("img").reduce((n, el) => n + (el.getAttribute("data-points") ?? "").split(",").reduce((m, x) => m + (Number(x) || 0), 0), 0);

async function startAndPause() {
  await userEvent.click(await screen.findByRole("button", { name: /Replay/ }));
  await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  return (await screen.findByRole("slider", { name: "Replay time" })) as HTMLInputElement;
}

describe.each([["Smart OI", "/tools/smart-oi"], ["Multi OI & Volume", "/tools/multi-oi-volume"], ["Gamma Exposure", "/tools/gamma-exposure"], ["ATM Straddle Chart", "/tools/straddle"], ["ATM Rolling Straddle", "/tools/rolling-straddle"]])("%s replay", (_name, path) => {
  it("is off until Replay is pressed; then the page shows only what was stored up to the replay time and Exit brings it back", async () => {
    mockApi();
    renderAt(path);
    await screen.findByRole("button", { name: /Replay/ });
    expect(screen.queryByRole("slider", { name: "Replay time" })).toBeNull(); // never starts by itself
    await waitFor(() => expect(plotted()).toBeGreaterThan(0));
    const live = plotted();
    const slider = await startAndPause();
    expect(Number(slider.max)).toBe(N - 1);
    fireEvent.change(slider, { target: { value: "5" } });
    await waitFor(() => expect(plotted()).toBeLessThan(live)); // six samples of forty are drawn
    expect(screen.getByTestId("replay-time")).toHaveTextContent("09:25 IST"); // 09:20 + 5 minutes
    await userEvent.click(screen.getByRole("button", { name: "Exit replay" }));
    expect(screen.queryByRole("slider", { name: "Replay time" })).toBeNull();
    await waitFor(() => expect(plotted()).toBe(live));
  });
});

describe("replay clock", () => {
  it("the chain of the page is the stored snapshot of the replay time, not the latest one", async () => {
    mockApi();
    renderAt("/tools/vega-analysis");
    const slider = await startAndPause();
    fireEvent.change(slider, { target: { value: "12" } });
    await waitFor(() => expect(asked).toContain("/api/snapshots/s12"));
  });
  it("Replay starts playing at once from the first sample and the time moves on by itself", async () => {
    mockApi();
    renderAt("/tools/smart-oi");
    await userEvent.click(await screen.findByRole("button", { name: /Replay/ }));
    expect(await screen.findByTestId("replay-time")).toHaveTextContent("09:20 IST");
    await waitFor(() => expect(screen.getByTestId("replay-time")).not.toHaveTextContent("09:20 IST"), { timeout: 4000 });
    expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
  });
  it("a stored chain that cannot be read does not blank the page: the last chain that loaded stays", async () => {
    mockApi();
    missingFrom = 5; // the first samples have their snapshot, the later ones do not
    renderAt("/tools/vega-analysis");
    const slider = await startAndPause();
    await waitFor(() => expect(asked).toContain("/api/snapshots/s0"));
    fireEvent.change(slider, { target: { value: "20" } });
    await waitFor(() => expect(asked).toContain("/api/snapshots/s20")); // asked for, and refused
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByRole("img", { name: "Call vega, put vega and NIFTY through the session" })).toBeInTheDocument();
  });
  it("a tool that does not replay has no replay bar", async () => {
    mockApi();
    renderAt("/tools/max-pain");
    await screen.findByRole("heading", { name: /Max Pain/i });
    expect(screen.queryByTestId("replay-bar")).toBeNull();
  });
});
