import { describe, expect, it } from "vitest";
import { positionToBuilder } from "../lib/forwardStrategy";

// The weekly straddle opened on 17 Nov 2026 at 09:30 IST (04:00Z): sold 25300 CE at 74.40 and PE at 48.95 (the live server's position).
const open = { session: "2026-11-17", cohort: "weekly", structure: "straddle", n: 1, expiry: "2026-11-17", trigger_at: "2026-11-17T04:00:00+00:00", ce_strike: 25300, pe_strike: 25300, ce0: 74.4, pe0: 48.95 };
// The position of 16 Nov 2026 whose put the 40% stop caught: CE 92.95 and PE 107.30 sold at 10:25, put 156.65 at 10:46, call 70.45 at the close.
const stopped = { session: "2026-11-16", cohort: "weekly", structure: "straddle", n: 1, expiry: "2026-11-17", trigger_at: "2026-11-16T04:55:00+00:00", ce_strike: 25300, pe_strike: 25300, ce0: 92.95, pe0: 107.3 };

describe("a forward-test position as a strategy of the builder", () => {
  it("two sold legs at the test's strikes and premiums, named and timed, with no stop for the no-stop rule", () => {
    const d = positionToBuilder(open, "hold", 65);
    expect(d.name).toBe("Forward weekly straddle #1, 17 Nov 09:30");
    expect(d.expiry).toBe("2026-11-17");
    expect(d.legs.map((l) => [l.type, l.action, l.strike, l.lots, l.premium, l.stop])).toEqual([["CE", "SELL", 25300, 1, 74.4, null], ["PE", "SELL", 25300, 1, 48.95, null]]);
    expect(d.legs.every((l) => l.enteredAt === open.trigger_at && l.premiumSource === "market" && l.exitPrice === undefined)).toBe(true);
    expect(d.holdFrom).toBe(open.trigger_at);
    expect(d.rules.sl).toBeNull();
    expect(d.moveToCost).toBe(false);
  });

  it("a leg-stop rule puts the stop that many percent above each entry premium, rounded to the 0.05 tick, and records when it was set", () => {
    const d = positionToBuilder(open, "leg40", 65);
    expect(d.legs[0]!.stop).toBe(104.15); // 74.40 x 1.4 = 104.16
    expect(d.legs[1]!.stop).toBe(68.55); // 48.95 x 1.4 = 68.53
    expect(d.legs.every((l) => l.stopSetAt === open.trigger_at && l.stopPct === 0.4)).toBe(true);
    expect(positionToBuilder(open, "leg30", 65).legs[0]!.stop).toBe(96.7); // 96.72
    expect(positionToBuilder(open, "leg80", 65).legs[1]!.stop).toBe(88.1); // 88.11
    const cost = positionToBuilder(open, "leg40_cost", 65);
    expect(cost.moveToCost).toBe(true);
    expect(cost.legs[0]!.stop).toBe(104.15);
  });

  it("a combined-premium rule becomes a stop loss on the whole strategy in rupees", () => {
    // 25 % of the premium 74.40 + 48.95 = 123.35 is 30.8375 points x lot 65 = Rs 2,004.44
    expect(positionToBuilder(open, "comb25", 65).rules.sl).toBe(2004);
    expect(positionToBuilder(open, "comb25", 65).legs.every((l) => l.stop == null)).toBe(true);
    expect(positionToBuilder(open, "comb15", 65).rules.sl).toBe(1203); // 18.5025 x 65 = 1,202.66
  });

  it("a closed position keeps its exits: the put that a stop closed, with its time and loss, and the call closed at 15:20", () => {
    const d = positionToBuilder(stopped, "leg40", 65, { ce_exit: 70.45, pe_exit: 156.65, stopped_at: "10:46", settled_at: "2026-11-16T09:50:00+00:00" });
    const [ce, pe] = d.legs;
    expect(pe!.exitPrice).toBe(156.65);
    expect(pe!.exitReason).toBe("stop");
    expect(pe!.exitedAt).toBe("2026-11-16T10:46:00+05:30");
    expect(pe!.realised).toBeCloseTo(-3207.75, 2); // (107.30 - 156.65) x 65
    expect(pe!.reentryLevel).toBe(107.3);
    expect(ce!.exitReason).toBe("strategy"); // 70.45 is below its stop of 130.15: closed at the end of the day
    expect(ce!.exitedAt).toBe("2026-11-16T09:50:00+00:00");
    expect(ce!.realised).toBeCloseTo(1462.5, 2); // (92.95 - 70.45) x 65
  });

  it("an open position whose one leg a stop already closed opens with that leg exited and the other still open", () => {
    const d = positionToBuilder(stopped, "leg40", 65, { ce_exit: null, pe_exit: 156.65, stopped_at: "10:46" });
    expect(d.legs[0]!.exitPrice).toBeUndefined();
    expect(d.legs[1]!.exitPrice).toBe(156.65);
    expect(d.legs[1]!.exitReason).toBe("stop");
  });

  it("a combined stop closes both legs by the strategy at the time it fired; a strangle is named so", () => {
    const d = positionToBuilder({ ...stopped, structure: "strangle", ce_strike: 25400, pe_strike: 25200 }, "comb15", 65, { ce_exit: 100, pe_exit: 140, stopped_at: "11:05", settled_at: "2026-11-16T09:50:00+00:00" });
    expect(d.name).toBe("Forward weekly strangle #1, 16 Nov 10:25");
    expect(d.legs.map((l) => [l.strike, l.exitReason, l.exitedAt])).toEqual([[25400, "strategy", "2026-11-16T11:05:00+05:30"], [25200, "strategy", "2026-11-16T11:05:00+05:30"]]);
  });

  it("a stop-to-cost rule takes its stop percentage and turns on Move SL to cost; a leg that closed at its entry price after the move is a stop", () => {
    const d = positionToBuilder(open, "leg30_cost", 65);
    expect(d.moveToCost).toBe(true);
    expect(d.legs[0]!.stop).toBe(96.7); // 74.40 x 1.3 = 96.72
    expect(d.legs[1]!.stop).toBe(63.65); // 48.95 x 1.3 = 63.635
    expect(positionToBuilder(open, "leg80_cost", 65).legs[0]!.stop).toBe(133.9); // 133.92
    const closed = positionToBuilder(stopped, "leg30_cost", 65, { ce_exit: 103.5, pe_exit: 143, stopped_at: "10:34", ce_at: "12:10", pe_at: "10:34", settled_at: "2026-11-16T09:50:00+00:00" });
    expect(closed.legs[1]!.exitReason).toBe("stop"); // 143.00 is above 107.30 x 1.3 = 139.49
    expect(closed.legs[0]!.exitReason).toBe("stop"); // 103.50 is above its entry 92.95: the stop that was moved to cost
    expect(closed.legs[0]!.exitedAt).toBe("2026-11-16T12:10:00+05:30"); // the call closed when it came back to its cost, not when the put stopped
    expect(closed.legs[1]!.exitedAt).toBe("2026-11-16T10:34:00+05:30");
  });
});
