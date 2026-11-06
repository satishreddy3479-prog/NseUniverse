// Open positions use the live feed price (settled close beside it), show the exit levels, and an order that the cooldown will
// skip says so. Numbers are hand calculations from the 6 Nov 2026 paper book (fill 2 320.00, initial stop 2 235.57).
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { liveEquity, PositionsPanel, positionLevels, positionPrice } from "../components/swing/PositionsPanel";
import { cooldownLeft } from "../lib/swing";
import type { SwingLiveRow, SwingPaperPosition } from "../lib/types";

const pos = (o: Partial<SwingPaperPosition> = {}): SwingPaperPosition => ({
  symbol: "ANANDRATHI", sector: "FIN", archetype: "CLASSIC_PIVOT", score: 70, pivot: 2310, entry_session: "2026-11-05", entry_no: 3, fill: 2320, shares: 86,
  initial_sl: 2235.57, tsl: 2235.57, hh: 2380, last_close: 2370, value: 203820, unrealized_pnl: 4300, unrealized_pct: 2.155, stop_stage: "initial stop", risk_to_stop_pct: 5.7, ...o,
});
const row = (o: Partial<SwingLiveRow> = {}): SwingLiveRow => ({
  symbol: "ANANDRATHI", kind: "position", has_token: true, ltp: 2373.5, prev_close: 2366, change_pct: 0.15, volume: 247941, day_open: 2350, day_high: 2380, day_low: 2340,
  tick_age_s: 4, stale: false, state: "holding", note: "", stop: 2235.57, ...o,
});

describe("position levels", () => {
  it("1.8R and 2.5R are fill plus that many times the entry risk", () => {
    const l = positionLevels(pos()); // R = 2320 - 2235.57 = 84.43
    expect(l.r).toBeCloseTo(84.43, 6);
    expect(l.l18).toBeCloseTo(2471.974, 3); // 2320 + 1.8 x 84.43
    expect(l.l25).toBeCloseTo(2531.075, 3); // 2320 + 2.5 x 84.43
    expect(l.reached18).toBe(false); // highest price 2380 is below 2471.97
    expect(positionLevels(pos({ hh: 2480 })).reached18).toBe(true);
  });
  it("prices a position live when the feed has a price and at the settled close when it has not", () => {
    expect(positionPrice(pos(), row())).toMatchObject({ px: 2373.5, live: true, stale: false });
    expect(positionPrice(pos(), row({ ltp: null }))).toMatchObject({ px: 2370, live: false });
    expect(positionPrice(pos(), undefined)).toMatchObject({ px: 2370, live: false });
  });
  it("live equity is cash plus each position at its live price, the settled close where there is none", () => {
    const e = liveEquity(596738.06, [pos(), pos({ symbol: "KRISHANA", shares: 843, last_close: 245.47 })], [row()]);
    expect(e.equity).toBeCloseTo(596738.06 + 86 * 2373.5 + 843 * 245.47, 2); // KRISHANA has no live row
    expect(e.live).toBe(1);
    expect(e.total).toBe(2);
  });
});

describe("positions panel", () => {
  it("shows the live price, the settled close next to it, the live profit and both exit levels", () => {
    render(<PositionsPanel positions={[pos()]} slots={5} never={false} rows={[row()]} market="closed" cash={0} />);
    const tr = screen.getByRole("row", { name: /ANANDRATHI/ });
    expect(within(tr).getByText("2,373.50")).toBeInTheDocument(); // price now
    expect(within(tr).getByText("2,370.00")).toBeInTheDocument(); // settled close
    expect(tr).toHaveTextContent("+₹4.6 K"); // 86 x (2373.50 - 2320.00) = 4 601, shown in thousands
    expect(tr).toHaveTextContent("settled +₹4.3 K");
    expect(tr).toHaveTextContent("1.8R 2,471.97");
    expect(tr).toHaveTextContent("2.5R 2,531.08");
    expect(screen.getByTestId("positions-live-note")).toHaveTextContent("1 of 1 priced live");
    expect(screen.getByText(/no fixed profit target/i)).toBeInTheDocument();
  });
  it("falls back to the settled close and says so when there is no live price", () => {
    render(<PositionsPanel positions={[pos()]} slots={5} never={false} rows={[]} market="closed" cash={0} />);
    expect(screen.getByTestId("positions-live-note")).toHaveTextContent("No live price yet");
    expect(screen.getByRole("row", { name: /ANANDRATHI/ })).toHaveTextContent("settled close");
  });
});

describe("cooldown of a queued order", () => {
  const trades = [{ symbol: "ARIS", exit_no: 2 }, { symbol: "IIFLCAPS", exit_no: 3 }, { symbol: "OLD", exit_no: 1 }];
  it("follows the engine: skipped while (session - last exit) is below the cooldown of 3", () => {
    expect(cooldownLeft("ARIS", trades, 4, 3)).toEqual({ sessions: 1, lastExitNo: 2 }); // 4 - 2 = 2 < 3
    expect(cooldownLeft("IIFLCAPS", trades, 4, 3)).toEqual({ sessions: 2, lastExitNo: 3 }); // 4 - 3 = 1 < 3
    expect(cooldownLeft("OLD", trades, 4, 3)).toBeNull(); // 4 - 1 = 3, not below 3
    expect(cooldownLeft("NEW", trades, 4, 3)).toBeNull();
    expect(cooldownLeft("ARIS", trades, null, 3)).toBeNull(); // the next session is unknown: nothing is claimed
  });
});
