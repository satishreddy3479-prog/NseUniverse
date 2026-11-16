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
    { key: "india", title: "India pre-market", items: [
      { key: "GIFT", name: "GIFT Nifty futures", unit: "", decimals: 2, kind: "gift", core: true, yield: false, price: 25266, change: 94.5, change_pct: 0.3754, prev_close: 25171.5, status: "closed", age_s: 100000, spark: [25200, 25266], chart_url: "https://www.nseix.com/get-quotes", note: "Near-month contract, expires 23 Nov 2026. NSE IX website feed (unofficial endpoint)." },
    ] },
    { key: "us_futures", title: "US index futures", items: [
      { key: "ES", name: "S&P 500 futures", unit: "pts", decimals: 2, kind: "future", core: true, yield: false, price: 7583, change: -33.25, change_pct: -0.4366, prev_close: 7616.25, status: "closed", age_s: purePast(), spark: [7600, 7590, 7583], chart_url: "https://finance.yahoo.com/quote/ES%3DF/", delay_min: 10 },
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
    { key: "later", title: "Coming up", events: [ev("r", "RBI Interest Rate Decision", "2026-12-04T10:00:00+05:30", "upcoming", { country: "India", impact: "medium", previous: "5.50%" }), ev("c", "CPI y/y", "2026-11-12T16:00:00+05:30", "released", { country: "India", impact: "medium", actual: "6.08%", forecast: "5.90%", previous: "5.50%" })] },
  ],
  sources: [{ name: "Official calendar", last_ok: "2026-11-15T18:00:00+00:00", last_error: null }, { name: "Forex Factory public feed (unofficial)", last_ok: null, last_error: { errors: ["x"] } }],
};
const news = {
  generated_at: "2026-11-15T19:00:00+00:00",
  india: [{ id: "i1", title: "Sensex ends higher", link: "https://economictimes.indiatimes.com/a", summary: "Banks led.", source: "Economic Times", section: "Markets", published: "2026-11-15T18:00:00+00:00", age_min: 60, fetched: "2026-11-15T18:05:00+00:00", topics: ["NIFTY"] },
    { id: "i2", title: "Local fair opens", link: "https://economictimes.indiatimes.com/b", summary: "", source: "Economic Times", section: "Top stories", published: "2026-11-15T17:00:00+00:00", age_min: 120, fetched: "2026-11-15T17:05:00+00:00", topics: [] }],
  global: [], meta: { last_poll_ok: "2026-11-15T18:50:00+00:00", stale: false, last_error: null, sources: ["BBC News", "CNBC", "Economic Times"], note: "Headlines and the short summary." },
};

function mockApi(extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [],
    "/api/global/overview": overview, "/api/global/series": { key: "ES", name: "S&P 500 futures", unit: "pts", decimals: 2, times: [], prices: [] },
    "/api/calendar": calendar, "/api/news": news, ...extra,
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
    for (const t of ["Tomorrow", "Rest of this week", "Next week", "Later this month", "Coming up"]) expect(screen.getByRole("region", { name: t })).toBeInTheDocument();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByText("CPI m/m")).toBeInTheDocument();
    expect(within(today).getByText("19:00")).toBeInTheDocument();
    expect(within(today).getByText("0.3%")).toBeInTheDocument();
    const wpi = within(screen.getByRole("region", { name: "Tomorrow" }));
    expect(wpi.getByText("WPI y/y")).toBeInTheDocument();
    expect(wpi.getByLabelText("Medium impact")).toHaveTextContent("★★☆"); // India's two-star release, shown with its own rating
    expect(within(today).getByLabelText("High impact")).toHaveTextContent("★★★");
    expect(within(screen.getByRole("region", { name: "Next week" })).getByText("Nothing scheduled.")).toBeInTheDocument();
    // every event shows Previous, Forecast and Actual; a missing value says so instead of showing a zero
    const rbi = within(screen.getByRole("region", { name: "Coming up" }));
    const reads = within(rbi.getByText("RBI Interest Rate Decision").closest("li")!);
    expect(reads.getByText("5.50%")).toBeInTheDocument();
    expect(reads.getByText("Pending")).toBeInTheDocument(); // actual of an upcoming event
    expect(reads.getAllByText("—").length).toBe(1); // forecast not published
    const cpi = within(rbi.getByText("CPI y/y").closest("li")!);
    expect(cpi.getByText("6.08%")).toBeInTheDocument();
    expect(cpi.getByText("above forecast")).toBeInTheDocument();
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
    expect(screen.getByText(/^1 new since you last looked/)).toBeInTheDocument();
    expect(within(link.closest("li")!).getByText("NIFTY")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Market-moving topics only/ }));
    expect(screen.queryByRole("link", { name: /Local fair opens/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Sensex ends higher/ })).toBeInTheDocument();
  });

  it("marks nothing as new on a first visit and says so", async () => {
    mockApi();
    renderAt("/tools/market-news");
    expect(await screen.findByText(/^First visit: nothing is marked new yet\./)).toBeInTheDocument();
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

describe("global board charts", () => {
  it("opens the chart in the page (full screen on a phone) with 1D, 3D and 7D, closes with the button or Escape, and keeps a link to the symbol at its source", async () => {
    mockApi();
    renderAt("/tools/global-markets");
    const view = (await screen.findAllByRole("button", { name: "View chart" }))[1]!; // India pre-market comes first, then the US futures: the second is S&P 500
    await userEvent.click(view);
    const dlg = screen.getByRole("dialog", { name: "S&P 500 futures chart" });
    expect(within(dlg).getByText("7,583.00")).toBeInTheDocument();
    const src = within(dlg).getByRole("link", { name: /Open at source/ });
    expect(src).toHaveAttribute("href", "https://finance.yahoo.com/quote/ES%3DF/");
    expect(src).toHaveAttribute("target", "_blank");
    expect(src).toHaveAttribute("rel", "noopener noreferrer");
    const range = within(dlg).getByRole("group", { name: "Range" });
    expect(within(range).getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(range).getByRole("button", { name: "3D" }));
    expect(within(range).getByRole("button", { name: "3D" })).toHaveAttribute("aria-pressed", "true");
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/global/series?symbol=ES&hours=24"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/global/series?symbol=ES&hours=72"))).toBe(true);
    await userEvent.click(within(dlg).getByRole("button", { name: "Close chart" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click((await screen.findAllByRole("button", { name: "View chart" }))[1]!);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("every card also links to its page at the original source in a new tab, and GIFT Nifty shows its contract and source", async () => {
    mockApi();
    renderAt("/tools/global-markets");
    const es = await screen.findByRole("link", { name: "Open S&P 500 futures at its source" });
    expect(es).toHaveAttribute("href", "https://finance.yahoo.com/quote/ES%3DF/");
    expect(es).toHaveAttribute("target", "_blank");
    expect(es).toHaveAttribute("rel", "noopener noreferrer");
    const gift = screen.getByRole("link", { name: "Open GIFT Nifty futures at its source" });
    expect(gift).toHaveAttribute("href", "https://www.nseix.com/get-quotes");
    const card = gift.closest("div")!.parentElement!;
    expect(within(card).getByText("25,266.00")).toBeInTheDocument();
    expect(within(card).getByText(/expires 23 Nov 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Nasdaq 100 futures at its source" })).toBeNull(); // no link was given for a symbol without one
  });
});

describe("calendar country filter", () => {
  it("shows All, India or US events and the next-event card follows the filter", async () => {
    mockApi();
    renderAt("/tools/economic-calendar");
    expect((await screen.findAllByText("CPI m/m")).length).toBeGreaterThan(0);
    const group = screen.getByRole("group", { name: "Country" });
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "India" }));
    expect(screen.queryAllByText("CPI m/m")).toHaveLength(0); // a US event
    expect(within(screen.getByRole("region", { name: "Tomorrow" })).getByText("WPI y/y")).toBeInTheDocument();
    expect(screen.getByText("RBI Interest Rate Decision")).toBeInTheDocument();
    const next = within(screen.getByRole("region", { name: "Next event" }));
    expect(next.getByText("Next event · India")).toBeInTheDocument();
    expect(next.getByText("WPI y/y")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "US" }));
    expect(screen.queryAllByText("WPI y/y")).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Today" })).getByText("CPI m/m")).toBeInTheDocument();
    expect(screen.getByText("FOMC Meeting Minutes")).toBeInTheDocument();
  });
});

describe("delayed feeds", () => {
  it("shows a live future with its source delay instead of calling it stale", async () => {
    const live = { ...overview, groups: [{ key: "us_futures", title: "US index futures", items: [{ ...overview.groups[1]!.items[0]!, status: "live", age_s: 560, delay_min: 10 }] }] };
    mockApi({ "/api/global/overview": live });
    renderAt("/tools/global-markets");
    expect(await screen.findByText("Live · 10 min delay")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).toBeNull();
  });
});

describe("news read marks", () => {
  const link = (name: RegExp) => screen.findByRole("link", { name });
  const stored = () => JSON.parse(localStorage.getItem("nse-universe.news-read") ?? "{}") as Record<string, number>;

  it("opening a headline marks it read, dims it and removes its New badge; the mark survives a reload", async () => {
    mockApi();
    localStorage.setItem("newsSeenAt", String(new Date("2026-11-15T17:30:00Z").getTime()));
    const first = renderAt("/tools/market-news");
    const a = await link(/Sensex ends higher/);
    expect(a.closest("li")).toHaveAttribute("data-read", "false");
    expect(within(a).getByText("New")).toBeInTheDocument();
    expect(screen.getByText(/· 2 unread of 2/)).toBeInTheDocument();
    a.addEventListener("click", (e) => e.preventDefault()); // jsdom does not navigate; the page's own handler still runs
    await userEvent.click(a);
    expect(a.closest("li")).toHaveAttribute("data-read", "true");
    expect(within(a).queryByText("New")).toBeNull();
    expect(screen.getByText(/· 1 unread of 2/)).toBeInTheDocument();
    expect(Object.keys(stored())).toEqual(["i1"]);
    first.unmount();
    renderAt("/tools/market-news");
    expect((await link(/Sensex ends higher/)).closest("li")).toHaveAttribute("data-read", "true"); // remembered in this browser
  });

  it("a headline can be marked read and unread with its button, and the text of the button follows", async () => {
    mockApi();
    renderAt("/tools/market-news");
    const mark = await screen.findByRole("button", { name: "Mark as read: Local fair opens" });
    await userEvent.click(mark);
    const li = screen.getByRole("link", { name: /Local fair opens/ }).closest("li")!;
    expect(li).toHaveAttribute("data-read", "true");
    const undo = within(li).getByRole("button", { name: "Mark as unread: Local fair opens" });
    expect(undo).toHaveTextContent("Mark unread");
    await userEvent.click(undo);
    expect(li).toHaveAttribute("data-read", "false");
    expect(stored()).toEqual({});
  });

  it("Mark all as read, Hide read, and an empty column that says why it is empty", async () => {
    mockApi();
    renderAt("/tools/market-news");
    await link(/Sensex ends higher/);
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(screen.getByText(/· 0 unread of 2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
    expect(Object.keys(stored()).sort()).toEqual(["i1", "i2"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Hide read" }));
    expect(screen.queryByRole("link", { name: /Sensex ends higher/ })).toBeNull();
    expect(within(screen.getByRole("region", { name: "India" })).getByText("Nothing to show with these filters.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Global" })).getByText("No headlines stored yet.")).toBeInTheDocument(); // genuinely empty, not filtered
  });

  it("read marks older than a week are dropped", async () => {
    mockApi();
    const old = Date.now() - 8 * 24 * 3_600_000;
    localStorage.setItem("nse-universe.news-read", JSON.stringify({ gone: old, i2: Date.now() }));
    renderAt("/tools/market-news");
    expect((await link(/Local fair opens/)).closest("li")).toHaveAttribute("data-read", "true");
    expect(screen.getByText(/· 1 unread of 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark as read: Sensex ends higher" }));
    expect(Object.keys(stored()).sort()).toEqual(["i1", "i2"]); // the old one is gone from storage
  });
});
