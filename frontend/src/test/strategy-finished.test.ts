import { describe, expect, it } from "vitest";
import { isFinished, type Leg } from "../lib/strategy";

const L = (o: Partial<Leg>): Leg => ({ id: "x", action: "SELL", type: "CE", strike: 24000, expiry: "2026-11-03", lots: 1, premium: 100, ...o }) as Leg;
const out = (reason: Leg["exitReason"], extra: Partial<Leg> = {}): Partial<Leg> => ({ exitPrice: 90, exitReason: reason, ...extra });

describe("isFinished", () => {
  it("is true only when every ticked leg is out and the strategy itself closed one of them", () => {
    expect(isFinished([L(out("strategy")), L(out("strategy"))])).toBe(true);
    expect(isFinished([L(out("strategy")), L(out("target"))])).toBe(true);
    expect(isFinished([L(out("target"))])).toBe(false); // a target alone is not the strategy closing
    expect(isFinished([L(out("strategy")), L({})])).toBe(false); // a leg is still open
    expect(isFinished([])).toBe(false);
  });
  it("ignores unticked legs and waits for a stopped leg that can still re-enter", () => {
    expect(isFinished([L(out("strategy")), L({ enabled: false })])).toBe(true);
    expect(isFinished([L(out("strategy")), L(out("stop", { reentry: 1, reentryLevel: 100 }))])).toBe(false);
    expect(isFinished([L(out("strategy")), L(out("stop", { reentry: 0, reentryLevel: 100 }))])).toBe(true);
  });
});
