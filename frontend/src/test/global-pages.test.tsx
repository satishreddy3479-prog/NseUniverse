import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { ToolMenu } from "../components/ToolMenu";
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
    { key: "tomorrow", title: "Tomorrow", events: [ev("w", "WPI y/y", "2026-11-17T12:00:00+05:30", "upcoming", { country: "India", impact: "medium", forecast: "7.46%", previous: "11.39%" })] },
    { key: "week", title: "Rest of this week", events: [ev("b", "FOMC Meeting Minutes", "2026-11-19T00:30:00+05:30", "upcoming")] },
    { key: "nextweek", title: "Next week", events: [] },
    { key: "month", title: "Later this month", events: [] },
  ],
  sources: [{ name: "Official calendar", last_ok: "2026-11-15T18:00:00+00:00", last_error: null }, { name: "Forex Factory public feed (unofficial)", last_ok: null, last_error: { errors: ["x"] } }],
};
const news = {
  generated_at: "2026-11-15T19:00:00+00:00",
  india: [{ id: "i1", title: "Sensex ends higher", link: "https://economictimes.indiatimes.com/a", summary: "Banks led.", source: "Economic Times", section: "Markets", published: "2026-11-15T18:00:00+00:00", age_min: 60, fetched: "2026-11-15T18:05:00+00:00", topics: ["NIFTY"] },
    { id: "i2", title: "Local fair opens", link: "https://economictimes.indiatimes.com/b", summary: "", source: "Economic Times", section: "Top stories", published: "2026-11-15T17:00:00+00:00", age_min: 120, fetched: "2026-11-15T17:05:00+00:00", topics: [] }],
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
    const wpi = within(screen.getByRole("region", { name: "Tomorrow" }));
    expect(wpi.getByText("WPI y/y")).toBeInTheDocument();
    expect(wpi.getByLabelText("Medium impact")).toHaveTextContent("★★☆"); // India's two-star release, shown with its own rating
    expect(within(today).getByLabelText("High impact")).toHaveTextContent("★★★");
    expect(within(screen.getByRole("region", { name: "Next week" })).getByText("Nothing scheduled.")).toBeInTheDocument();
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
    expect(screen.getAllByText("Economic Times", { selector: "span" }).length).toBe(2);
    expect(within(screen.getByRole("region", { name: "Global" })).getByText("No headlines stored yet.")).toBeInTheDocument();
  });
});

describe("news freshness", () => {
  it("marks headlines stored after the last visit as new, shows topic chips and can keep only market-moving topics", async () => {
    mockApi();
    localStorage.setItem("newsSeenAt", String(new Date("2026-11-15T17:30:00Z").getTime()));
    renderAt("/tools/market-news");
    const link = await screen.findByRole("link", { name: /Sensex ends higher/ });
    expect(within(link).getByText("New")).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: /Local fair opens/ })).queryByText("New")).toBeNull(); // stored before the last visit
    expect(screen.getByText("1 new since you last looked")).toBeInTheDocument();
    expect(within(link.closest("li")!).getByText("NIFTY")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Market-moving topics only/ }));
    expect(screen.queryByRole("link", { name: /Local fair opens/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Sensex ends higher/ })).toBeInTheDocument();
  });

  it("marks nothing as new on a first visit and says so", async () => {
    mockApi();
    renderAt("/tools/market-news");
    expect(await screen.findByText("First visit: nothing is marked new yet.")).toBeInTheDocument();
    expect(screen.queryByText("New")).toBeNull();
  });
});

describe("quick links", () => {
  it("open Moneycontrol's calendar and the Redbox squawk in a clean new tab from the calendar page, the news page and the Analyse menu", async () => {
    mockApi();
    renderAt("/tools/economic-calendar");
    const cal = await screen.findByRole("link", { name: /Open Moneycontrol Economic Calendar/ });
    expect(cal).toHaveAttribute("href", "https://www.moneycontrol.com/economic-calendar");
    expect(cal).toHaveAttribute("target", "_blank");
    expect(cal).toHaveAttribute("rel", "noopener noreferrer");
    const sq = screen.getByRole("link", { name: /Open Redbox India Live Squawk/ });
    expect(sq).toHaveAttribute("href", "https://x.com/REDBOXINDIA");
    expect(sq).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("quick links in the Analyse menu", () => {
  it("are listed under the Analyse tools only, not under FNO Tools, and are hidden while searching", async () => {
    const ui = (menu: "analyse" | "fno") => <MemoryRouter><ToolMenu menu={menu} onPick={() => {}} /></MemoryRouter>;
    const a = render(ui("analyse"));
    expect(screen.getByRole("link", { name: /Moneycontrol Economic Calendar/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /Redbox India Live Squawk/ })).toHaveAttribute("href", "https://x.com/REDBOXINDIA");
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a tool" }), "news");
    expect(screen.queryByTestId("quick-links")).toBeNull();
    a.unmount();
    render(ui("fno"));
    expect(screen.queryByTestId("quick-links")).toBeNull();
  });
});
