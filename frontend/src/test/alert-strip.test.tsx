import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertStrip } from "../components/AlertStrip";

function show(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AlertStrip /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("server alerts strip", () => {
  it("lists what the watchdog found and says when it checked", async () => {
    show({ available: true, checked_at: "2026-11-13T05:00:00+00:00", release: "f000296", alerts: [
      { key: "live-feed", level: "critical", text: "Market is open but the live feed is stale (last data 240 s ago)." },
      { key: "disk", level: "warning", text: "Disk is getting full: 2.2 GB free." },
    ] });
    const strip = await screen.findByTestId("alert-strip");
    expect(strip).toHaveTextContent("Needs attention");
    expect(strip).toHaveTextContent("live feed is stale");
    expect(strip).toHaveTextContent("2.2 GB free");
    expect(strip).toHaveTextContent("10:30");
  });

  it("is a heads-up, not an alarm, when every alert is a warning", async () => {
    show({ available: true, checked_at: "2026-11-13T05:00:00+00:00", release: null, alerts: [{ key: "backup", level: "warning", text: "The newest backup is 40 hours old." }] });
    expect(await screen.findByTestId("alert-strip")).toHaveTextContent("Heads up");
  });

  it("shows nothing when all is well, where no watchdog runs, or when the server cannot be asked", async () => {
    const a = show({ available: true, checked_at: "2026-11-13T05:00:00+00:00", release: null, alerts: [] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("alert-strip")).toBeNull();
    a.unmount();
    const b = show({ available: false, checked_at: null, release: null, alerts: [] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("alert-strip")).toBeNull();
    b.unmount();
    show({ detail: "down" }, 500);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("alert-strip")).toBeNull();
  });
});
