import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { expiries, status, summary } from "./fixtures";

// Values are the ones the backend tests hand-check from the captured Yahoo bars: ES 7583.00 against the 16:00 New York close 7616.25 (-33.25, -0.4366 %).
const overview = {
  generated_at: "2026-11-15T18:30:00+00:00",
  groups: [
    { key: "us_futures", title: "US index futures", items: [
      { key: "ES", name: "S&P 500 futures", unit: "pts", decimals: 2, kind: "future", core: true, yield: false, price: 7583, change: -33.25, change_pct: -0.4366, prev_close: 7616.25, status: "closed", age_s: purePast(), spark: [7600, 7590, 7583] },
      { key: "NQ", name: "Nasdaq 100 futures", unit: "pts", decimals: 2, kind: "future", core: true, yield: false, price: null, status: "no data" },
    ] },
    { key: "rates_fx", title: "Rates, dollar and currency", items: [
      { key: "US10Y", name: "US 10-year yield", unit: "%", decimals: 3, kind: "rate", core: true, yield: true, price: 5.154, change: 0.051, change_pct: 1, bp: 5.1, status: "closed", age_s: 100000, spark: [5.1, 5.15] },
    ] },
  ],
  meta: { source: "Yahoo Finance through the unofficial yfinance package", last_poll_ok: "2026-11-15T18:25:00+00:00", last_poll_age_s: 300, last_error: null, stale: false },
};
function purePast() { return 172800; }

const ev = (id: string, name: string, time: string, state: "upcoming" | "released" | "past", extra: object = {}) => ({
  id, time_ist: time, all_day: false, country: "US", name, impact: "high", actual: null, forecast: null, previous: null, source: "x", note: null, state, minutes_to: state === "upcoming" ? 600 : null, ...extra,
});
const calendar = {
  generated_at: "2026-11-15T19:00:00+00:00", today: "2026-11-16", note: "High-impact events only.", next: ev("a", "CPI m/m", "2026-11-16T19:00:00+05:30", "upcoming"),
  sections: [
    { key: "today", title: "Today", events: [ev("a", "CPI m/m", "2026-11-16T19:00:00+05:30", "upcoming", { forecast: "0.3%", previous: "0.4%" })] },
    { key: "tomorrow", title: "Tomorrow", events: [] },
    { key: "week", title: "Rest of this week", events: [ev("b", "FOMC Meeting Minutes", "2026-11-19T00:30:00+05:30", "upcoming")] },
    { key: "nextweek", title: "Next week", events: [] },
    { key: "month", title: "Later this month", events: [] },
  ],
  sources: [{ name: "Official calendar", last_ok: "2026-11-15T18:00:00+00:00", last_error: null }, { name: "Forex Factory public feed (unofficial)", last_ok: null, last_error: { errors: ["x"] } }],
};
const news = {
  generated_at: "2026-11-15T19:00:00+00:00",
  india: [{ id: "i1", title: "Sensex ends higher", link: "https://economictimes.indiatimes.com/a", summary: "Banks led.", source: "Economic Times", section: "Markets", published: "2026-11-15T18:00:00+00:00", age_min: 60 }],
  global: [], meta: { last_poll_ok: "2026-11-15T18:50:00+00:00", stale: false, last_error: null, sources: ["BBC News", "CNBC", "Economic Times"], note: "Headlines and the short summary." },
};

function mockApi() {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [],
    "/api/global/overview": overview, "/api/global/series": { key: "ES", name: "S&P 500 futures", unit: "pts", decimals: 2, times: [], prices: [] },
    "/api/calendar": calendar, "/api/news": news,
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined
      ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 })
      : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("global markets page", () => {
  it("shows each quote with its change from the stored close, its status and age, and says when there is no price", async () => {
    mockApi();
    renderAt("/tools/global-markets");
    const es = (await screen.findByText("S&P 500 futures", { selector: "span" })).closest("button")!;
    expect(within(es).getByText("7,583.00")).toBeInTheDocument();
    expect(within(es).getByText("−33.25 (−0.44%)")).toBeInTheDocument();
    expect(within(es).getByText("Closed")).toBeInTheDocument();
    expect(within(es).getByText(/Last price 2d ago/)).toBeInTheDocument();
    const nq = screen.getByText("Nasdaq 100 futures", { selector: "span" }).closest("button")!;
    expect(within(nq).getByText("No data")).toBeInTheDocument();
    expect(nq).toBeDisabled();
    const y = screen.getByText("US 10-year yield", { selector: "span" }).closest("button")!;
    expect(within(y).getByText("5.154%")).toBeInTheDocument();
    expect(within(y).getByText("+5.1 bp")).toBeInTheDocument(); // a yield moves in basis points, not percent of the yield
  });
});

describe("economic calendar page", () => {
  it("groups the three-star events by when, has no filter controls, and names its sources and what it does not read", async () => {
    mockApi();
    renderAt("/tools/economic-calendar");
    expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
    for (const t of ["Tomorrow", "Rest of this week", "Next week", "Later this month"]) expect(screen.getByRole("region", { name: t })).toBeInTheDocument();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByText("CPI m/m")).toBeInTheDocument();
    expect(within(today).getByText("19:00")).toBeInTheDocument();
    expect(within(today).getByText("0.3%")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tomorrow" })).getByText("Nothing high-impact scheduled.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/Moneycontrol is not used/)).toBeInTheDocument();
    expect(screen.getByText(/Forex Factory public feed \(unofficial\) \(could not be read\)/)).toBeInTheDocument();
  });
});

describe("news page", () => {
  it("lists India and Global headlines as links to the publisher with source and age, and an empty column says so", async () => {
    mockApi();
    renderAt("/tools/market-news");
    const link = await screen.findByRole("link", { name: "Sensex ends higher" });
    expect(link).toHaveAttribute("href", "https://economictimes.indiatimes.com/a");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText("Economic Times", { selector: "span" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Global" })).getByText("No headlines stored yet.")).toBeInTheDocument();
  });
});
