import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadsUpStrip, inText } from "../components/HeadsUp";

const NOW = new Date("2026-12-01T05:00:00Z").getTime();
const body = (over: object = {}) => ({
  generated_at: "2026-12-01T05:00:00+00:00",
  reminders: [{ key: "bq:1:d3", event_id: "bq:1", phase: "d3", name: "RBI Interest Rate Decision", country: "India", impact: "high", time_ist: "2026-12-04T10:00:00+05:30", minutes_to: 4290, previous: "5.50%", forecast: null }],
  news: [{ key: "n1", title: "RBI keeps repo rate unchanged", link: "https://economictimes.indiatimes.com/a", source: "Economic Times", topics: ["RBI"], age_min: 12 }],
  ...over,
});

let payload: unknown;
function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => (payload === null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><HeadsUpStrip /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("heads up strip", () => {
  it("counts down in plain words", () => {
    expect(inText(4290)).toBe("in 3 days");
    expect(inText(1440)).toBe("in 1 day");
    expect(inText(200)).toBe("in 3 h 20 min");
    expect(inText(40)).toBe("in 40 min");
    expect(inText(1)).toBe("starting now");
  });

  it("shows the reminder with its time, previous and forecast and the fresh headline, with links", async () => {
    payload = body();
    mount();
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).getByRole("link", { name: "RBI Interest Rate Decision" })).toHaveAttribute("href", "/tools/economic-calendar");
    expect(within(strip).getByText("in 3 days")).toBeInTheDocument();
    expect(within(strip).getByText(/Fri, 4 Dec, 10:00 IST · Previous 5.50% · Forecast —/)).toBeInTheDocument();
    const news = within(strip).getByRole("link", { name: "RBI keeps repo rate unchanged" });
    expect(news).toHaveAttribute("href", "https://economictimes.indiatimes.com/a");
    expect(news).toHaveAttribute("target", "_blank");
    expect(news).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(strip).getByText("12 min ago", { exact: false })).toBeInTheDocument();
  });

  it("closing hides what is shown, and the next reminder phase of the same event or a new headline shows again", async () => {
    payload = body();
    const first = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Close heads up" }));
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
    first.unmount();
    // a reload the same day: still closed
    mount();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
    // the next phase (d2) of the same event, and a different headline
    payload = body({
      reminders: [{ key: "bq:1:d2", event_id: "bq:1", phase: "d2", name: "RBI Interest Rate Decision", country: "India", impact: "high", time_ist: "2026-12-04T10:00:00+05:30", minutes_to: 2850, previous: "5.50%", forecast: "5.25%" }],
      news: [],
    });
    mount();
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).getByText(/Forecast 5.25%/)).toBeInTheDocument();
  });

  it("shows nothing when there is nothing to say, when the event has started, or when the endpoint is unavailable", async () => {
    payload = body({ reminders: [], news: [] });
    const a = mount();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
    a.unmount();
    payload = body({ reminders: [{ key: "x:final", event_id: "x", phase: "final", name: "Started event", country: "US", impact: "high", time_ist: "2026-12-01T10:00:00+05:30", minutes_to: -5, previous: null, forecast: null }], news: [] });
    const b = mount();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Started event")).toBeNull(); // 10:00 IST is 04:30 UTC, already past
    b.unmount();
    payload = null;
    mount();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
  });

  it("shows the managed-trade messages (stop, entry, waiting for volume) with their page link, even with no calendar or news, and closing hides them", async () => {
    const alerts = [
      { key: "strategy:a:1", source: "strategy", kind: "stop", level: "bad", title: "Stop loss hit", text: "10:17:15 Stop: SELL 25300 CE closed at 122.05", at: "2026-12-01T04:47:15+00:00", link: "/strategy" },
      { key: "swing-min:7", source: "swing", kind: "waiting_volume", level: "warn", title: "ABC: triggered, waiting for volume", text: "Volume 40% of the pace needed.", at: "2026-12-01T04:50:00+00:00", link: "/swing" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("headsup/trades") ? { generated_at: "x", alerts } : { generated_at: "x", reminders: [], news: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><HeadsUpStrip /></MemoryRouter></QueryClientProvider>);
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).getByRole("link", { name: "Stop loss hit" })).toHaveAttribute("href", "/strategy");
    expect(within(strip).getByRole("link", { name: "ABC: triggered, waiting for volume" })).toHaveAttribute("href", "/swing");
    expect(within(strip).getByText(/Strategy · 10:17 IST · 10:17:15 Stop: SELL 25300 CE closed at 122.05/)).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Close heads up" }));
    expect(screen.queryByRole("region", { name: "Heads up" })).toBeNull();
  });
  it("tells the owner that a data bundle is ready, with a link to the page that downloads it", async () => {
    const alerts = [{ key: "library|ready|b.zip|2026-W48", source: "library", kind: "bundle_ready", level: "warn", title: "Data bundle ready: download it", text: "2026-10-28 to 2026-11-26, 24 days, 38 MB. Download it on the Data page (Data library): the server then deletes it and those days' snapshot files, and keeps the archive and the database.", at: "2026-11-27T14:00:00+00:00", link: "/data" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("headsup/trades") ? { generated_at: "x", alerts } : { generated_at: "x", reminders: [], news: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><HeadsUpStrip /></MemoryRouter></QueryClientProvider>);
    const strip = await screen.findByRole("region", { name: "Heads up" });
    expect(within(strip).getByRole("link", { name: "Data bundle ready: download it" })).toHaveAttribute("href", "/data");
    expect(within(strip).getByText(/Data library · 19:30 IST · 2026-10-28 to 2026-11-26, 24 days, 38 MB/)).toBeInTheDocument();
  });
});
