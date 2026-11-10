// The Events and news panel: the hourly headlines (with their fetch time) next to the daily tone. Numbers and titles are fixtures.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventsNewsPanel } from "../components/EventsNewsPanel";
import type { NewsStatus } from "../lib/types";

vi.mock("../components/PredictionViz", () => ({ EventTimeline: () => <div role="img" aria-label="timeline" /> }));
afterEach(() => vi.unstubAllGlobals());

const base: NewsStatus = {
  enabled: true, running: false, problems: [], source: "GDELT", not_used: "x", model_use: "Not used by the models",
  coverage: { first_day: "2026-10-29", last_day: "2026-11-10", days: 8, collecting_since: "2026-10-29T03:00:00Z", last_fetch: "2026-11-10T11:00:00Z" },
  themes: { india_markets: "Indian markets", oil: "Crude oil" },
  latest: { india_markets: [{ day: "2026-11-10", tone: -1.2, volume_pct: 0.13 }] },
  headlines: {
    india_markets: [{ title: "Nifty ends higher on banks", url: "https://example.com/a", domain: "example.com", seen_utc: "2026-11-10T10:30:00+00:00", fetched_utc: "2026-11-10T11:00:00+00:00" }],
    oil: [{ title: "Brent slips as stocks build", url: "https://example.org/b", domain: "example.org", seen_utc: "2026-11-10T09:30:00+00:00", fetched_utc: "2026-11-10T11:00:00+00:00" }],
  },
  headlines_fetched: "2026-11-10T11:00:00+00:00", headline_problems: [], headline_source: "GDELT DOC 2.0 article list (title, link, site and time seen only)",
};

function mount(news: unknown, events: unknown = { events: [] }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("news") ? news : events), { status: 200 })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EventsNewsPanel /></QueryClientProvider>);
}

describe("Latest headlines", () => {
  it("lists each theme's newest headlines as links with the site and the time seen, and says when they were fetched", async () => {
    mount(base);
    const box = await screen.findByTestId("news-headlines");
    const link = await within(box).findByRole("link", { name: "Nifty ends higher on banks" });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(box.textContent).toContain("example.com");
    expect(box.textContent).toContain("Brent slips as stocks build");
    expect(box.textContent).toContain("refreshed hourly, last fetched");
    expect(box.textContent).toContain("the models do not use news");
  });
  it("says plainly when no headline has been fetched yet and shows the last problem", async () => {
    mount({ ...base, headlines: {}, headlines_fetched: null, headline_problems: ["oil headlines: HTTP 429"] });
    const e = await screen.findByTestId("headlines-empty");
    expect(e.textContent).toContain("No headlines fetched yet");
    expect(e.textContent).toContain("oil headlines: HTTP 429");
  });
});
