// The 1-minute shadow book panel: shows exactly what the backend returned, says plainly when nothing exists, and never offers an order button.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwingMinutePanel, eventText } from "../components/swing/SwingMinutePanel";
import type { MinuteView } from "../lib/swingMinute";

afterEach(() => vi.unstubAllGlobals());

const base = (over: Partial<MinuteView> = {}): MinuteView => ({
  mode: "shadow", enabled: true, rules: ["Entry: a 1-minute candle closes at or above the trigger", "Stop: a candle close at or below the stop"], market_open: true, session: "2026-11-12", volume_basis: "profile",
  expected_share_of_day_now: 0.2, profile_ready: true,
  book: { cash: 800_000, equity: 1_002_000, capital: 1_000_000, open: 1, closed: 1, slots: 5, realised_pnl: -9_900, unrealised_pnl: 1_200 },
  positions: [{ id: 1, symbol: "AAA", session: "2026-11-12", fill: 100.7, shares: 1986, initial_sl: 97, tsl: 100.7, hh_close: 107, last_price: 105, last_at: "2026-11-12T05:00:00Z", filled_at: "2026-11-12T04:31:00Z", r_now: 1.16, stage: "breakeven", unrealized_pnl: 8500, evidence: "signal evidence" }],
  watching: [
    { symbol: "AAA", rank: 1, score: 70, trigger: 100.3, stop: 97, max_open: 102.5, min_volume: 1_000_000, state: "signal", note: "close 100.50 at or above the trigger", pace: 1.25, last_close: 100.5 },
    { symbol: "BBB", rank: 2, score: 66, trigger: 200, stop: 190, max_open: 205, min_volume: 500_000, state: "volume_short", note: "volume is 75% of the pace needed (profile)", pace: 0.75, last_close: 200.4 },
  ],
  recent_closed: [{ id: 2, symbol: "CCC", session: "2026-11-11", fill: 50, shares: 100, filled_at: "2026-11-11T04:00:00Z", exit_at: "2026-11-11T09:40:00Z", exit_price: 48.5, exit_reason: "D1_FAIL_CLOSE", exit_basis: "next open", gross_pnl: -150, costs: 15, pnl: -165, evidence: "x" }],
  events: [{ id: 5, at: "2026-11-12T04:31:00Z", symbol: "AAA", kind: "entry_fill", price: 100.7, detail: { shares: 1986, trigger: 100.3, stop: 97 } }, { id: 4, at: "2026-11-12T04:30:00Z", symbol: "BBB", kind: "entry_state", price: 200.4, detail: { state: "volume_short", note: "volume is 75% of the pace needed (profile)" } }],
  comparisons: [{ session: "2026-11-11", at: "x", entries: [{ symbol: "AAA", rank: 1, official: "filled 100.30 x 1990", shadow: "filled 100.70 x 1986 at 10:01", official_filled: true, shadow_filled: true, same: true, fill_diff_pct: 0.4, states: ["signal"] },
    { symbol: "BBB", rank: 2, official: "skipped: volume below the minimum", shadow: "no entry (last reading: volume_short)", official_filled: false, shadow_filled: false, same: true, fill_diff_pct: null, states: ["volume_short"] }],
    exits: [{ symbol: "ZZZ", official: "STOP at 96.00", shadow: null, shadow_took_it: false, exit_diff_pct: null }], summary: { orders: 2, both_filled: 1, only_official: 0, only_shadow: 0, neither: 1, exits_compared: 1 } }],
  data: { symbols_with_bars: 2, bars_today: 80, expected_bars_per_symbol: 45, coverage: { AAA: 100, BBB: 98 }, last_poll_at: "2026-11-12T05:00:00Z", note: "Candles are built from prices polled every 2 seconds; a minute without a poll has no candle (nothing is filled in)." },
  windows: { entry_from: "09:30", entry_until: "15:00", day1_check: "15:20" }, updated_at: "2026-11-12T05:00:00Z", ...over,
});

function mount(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SwingMinutePanel /></QueryClientProvider>);
}

describe("1-minute shadow book panel", () => {
  it("says it is shadow-only and lists the rules", async () => {
    mount(base());
    expect((await screen.findByTestId("minute-badge")).textContent).toContain("no orders");
    await screen.findByTestId("minute-stats"); // the rules arrive with the data
    expect(screen.getByTestId("minute-note").textContent).toContain("never places an order");
    expect(screen.getByTestId("minute-note").textContent).toContain("Entry: a 1-minute candle closes");
    expect(screen.queryByRole("button", { name: /buy|sell|order|place/i })).toBeNull(); // nothing on this panel can place an order
  });

  it("shows the book, the watched orders with their reading, and the shadow positions", async () => {
    mount(base());
    const stats = await screen.findByTestId("minute-stats");
    expect(stats.textContent).toContain("10,02,000"); // Indian digit grouping
    expect(stats.textContent).toContain("1 / 5");
    const rows = screen.getAllByTestId("minute-watch-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Signal");
    expect(rows[1]!.textContent).toContain("Volume short");
    expect(rows[1]!.textContent).toContain("75%");
    const pos = screen.getByTestId("minute-pos-row");
    expect(pos.textContent).toContain("breakeven");
    expect(pos.textContent).toContain("1.16");
    expect(screen.getByTestId("minute-data").textContent).toContain("recorded stock volume profile");
  });

  it("describes events and closed trades in words", async () => {
    mount(base());
    const ev = await screen.findAllByTestId("minute-event");
    expect(ev[0]!.textContent).toContain("Entry fill");
    expect(ev[0]!.textContent).toContain("1986 shares at the next candle's open");
    expect(within(screen.getByTestId("minute-closed")).getByText("D1_FAIL_CLOSE")).toBeTruthy();
    expect(eventText({ id: 1, at: "x", symbol: "A", kind: "exit", price: 1, detail: { reason: "STOP_CLOSE", notes: ["candle close 96.80 at or below the stop 97.00"] } })).toBe("STOP_CLOSE: candle close 96.80 at or below the stop 97.00");
    expect(eventText({ id: 1, at: "x", symbol: "A", kind: "entry_cancelled", price: 1, detail: { reason: "more than 1% above the trigger" } })).toBe("more than 1% above the trigger");
  });

  it("compares with the official book: both fills, the fill gap, and an exit the shadow book never held", async () => {
    mount(base());
    const cmp = await screen.findByTestId("minute-compare");
    expect(cmp.textContent).toContain("Both filled 1");
    const rows = screen.getAllByTestId("minute-compare-row");
    expect(rows[0]!.textContent).toContain("filled 100.30 x 1990");
    expect(rows[0]!.textContent).toContain("+0.40%");
    expect(rows[1]!.textContent).toContain("no entry (last reading: volume_short)");
    expect(cmp.textContent).toContain("the shadow book did not hold it");
  });

  it("empty states are explicit and a straight-line volume basis is named", async () => {
    mount(base({ watching: [], positions: [], recent_closed: [], events: [], comparisons: [], volume_basis: "straight-line", profile_ready: false }));
    expect((await screen.findByTestId("minute-watch-empty")).textContent).toContain("No order is queued");
    expect(screen.getByTestId("minute-pos-empty")).toBeTruthy();
    expect(screen.getByTestId("minute-closed-empty")).toBeTruthy();
    expect(screen.getByTestId("minute-compare-empty").textContent).toContain("after each evening settlement");
    expect(screen.getByTestId("minute-data").textContent).toContain("straight line");
  });

  it("says when it is switched off and when it cannot be read", async () => {
    const { unmount } = mount(base({ enabled: false }));
    expect((await screen.findByTestId("minute-off")).textContent).toContain("swing_live_enabled");
    unmount();
    mount({ detail: { message: "the 1-minute shadow book is not running" } }, 503);
    expect(await screen.findByTestId("minute-error")).toBeTruthy();
  });
});
