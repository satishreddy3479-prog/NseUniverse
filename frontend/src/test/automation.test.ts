import { describe, expect, it } from "vitest";
import { analyzeExpiry, applyAutomation, exitLeg, expiryPnl, reenterLeg, type Leg } from "../lib/strategy";

const LOT = 65;
const AT = "2026-11-02T05:00:00Z";
const short = (over: Partial<Leg> = {}): Leg => ({ id: "a", expiry: "2026-11-03", strike: 23000, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", stop: 130, target: 50, reentry: 1, ...over });
const buy = (over: Partial<Leg> = {}): Leg => short({ action: "BUY", premium: 100, stop: 70, target: 150, ...over });
const px = (v: number | null) => () => v;

describe("automatic stop, target and re-entry (paper)", () => {
  it("does nothing until the price reaches a level, then closes the leg at the live price and books the P&L", () => {
    expect(applyAutomation([short()], px(129.95), LOT, AT).events).toEqual([]);
    const r = applyAutomation([short()], px(131), LOT, AT); // a seller's stop is above the entry
    const l = r.legs[0]!;
    expect(l.exitPrice).toBe(131); expect(l.exitReason).toBe("stop");
    expect(l.realised).toBeCloseTo(-(131 - 100) * 65, 6); // −31 × 65 = −2,015
    expect(r.events[0]).toContain("Stop: SELL 23000 CE closed at 131.00");
    const t = applyAutomation([short()], px(48), LOT, AT).legs[0]!; // target: the premium fell to 48
    expect(t.exitReason).toBe("target"); expect(t.realised).toBeCloseTo((100 - 48) * 65, 6); // +3,380
  });

  it("a bought option is the mirror image: target above, stop below", () => {
    expect(applyAutomation([buy()], px(151), LOT, AT).legs[0]!.exitReason).toBe("target");
    const s = applyAutomation([buy()], px(69), LOT, AT).legs[0]!;
    expect(s.exitReason).toBe("stop"); expect(s.realised).toBeCloseTo(-31 * 65, 6);
  });

  it("a closed leg no longer follows the market: its payoff is the fixed booked P&L", () => {
    const closed = applyAutomation([short()], px(131), LOT, AT).legs[0]!;
    expect(isFixed(closed)).toBe(true);
    for (const s of [20000, 23000, 26000]) expect(expiryPnl([closed], s, LOT)).toBeCloseTo(-2015, 6);
    // together with an open short put the closed call adds the same constant everywhere
    const put = short({ id: "b", type: "PE", strike: 22900, premium: 90 });
    const a = analyzeExpiry([closed, put], LOT)!;
    expect(a.lossUnlimited).toBe(false); // the closed call no longer carries upside risk
    expect(expiryPnl([closed, put], 25000, LOT)).toBeCloseTo(-2015 + 90 * 65, 6);
  });

  it("re-entry: after a stop, a short leg is entered again when the premium falls back to its entry; once, as set", () => {
    let legs = applyAutomation([short({ reentry: 1 })], px(131), LOT, AT).legs; // stopped out at 131
    expect(legs[0]!.reentryLevel).toBe(100);
    legs = applyAutomation(legs, px(115), LOT, AT).legs; // still above its old entry: waits
    expect(legs[0]!.exitPrice).toBe(131); // still closed
    const back = applyAutomation(legs, px(99), LOT, AT); // fell back below 100: enters at the live price 99
    const l = back.legs[0]!;
    expect(l.exitPrice).toBeNull(); expect(l.premium).toBe(99); expect(l.reentry).toBe(0); expect(l.cycles).toBe(1);
    expect(l.stop).toBeCloseTo(128.7, 6); // same 30 % stop distance from the new entry: 99 × 1.3
    expect(l.target).toBeCloseTo(49.5, 6); // same 50 % target distance: 99 × 0.5
    expect(l.realised).toBeCloseTo(-2015, 6); // the first cycle's loss stays booked
    // no re-entries left: a second stop stays closed
    const second = applyAutomation(back.legs, px(130), LOT, AT).legs[0]!;
    expect(second.exitReason).toBe("stop");
    expect(applyAutomation([second], px(80), LOT, AT).events).toEqual([]); // reentry = 0: never again
  });

  it("re-entry for a bought leg: stopped below, entered again when the premium rises back to its entry", () => {
    let legs = applyAutomation([buy({ reentry: 1 })], px(69), LOT, AT).legs;
    expect(legs[0]!.reentryLevel).toBe(100);
    expect(applyAutomation(legs, px(90), LOT, AT).events).toEqual([]);
    legs = applyAutomation(legs, px(101), LOT, AT).legs;
    expect(legs[0]!.premium).toBe(101); expect(legs[0]!.exitPrice).toBeNull();
    expect(legs[0]!.stop).toBeCloseTo(70.7, 6); // 101 × 0.7
  });

  it("a target exit, a manual exit and a leg with no re-entries are never entered again; unticked legs and missing prices are left alone", () => {
    const t = applyAutomation([short()], px(48), LOT, AT).legs[0]!;
    expect(applyAutomation([t], px(40), LOT, AT).events).toEqual([]);
    const m = exitLeg(short(), 120, "manual", LOT, AT);
    expect(m.realised).toBeCloseTo(-20 * 65, 6); expect(applyAutomation([m], px(90), LOT, AT).events).toEqual([]);
    expect(applyAutomation([short({ enabled: false })], px(200), LOT, AT).events).toEqual([]);
    expect(applyAutomation([short()], px(null), LOT, AT).events).toEqual([]);
    const manualAgain = reenterLeg(m, 95, AT, false);
    expect(manualAgain.reentry).toBe(1); expect(manualAgain.premium).toBe(95); // a hand re-entry does not use up the box
  });

  it("the lot multiplier is applied to the booked P&L", () => {
    expect(applyAutomation([short({ lots: 2 })], px(131), LOT, AT, 3).legs[0]!.realised).toBeCloseTo(-31 * 2 * 3 * 65, 6);
  });
});

const isFixed = (l: Leg) => l.exitPrice != null;
