// Move SL to cost in the browser: the same numbers as backend/tests/unit/test_strategy_cost.py (hand-calculated), and the same results as the server on 300 generated strategies (strategy-parity.test.ts).
import { describe, expect, it } from "vitest";
import { applyAutomation, moveStopsToCost, type Leg } from "../lib/strategy";

const AT = "2026-11-12T05:00:00.000Z";
const LOT = 65;
const leg = (id: string, type: "CE" | "PE", o: Partial<Leg> = {}): Leg => ({ id, expiry: "2026-11-17", strike: 25000, type, action: "SELL", lots: 1, premium: 100, stop: 130, ...o }) as Leg;
const run = (legs: Leg[], prices: Record<string, number | null>, cost = true) => {
  const price = (strike: number, type: string) => prices[legs.find((l) => l.strike === strike && l.type === type && prices[l.id] !== undefined)?.id ?? ""] ?? null;
  const r = applyAutomation(legs, price as never, LOT, AT, 1, cost);
  return { legs: Object.fromEntries(r.legs.map((l) => [l.id, l])) as Record<string, Leg>, events: r.events };
};
// legs of one test are on different contracts: give each its own strike so the price lookup by contract is unambiguous
const ce = (o: Partial<Leg> = {}) => leg("ce", "CE", { strike: 25000, ...o });
const pe = (o: Partial<Leg> = {}) => leg("pe", "PE", { strike: 25000, ...o });

describe("move SL to cost", () => {
  it("moves the other leg of a short straddle to its entry when one leg is stopped and the other is in profit", () => {
    const { legs, events } = run([ce(), pe()], { ce: 130, pe: 80 });
    expect(legs.ce!.exitPrice).toBe(130);
    expect(legs.ce!.exitReason).toBe("stop");
    expect(legs.ce!.realised).toBe(-30 * 65); // sold at 100, stopped at 130
    expect(legs.pe).toMatchObject({ stop: 100, stopTrailed: true, costMoved: true, stopBase: 130 }); // the stop you set is remembered
    expect(legs.pe!.exitPrice == null).toBe(true);
    expect(events.some((e) => e.includes("Stop moved to cost: SELL 25000 PE stop 130.00 → 100.00 because SELL 25000 CE was stopped out"))).toBe(true);
  });

  it("is off unless asked for", () => {
    const { legs, events } = run([ce(), pe()], { ce: 130, pe: 80 }, false);
    expect(legs.pe!.stop).toBe(130);
    expect(legs.pe!.costMoved).toBeUndefined();
    expect(events).toHaveLength(1); // only the exit itself
  });

  it("the moved stop exits at cost with zero P&L and says so, and one tick short of it the leg stays open", () => {
    const first = run([ce(), pe()], { ce: 130, pe: 80 }).legs;
    const hit = run([first.pe!], { pe: 100 });
    expect(hit.legs.pe).toMatchObject({ exitPrice: 100, realised: 0 });
    expect(hit.events[0]).toContain("Stop at cost: SELL 25000 PE closed at 100.00 (entry 100.00)");
    expect(run([first.pe!], { pe: 99.95 }).legs.pe!.exitPrice == null).toBe(true);
  });

  it("leaves a leg that is not in profit alone, with the reason, and never instantly exits a leg that sits exactly at cost", () => {
    const loss = run([ce(), pe()], { ce: 130, pe: 110 });
    expect(loss.legs.pe!.stop).toBe(130);
    expect(loss.events.some((e) => e.includes("Stop to cost skipped for SELL 25000 PE: it is not in profit (price 110.00 against entry 100.00)"))).toBe(true);
    const flat = run([ce(), pe()], { ce: 130, pe: 100 });
    expect(flat.legs.pe!.stop).toBe(130);
    expect(flat.legs.pe!.exitPrice == null).toBe(true);
  });

  it("says when a leg has no live price instead of guessing", () => {
    const r = moveStopsToCost([ce({ exitPrice: 130, exitReason: "stop" }), pe()], [ce({ exitPrice: 130, exitReason: "stop" })], () => null, AT);
    expect(r.legs[1]!.stop).toBe(130);
    expect(r.events[0]).toContain("Stop to cost skipped for SELL 25000 PE: no live price");
  });

  it("moves only legs on the same side: a bought wing keeps its own stop, and a stopped bought leg moves the other bought legs", () => {
    const wing = leg("w", "CE", { action: "BUY", premium: 20, stop: 10, strike: 25100 });
    const sold = run([ce(), pe(), wing], { ce: 130, pe: 80, w: 30 });
    expect(sold.legs.w!.stop).toBe(10);
    expect(sold.legs.pe!.stop).toBe(100);
    const b2 = leg("b2", "PE", { action: "BUY", premium: 50, stop: 40, strike: 24900 });
    const s = leg("s", "CE", { strike: 25200 });
    const bought = run([wing, b2, s], { w: 10, b2: 70, s: 90 });
    expect(bought.legs.b2).toMatchObject({ stop: 50, costMoved: true });
    expect(bought.legs.s!.stop).toBe(130);
  });

  it("only ever tightens a stop", () => {
    expect(run([ce(), pe({ stop: 95 })], { ce: 130, pe: 80 }).legs.pe).toMatchObject({ stop: 95 });
    expect(run([ce(), pe({ stop: 95 })], { ce: 130, pe: 80 }).legs.pe!.costMoved).toBeUndefined();
    expect(run([ce(), pe({ stop: 100 })], { ce: 130, pe: 80 }).legs.pe!.costMoved).toBeUndefined();
  });

  it("gives a leg that had no stop one at cost, and a later re-entry does not inherit a zero distance", () => {
    const moved = run([ce(), pe({ stop: null, reentry: 1 })], { ce: 130, pe: 80 }).legs.pe!;
    expect(moved).toMatchObject({ stop: 100, costMoved: true });
    expect(moved.stopBase == null).toBe(true);
    const out = run([moved], { pe: 100 }).legs.pe!;
    expect(out.exitReason).toBe("stop");
    expect(out.stopPct == null).toBe(true); // no stop was ever typed: nothing to copy
    const back = run([out], { pe: 95 }).legs.pe!;
    expect(back).toMatchObject({ premium: 95, costMoved: false });
    expect(back.stop == null).toBe(true);
  });

  it("is not set off by a target, nor by two stops on one pass, and a repeat pass over the same prices changes nothing", () => {
    expect(run([ce({ target: 60 }), pe()], { ce: 60, pe: 80 }).legs.pe!.stop).toBe(130);
    const both = run([ce(), pe()], { ce: 130, pe: 131 });
    expect(both.legs.ce!.exitReason).toBe("stop");
    expect(both.legs.pe!.exitReason).toBe("stop");
    expect(both.events.some((e) => e.includes("to cost"))).toBe(false);
    const first = run([ce(), pe(), leg("off", "PE", { enabled: false, strike: 25100 })], { ce: 130, pe: 80, off: 80 });
    expect(first.legs.off!.stop).toBe(130); // an unticked leg is not touched
    const again = run(Object.values(first.legs), { ce: 130, pe: 80, off: 80 });
    expect(again.legs.pe).toEqual(first.legs.pe);
    expect(again.events).toEqual([]);
  });

  it("runs the trail at once on a leg that just got its first stop", () => {
    const { legs, events } = run([ce(), pe({ stop: null, trailEvery: 10, trailBy: 5 })], { ce: 130, pe: 80 });
    expect(legs.pe!.stop).toBe(90); // base 100 - 2 steps x 5 % x 100
    expect(events.some((e) => e.includes("Trailing stop SELL 25000 PE: stop 100.00 → 90.00"))).toBe(true);
  });
});
