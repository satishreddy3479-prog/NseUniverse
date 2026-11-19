import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RangeSignalsCard } from "../components/intelligence/RangeSignals";

// 19 Nov 2026 at 09:55 as the engine reads it: opened 41 points below the previous close of 25,227.95, the range so far over 80 points, the opening range not yet broken.
const live = {
  available: true as const, session: "2026-11-19", as_of: "2026-11-19T04:25:00+00:00", live: true, stale: false, spot: 25161.2, premium: 301.3, prev_close: 25227.95, note: "What the day has done so far. It describes; it does not forecast.",
  minutes: 40, gap_pts: -41.3, gap_pct: -0.164, gap_ratio: 0.137, range_so_far: 82.5, range_ratio: 0.274, or_break: null, eff30: 0.41, acc: 1.35, premium_pct: 1.198,
};

function mount(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><RangeSignalsCard /></QueryClientProvider></MemoryRouter>);
}
afterEach(() => vi.unstubAllGlobals());

describe("range so far today", () => {
  it("shows the gap, the range as a multiple of the premium, the opening range state, efficiency and acceleration, with the as-of time and the caution", async () => {
    mount(live);
    expect(await screen.findByTestId("range-asof")).toHaveTextContent("session 2026-11-19");
    expect(screen.getByTestId("range-asof")).toHaveTextContent("it does not forecast");
    expect(screen.getByTestId("range-gap")).toHaveTextContent("−41 pts");
    expect(screen.getByTestId("range-gap")).toHaveTextContent("−0.16% of the previous close");
    expect(screen.getByTestId("range-so-far")).toHaveTextContent("83 pts");
    expect(screen.getByTestId("range-so-far")).toHaveTextContent("0.27 × the 301-point straddle");
    expect(screen.getByTestId("range-break")).toHaveTextContent("Inside");
    expect(screen.getByTestId("range-eff")).toHaveTextContent("0.41");
    expect(screen.getByTestId("range-acc")).toHaveTextContent("1.35×");
    expect(screen.getByTestId("range-prem")).toHaveTextContent("1.20% of NIFTY");
  });

  it("shows what was known before the open and the calendar, and says when either is not recorded (unknown, not empty)", async () => {
    const ctx = { recorded: true, moves: { gift: 0.4, es: -1, nq: null, brent: 0.2, dxy: null, usdinr: -0.1 }, events_known: true, events_today: [{ time: "13:30", country: "Euro area", name: "Flash PMI", forecast: "49.0", actual: null }], events_overnight: ["US: Retail Sales"] };
    const { unmount } = mount({ ...live, context: ctx });
    expect(await screen.findByTestId("range-context-moves")).toHaveTextContent("GIFT Nifty +0.40% · S&P 500 fut. −1.00% · Nasdaq fut. — · Brent +0.20%");
    expect(screen.getByTestId("range-context-events")).toHaveTextContent("Today: 13:30 Euro area Flash PMI. Overnight: US: Retail Sales.");
    unmount();
    mount({ ...live, context: { ...ctx, recorded: false, events_known: false, events_today: [], events_overnight: null } });
    expect(await screen.findByTestId("range-context-none")).toHaveTextContent("nothing is recorded for today yet");
    expect(screen.getByTestId("range-context-events-unknown")).toHaveTextContent("unknown here, not empty");
  });

  it("says Forming before 30 minutes, names a break, and shows dashes for what cannot be formed", async () => {
    mount({ ...live, minutes: 12, or_break: null, eff30: null, acc: null, gap_pts: null, gap_pct: null });
    expect(await screen.findByTestId("range-break")).toHaveTextContent("Forming");
    expect(screen.getByTestId("range-eff")).toHaveTextContent("—");
    expect(screen.getByTestId("range-gap")).toHaveTextContent("no previous close");
  });

  it("names a break of the opening range and a stale or stored session", async () => {
    mount({ ...live, or_break: "up", live: false, stale: true });
    expect(await screen.findByTestId("range-break")).toHaveTextContent("Broken upwards");
    expect(screen.getByTestId("range-asof")).toHaveTextContent("stored session, not live");
    expect(screen.getByTestId("range-asof")).toHaveTextContent("stale");
  });

  it("says why there is nothing to show, and shows an error instead of an empty card", async () => {
    mount({ available: false, reason: "No option-chain samples are stored yet." });
    expect(await screen.findByTestId("range-unavailable")).toHaveTextContent("No option-chain samples are stored yet.");
  });

  it("shows an error when the server fails", async () => {
    mount({ detail: "x" }, 503);
    expect(await screen.findByTestId("range-error")).toBeTruthy();
  });
});
