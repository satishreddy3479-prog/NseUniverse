import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { ToolMenu } from "../components/ToolMenu";
import { expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

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
    "/api/global/overview": overview, "/api/global/series": { key: "ES", name: "S&P 500 futures", unit: "pts", decimals: 2, prev_close: 7480, times: ["2026-11-20T03:30:00Z", "2026-11-20T03:31:00Z", "2026-11-20T14:30:00Z"], prices: [7500, 7510, 7490] },
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    // the sheet sits directly in the page body, so no transformed or animated ancestor can pin it to the top of the page instead of the screen
    expect(dlg.parentElement?.parentElement).toBe(document.body);
    expect(await within(dlg).findByTestId("global-chart")).toBeInTheDocument();
    // 7500 -> 7490 is -10 (-0.13 %), high 7510, low 7490; one closure (09:01 to 20:00 IST) is cut out and counted
    const chart = within(dlg).getByTestId("global-chart");
    expect(chart).toHaveTextContent("−10.00 (−0.13%)");
    expect(chart).toHaveTextContent("High7,510.00");
    expect(chart).toHaveTextContent("Low7,490.00");
    expect(chart).toHaveTextContent("Closed periods1");
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

describe("the last two days of the calendar", () => {
  it("lists yesterday's and the day before's events with their actual outcome, and says when an actual never came", async () => {
    const withRecent = { ...calendar, sections: [...calendar.sections, { key: "recent", title: "Past 2 days: outcomes", events: [
      ev("y1", "Core CPI m/m", "2026-11-15T19:00:00+05:30", "released", { forecast: "0.3%", previous: "0.4%", actual: "0.5%" }),
      ev("y2", "Retail Sales m/m", "2026-11-14T19:00:00+05:30", "past", { forecast: "0.2%", previous: "0.1%" }),
      ev("y3", "FOMC Minutes", "2026-11-19T00:30:00+05:30", "past", {}),
    ] }] };
    mockApi({ "/api/calendar": withRecent });
    renderAt("/tools/economic-calendar");
    expect(await screen.findByText("Past 2 days: outcomes")).toBeInTheDocument();
    const row = screen.getByText("Core CPI m/m").closest("li")!;
    expect(row).toHaveTextContent("Reported");
    expect(row).toHaveTextContent("0.5%"); // the actual outcome
    expect(screen.getByText("Retail Sales m/m").closest("li")).toHaveTextContent("no actual value in the feed"); // missing stays missing
    expect(screen.getByText("FOMC Minutes").closest("li")).toHaveTextContent("a statement, not a figure"); // a text release is not a gap in the feed
  });
});

describe("the outcome of a release against its forecast", () => {
  const withOutcomes = () => ({ ...calendar, sections: [...calendar.sections, { key: "recent", title: "Past 2 days: outcomes", events: [
    ev("g", "GDP q/q", "2026-11-15T19:00:00+05:30", "released", { forecast: "2.1%", previous: "1.9%", actual: "2.5%", outcome: { status: "BEAT", label: "Beat", tone: "up", diff: 0.4, diff_text: "+0.4%" } }),
    ev("c", "PPI y/y", "2026-11-15T18:00:00+05:30", "released", { country: "India", forecast: "5.1%", previous: "5.0%", actual: "5.4%", outcome: { status: "HOT", label: "Hot", tone: "down", diff: 0.3, diff_text: "+0.3%" } }),
    ev("r", "Retail Sales m/m", "2026-11-14T19:00:00+05:30", "released", { forecast: "0.4%", actual: "0.1%", outcome: { status: "MISS", label: "Miss", tone: "down", diff: -0.3, diff_text: "-0.3%" } }),
    ev("n", "Fed Chair Speech", "2026-11-14T10:00:00+05:30", "released", { actual: "1" }),
  ] }] });
  it("shows Beat, Hot (inflation above forecast is not a beat) and Miss as badges with the difference, colours the actual, and says Reported when there is no forecast", async () => {
    mockApi({ "/api/calendar": withOutcomes() });
    renderAt("/tools/economic-calendar");
    const badge = (name: string) => within(screen.getByText(name).closest("li")!).queryByTestId("outcome-badge");
    expect(await screen.findByText("Past 2 days: outcomes")).toBeInTheDocument();
    expect(badge("GDP q/q")).toHaveTextContent("Beat +0.4%");
    expect(badge("PPI y/y")).toHaveTextContent("Hot +0.3%");
    expect(badge("Retail Sales m/m")).toHaveTextContent("Miss -0.3%");
    expect(badge("PPI y/y")!.className).toContain("text-down"); // hot inflation is red
    expect(within(screen.getByText("GDP q/q").closest("li")!).getByText("2.5%").className).toContain("text-up");
    expect(badge("Fed Chair Speech")).toBeNull();
    expect(screen.getByText("Fed Chair Speech").closest("li")).toHaveTextContent("Reported");
  });
  it("Reported outcomes shows only released events, Upcoming only the ones still to come, and the country buttons combine with them", async () => {
    mockApi({ "/api/calendar": withOutcomes() });
    renderAt("/tools/economic-calendar");
    await screen.findByText("Past 2 days: outcomes");
    const view = within(screen.getByRole("group", { name: "Which events" }));
    await userEvent.click(view.getByRole("button", { name: "Reported outcomes" }));
    expect(screen.getByText("GDP q/q")).toBeInTheDocument();
    expect(screen.queryByText("WPI y/y")).toBeNull(); // upcoming
    await userEvent.click(within(screen.getByRole("group", { name: "Country" })).getByRole("button", { name: "India" }));
    expect(screen.getByText("PPI y/y")).toBeInTheDocument();
    expect(screen.queryByText("GDP q/q")).toBeNull(); // a US release
    await userEvent.click(view.getByRole("button", { name: "Upcoming" }));
    expect(screen.getByText("WPI y/y")).toBeInTheDocument(); // India, upcoming
    expect(screen.queryByText("PPI y/y")).toBeNull();
  });
});

describe("calendar country filter", () => {
  it("shows All, India or US events and the next-event card follows the filter", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T00:00:00Z") }); // the sample events are on 16 to 19 Nov 2026: the card needs a clock before them
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
    vi.useRealTimers();
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

describe("India ADRs", () => {
  it("shows the US-listed Indian stocks with their dollar change and says what an ADR is not", async () => {
    // Infosys ADR on 18 Nov 2026: 11.78 against 12.07, -0.29 (-2.40%)
    const adr = { ...overview, groups: [{ key: "india_adr", title: "India ADRs and ETF (US-listed)", items: [{ key: "INFY", name: "Infosys ADR", unit: "$", decimals: 2, kind: "cash", core: false, yield: false, price: 11.78, change: -0.29, change_pct: -2.4026, prev_close: 12.07, status: "closed", age_s: 40000, spark: [12.0, 11.78], chart_url: "https://finance.yahoo.com/quote/INFY/" }] }] };
    mockApi({ "/api/global/overview": adr });
    renderAt("/tools/global-markets");
    const sec = await screen.findByRole("region", { name: "India ADRs and ETF (US-listed)" });
    expect(within(sec).getByText("Infosys ADR")).toBeInTheDocument();
    expect(within(sec).getByText(/11\.78/)).toBeInTheDocument();
    expect(within(sec).getByText(/−2\.40%|-2\.40%/)).toBeInTheDocument();
    expect(within(sec).getByTestId("adr-note")).toHaveTextContent("An ADR is not the NSE price");
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
