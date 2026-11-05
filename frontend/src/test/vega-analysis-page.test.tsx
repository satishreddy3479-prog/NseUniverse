// The Vega Analysis tool page, rendered from option prices generated with Black-76 (formula checks, not market data):
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
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/tools/vega-analysis"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const num = (el: HTMLElement) => Number(el.textContent);
describe("Vega Analysis page", () => {
  it("shows the six cards for the ATM window: ATM vega is about 10 rupees per volatility point, calls and puts alike", async () => {
    mockApi();
    renderPage();
    const cards = within(await screen.findByTestId("vega-cards"));
    const ce = num(cards.getByText("CE vega").nextElementSibling as HTMLElement);
    const pe = num(cards.getByText("PE vega").nextElementSibling as HTMLElement);
    // hand check: vega = F * phi(d1) * sqrt(T) / 100; 24 050, 15 % volatility, about 1 day left: roughly 24050 * 0.399 * 0.052 / 100 = 5; the solver, not this estimate, is under test
    expect(ce).toBeGreaterThan(3); expect(ce).toBeLessThan(12);
    expect(Math.abs(ce - pe)).toBeLessThan(0.05); // call and put vega of the same strike agree (put-call parity)
    expect(cards.getByText("balanced")).toBeInTheDocument();
    for (const l of ["Average vega", "Vega skew", "Vega regime", "Vega rank"]) expect(cards.getByText(l)).toBeInTheDocument();
    expect(cards.getByText("not enough stored history")).toBeInTheDocument(); // 40 samples of one session: the percentile waits for 30 in the window, regime says so below
  });

  it("charts price, call vega and put vega, with CE − PE bars and the notes on axes", async () => {
    mockApi();
    renderPage();
    const chart = await screen.findByRole("img", { name: "Call vega, put vega and NIFTY through the session" });
    expect(chart.getAttribute("data-series")).toBe("Price|Call Vega|Put Vega");
    expect(screen.getByRole("img", { name: "Call vega minus put vega" })).toBeInTheDocument();
    expect(screen.getByTestId("vega-axes")).toHaveTextContent("Right axis: vega in rupees per volatility point per unit");
    await userEvent.click(screen.getByRole("button", { name: "Run avg" }));
    await userEvent.click(screen.getByRole("button", { name: "Daily range" }));
    expect(screen.getByRole("img", { name: "Call vega, put vega and NIFTY through the session" }).getAttribute("data-series")).toBe("Price|Call Vega|Put Vega|Running average|Day high (avg)|Day low (avg)");
    await userEvent.click(screen.getByRole("button", { name: "CE−PE" }));
    expect(screen.queryByRole("img", { name: "Call vega minus put vega" })).toBeNull();
  });

  it("replays the session: the slider moves the cards back in time and Play runs forward from there", async () => {
    mockApi();
    renderPage();
    const slider = (await screen.findByRole("slider", { name: "Replay time" })) as HTMLInputElement;
    const last = Number(slider.max);
    expect(last).toBeGreaterThan(3); // 40 minutes in 5-minute candles
    expect(Number(slider.value)).toBe(last);
    const points = () => Number(screen.getByRole("img", { name: "Call vega, put vega and NIFTY through the session" }).getAttribute("data-points")!.split(",")[0]);
    expect(points()).toBe(last + 1);
    fireEvent.change(slider, { target: { value: "2" } });
    expect(points()).toBe(3); // only what had happened by then is drawn
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("shows the vega change of the anchored band from a baseline, starting at zero, latest first", async () => {
    mockApi();
    renderPage();
    const table = within(await screen.findByTestId("vega-change-table"));
    const rows = table.getAllByRole("row").slice(1);
    const first = rows[rows.length - 1]!; // the baseline sample is the oldest row
    expect(first).toHaveTextContent("02 Nov 26, 9:20 am");
    expect(first).toHaveTextContent("+0.00");
    expect(screen.getByTestId("vega-change-note")).toHaveTextContent("1st (09:20)");
    expect(within(screen.getByRole("region", { name: "Vega change" })).getByRole("combobox", { name: "Strikes per side" })).toHaveValue("21");
    await userEvent.click(screen.getByRole("checkbox", { name: /Normalized/ }));
    expect(screen.getByTestId("vega-change-note")).toHaveTextContent("percentage of the band's vega at the baseline");
  });

  it("explains the readings and the limits of the history", async () => {
    mockApi();
    renderPage();
    const ins = within(await screen.findByTestId("vega-insights"));
    expect(ins.getByText(/Not enough stored history/)).toBeInTheDocument();
    expect(ins.getByText(/Balanced: call and put vega differ by less than 1%/)).toBeInTheDocument();
    expect(ins.getByText(/not a forecast that volatility will rise or fall/)).toBeInTheDocument();
    expect(within(screen.getByTestId("vega-stats")).getByText("Call options (CE)")).toBeInTheDocument();
  });
});
