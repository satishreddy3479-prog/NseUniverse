import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertStrip } from "../components/AlertStrip";

function show(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AlertStrip /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

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

describe("closing the message", () => {
  const warn = { available: true, checked_at: "2026-11-13T05:00:00+00:00", release: null, alerts: [{ key: "holiday-list", level: "warning", text: "The NSE holiday list ends on 2026-12-31 (48 days)." }] };

  it("hides the alert with the cross and keeps it hidden after a reload", async () => {
    const a = show(warn);
    await userEvent.click(await screen.findByRole("button", { name: "Close this message" }));
    expect(screen.queryByTestId("alert-strip")).toBeNull();
    a.unmount();
    show(warn); // a fresh page load
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("alert-strip")).toBeNull();
  });

  it("brings a warning back after a day and a critical alert after an hour, and shows a different alert at once", async () => {
    const now = Date.now();
    localStorage.setItem("nse-universe.dismissed-alerts", JSON.stringify({ "holiday-list": now - 1000, backup: now + 3_600_000 }));
    show({ ...warn, alerts: [...warn.alerts, { key: "backup", level: "warning", text: "The newest backup is 40 hours old." }, { key: "disk", level: "critical", text: "Only 1.1 GB free." }] });
    const strip = await screen.findByTestId("alert-strip");
    expect(strip).toHaveTextContent("holiday list"); // its day is over
    expect(strip).toHaveTextContent("1.1 GB"); // never closed
    expect(strip).not.toHaveTextContent("40 hours"); // still closed
  });

  it("keeps a long message inside the strip on a phone: text wraps in one column beside a small cross", async () => {
    show(warn);
    const strip = await screen.findByTestId("alert-strip");
    expect(strip.querySelector("ul")!.className).toContain("break-words");
    expect(strip.querySelector("button")!.className).toContain("shrink-0");
  });
});
