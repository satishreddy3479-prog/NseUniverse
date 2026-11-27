// The Premium Change tool page, rendered from option prices generated with Black-76 (formula checks, not market data):
// 40 one-minute samples on Mon 2 Nov 2026, expiry 3 Nov, spot drifting around 24 050.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { bigChain, expiries, status } from "./fixtures";
import type { HistoryResponse, Observation } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel, onClick }: { option: unknown; ariaLabel: string; onClick?: (p: { name?: string }) => void }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[]; xAxis?: { data?: string[] } };
    return (
      <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} data-points={(o.series ?? []).map((s) => s.data.length).join(",")}>
        {onClick && <button type="button" data-testid={`pick-first-${ariaLabel.slice(0, 12)}`} onClick={() => onClick({ name: o.xAxis?.data?.[0] })}>first window</button>}
      </div>
    );
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
    const path = String(input).split("?")[0]!;
    const hit = path.startsWith("/api/snapshots/") ? bigChain() : routes[path]; // a stored snapshot of any replay time
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    return new Response(JSON.stringify(typeof hit === "function" ? (hit as (u: string) => unknown)(String(input)) : hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
/** Renders the tool and opens its classic ATM-windows view (the strike view is the default since 27 Nov 2026; it has its own tests). */
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/tools/premium-change"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "ATM windows (classic)" }));
  return out;
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());


describe("Premium Change tool page", () => {
  it("reads the ATM straddle's last window in a sentence whose three parts match the chart, and the chart has one bar group per window", async () => {
    mockApi();
    await renderPage();
    const readout = await screen.findByTestId("pc-readout");
    expect(readout.textContent).toMatch(/^At \d\d:\d\d the \d{5} straddle \(₹\d+\.\d\) went (up|down) by ₹\d+\.\d in 5 minutes \(NIFTY [+−]\d+ points\): /);
    const parts = [...readout.textContent!.matchAll(/([+−])₹(\d+\.\d) from/g)].map((m) => (m[1] === "−" ? -1 : 1) * Number(m[2]));
    expect(parts).toHaveLength(3);
    expect(parts[0]!).toBeLessThanOrEqual(0.05); // time decay: prices fall as the day passes
    expect(Math.abs(parts[2]!)).toBeLessThan(0.5); // the prices were made with one constant volatility, so the volatility part stays near zero
    const chart = screen.getByRole("img", { name: /^Change of the ATM straddle in every window/ });
    expect(chart.getAttribute("data-series")).toBe("Time decay|NIFTY moving|Volatility and the rest");
    const n = Number(chart.getAttribute("data-points")!.split(",")[0]);
    expect(n).toBeGreaterThan(5); // 40 minutes of samples in 5-minute windows
    expect(screen.getByTestId("pc-slider")).toHaveAttribute("max", String(n - 1));
    expect(screen.getByRole("img", { name: /^Change of each strike's straddle/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Running total/ })).toBeInTheDocument();
  });

  it("the slider (or a click on a window) moves the sentence to that window and Latest comes back", async () => {
    mockApi();
    await renderPage();
    const latest = (await screen.findByTestId("pc-time")).textContent;
    const slider = screen.getByTestId("pc-slider");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(screen.getByTestId("pc-time").textContent).not.toBe(latest);
    expect(screen.getByTestId("pc-readout").textContent).toContain(`At ${screen.getByTestId("pc-time").textContent}`);
    await userEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(screen.getByTestId("pc-time").textContent).toBe(latest);
    await userEvent.click(screen.getByTestId("pick-first-Change of th")); // a click on a bar picks that window
    expect(screen.getByTestId("pc-time").textContent).not.toBe(latest);
  });

  it("a longer window means fewer windows, and the choice is offered as a group of buttons", async () => {
    mockApi();
    await renderPage();
    const pts = () => Number(screen.getByRole("img", { name: /^Change of the ATM straddle in every window/ }).getAttribute("data-points")!.split(",")[0]);
    await screen.findByTestId("pc-readout");
    const five = pts();
    await userEvent.click(within(screen.getByRole("group", { name: "Window" })).getByRole("button", { name: "15 min" }));
    expect(pts()).toBeLessThan(five);
    expect(screen.getByTestId("pc-readout").textContent).toContain("in 15 minutes");
  });

  it("says plainly that the last part is a remainder, and that this is not a forecast", async () => {
    mockApi();
    await renderPage();
    const notes = await screen.findByTestId("pc-notes");
    expect(notes.textContent).toContain("a remainder");
    expect(notes.textContent).toContain("does not say which way premiums will go");
  });
});
