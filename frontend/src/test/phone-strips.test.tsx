// The notice strips on a phone: the same alert repeated is one line, a long list shows three lines and "Show all", and a long ops alert is clamped on a phone.
// Values are the real 20 Nov 2026 strips (three GCSL alerts, two rupee headlines, the holiday-list alert).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldPrefetch } from "../App";
import { AlertStrip } from "../components/AlertStrip";
import { groupTrades, HeadsUpStrip } from "../components/HeadsUp";
import type { HeadsUpTradeAlert } from "../lib/api";

const T = (key: string, at: string, text: string): HeadsUpTradeAlert => ({ key, source: "swing", kind: "gcsl", level: "warn", title: "GCSL: triggered, waiting for volume", link: "/swing", at, text });
const gcsl = [
  T("g1", "2026-11-20T04:04:00Z", "volume is 22% of the pace needed (profile)"), // 09:34 IST
  T("g2", "2026-11-20T04:06:00Z", "volume is 22% of the pace needed (profile)"), // 09:36
  T("g3", "2026-11-20T05:35:00Z", "volume is 37% of the pace needed (profile)"), // 11:05
];
const news = (k: string, title: string, age: number) => ({ key: k, title, link: "https://example.test/" + k, source: "Economic Times", topics: ["Rupee"], age_min: age });

function mount(el: React.ReactElement, routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response("{}", { status: 404 });
  }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T05:40:00Z").getTime() }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("notice strips", () => {
  it("the same alert raised three times is one line: the newest, with how many times and since when", () => {
    const g = groupTrades(gcsl);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: "g3", count: 3, first: "2026-11-20T04:04:00Z", keys: ["g1", "g2", "g3"], text: "volume is 37% of the pace needed (profile)" });
    const other = groupTrades([...gcsl, { ...T("s1", "2026-11-20T05:00:00Z", "x"), source: "strategy", title: "Stop hit" }]);
    expect(other.map((x) => x.title)).toEqual(["GCSL: triggered, waiting for volume", "Stop hit"]); // newest first, different alerts stay apart
  });

  it("shows three lines and a Show all button, then all of them", async () => {
    mount(<HeadsUpStrip />, {
      "/api/headsup/trades": { alerts: gcsl },
      "/api/global/headsup": { generated_at: "2026-11-20T05:40:00+00:00", reminders: [], news: [news("n1", "Rupee tops 93 vs USD", 31), news("n2", "Rupee strengthens 17 paise", 46), news("n3", "Oil slips", 50)] },
    });
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).getAllByTestId("headsup-trade")).toHaveLength(1); // one GCSL line, not three
    expect(within(strip).getByText(/3 times since 09:34 IST/)).toBeInTheDocument();
    expect(within(strip).queryByRole("link", { name: "Oil slips" })).toBeNull(); // the fourth line is folded away
    fireEvent.click(within(strip).getByTestId("headsup-more"));
    expect(within(strip).getByRole("link", { name: "Oil slips" })).toBeInTheDocument();
    expect(within(strip).getByTestId("headsup-more")).toHaveTextContent("Show fewer");
  });

  it("a few lines show no button, and closing hides every repeat of a grouped alert", async () => {
    mount(<HeadsUpStrip />, { "/api/headsup/trades": { alerts: gcsl }, "/api/global/headsup": { generated_at: "x", reminders: [], news: [] } });
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).queryByTestId("headsup-more")).toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "Close heads up" }));
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
    const kept = JSON.parse(localStorage.getItem("nse-universe.dismissed-headsup") ?? "{}") as Record<string, number>;
    expect(Object.keys(kept).sort()).toEqual(["g1", "g2", "g3"]); // all three keys, so the earlier ones do not come back as a new line
  });

  it("a long ops alert is clamped with a More button (the holiday-list alert was seven lines of a phone screen)", async () => {
    const text = "The NSE holiday list ends on 2026-12-31 (41 days). Open Settings > Exchange holidays and paste the new year's NSE holiday circular (NSE publishes it in December); after that date holidays would be treated as normal weekdays.";
    mount(<AlertStrip />, { "/api/ops/alerts": { checked_at: "2026-11-20T05:37:48Z", alerts: [{ key: "holiday-list", level: "warning", text }] } });
    const strip = await screen.findByTestId("alert-strip");
    const more = within(strip).getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(strip.querySelector(".line-clamp-3")).not.toBeNull();
    fireEvent.click(more);
    expect(within(strip).getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    expect(strip.querySelector(".line-clamp-3")).toBeNull();
  });

  it("a short ops alert has no button", async () => {
    mount(<AlertStrip />, { "/api/ops/alerts": { checked_at: "2026-11-20T05:37:48Z", alerts: [{ key: "disk", level: "warning", text: "Disk is getting full: 2.9 GB free." }] } });
    const strip = await screen.findByTestId("alert-strip");
    expect(within(strip).queryByRole("button", { name: "More" })).toBeNull();
  });
});

describe("one row on a phone", () => {
  it("the heads up strip folds to one row with a count until tapped (class max-sm:hidden; sm and up always show it)", async () => {
    mount(<HeadsUpStrip />, {
      "/api/headsup/trades": { alerts: gcsl },
      "/api/global/headsup": { generated_at: "2026-11-20T05:40:00+00:00", reminders: [], news: [news("n1", "Rupee tops 93 vs USD", 31), news("n2", "Rupee strengthens 17 paise", 46)] },
    });
    const toggle = await screen.findByTestId("headsup-toggle");
    expect(toggle).toHaveTextContent("3 items · show"); // one grouped GCSL line and two headlines
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("headsup-body").className).toContain("max-sm:hidden");
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Hide");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("headsup-body").className).not.toContain("max-sm:hidden");
  });

  it("an ops alert folds the same way, but a critical one is never folded and has no toggle", async () => {
    const warn = { key: "holiday-list", level: "warning", text: "The NSE holiday list ends on 2026-12-31 (41 days)." };
    const { unmount } = mount(<AlertStrip />, { "/api/ops/alerts": { checked_at: "2026-11-20T05:37:48Z", alerts: [warn] } });
    const toggle = await screen.findByTestId("alert-toggle");
    expect(toggle).toHaveTextContent("1 alert · show");
    expect(screen.getByTestId("alert-list").className).toContain("max-sm:hidden");
    fireEvent.click(toggle);
    expect(screen.getByTestId("alert-list").className).not.toContain("max-sm:hidden");
    unmount();
    mount(<AlertStrip />, { "/api/ops/alerts": { checked_at: "2026-11-20T05:37:48Z", alerts: [{ key: "live-feed", level: "critical", text: "Market is open but the live feed is stale." }, warn] } });
    const list = await screen.findByTestId("alert-list");
    expect(list.className).not.toContain("max-sm:hidden");
    expect(screen.queryByTestId("alert-toggle")).toBeNull();
  });
});

describe("page warm-up", () => {
  it("is skipped on a data saver, mobile data and 2g or 3g, and runs on wifi, ethernet or when the browser does not say", () => {
    expect(shouldPrefetch(undefined)).toBe(true);
    expect(shouldPrefetch({ effectiveType: "4g", type: "wifi" })).toBe(true);
    expect(shouldPrefetch({ effectiveType: "4g" })).toBe(true);
    expect(shouldPrefetch({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(shouldPrefetch({ effectiveType: "4g", type: "cellular" })).toBe(false);
    expect(shouldPrefetch({ effectiveType: "3g" })).toBe(false);
    expect(shouldPrefetch({ effectiveType: "slow-2g" })).toBe(false);
  });
});
