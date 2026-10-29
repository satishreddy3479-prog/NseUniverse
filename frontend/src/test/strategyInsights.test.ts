import { describe, expect, it } from "vitest";
import { strategyInsights, type InsightInput } from "../lib/strategyInsights";
import type { Leg } from "../lib/strategy";

const leg = (action: "BUY" | "SELL", type: "CE" | "PE", strike: number, over: Partial<Leg> = {}): Leg => ({ id: action + type + strike, expiry: "2026-11-03", strike, type, action, lots: 1, premium: 100, premiumSource: "manual", ...over });
const base = (o: Partial<InsightInput>): InsightInput => ({ legs: [], spot: 23000, maxProfit: null, maxLoss: null, profitUnlimited: false, lossUnlimited: false, breakevens: [], pop: null, delta: null, thetaDay: null, bands: null, oi: [], stale: false, missingQuote: 0, ...o });
const text = (o: Partial<InsightInput>) => strategyInsights(base(o)).map((x) => x.text).join(" | ");

describe("strategyInsights", () => {
  it("says nothing for no legs", () => expect(strategyInsights(base({}))).toEqual([]));
  it("flags unlimited loss on both sides of a short straddle and the missing stop", () => {
    const t = text({ legs: [leg("SELL", "CE", 23000), leg("SELL", "PE", 23000)], lossUnlimited: true, maxProfit: 18000 });
    expect(t).toContain("unlimited on both sides");
    expect(t).toContain("No stop-loss is set");
  });
  it("reward to risk from the exact payoff: 5,250 / 2,250", () => {
    const t = text({ legs: [leg("BUY", "CE", 24000), leg("SELL", "CE", 24100)], maxProfit: 5250, maxLoss: -2250 });
    expect(t).toContain("2.33 : 1");
    expect(t).toContain("worst case at expiry is ₹2,250");
  });
  it("a high chance with a small reward against a large loss is called out", () => {
    expect(text({ legs: [leg("SELL", "PE", 22000)], maxProfit: 1000, maxLoss: -9000, pop: 0.8 })).toContain("erase many wins");
  });
  it("breakevens inside the ±1σ range of a net short position warn", () => {
    const t = text({ legs: [leg("SELL", "CE", 23000), leg("SELL", "PE", 23000)], breakevens: [22900, 23100], bands: { m2: 22600, m1: 22800, p1: 23200, p2: 23400 } });
    expect(t).toContain("inside the ±1σ");
  });
  it("names the heaviest stored OI strikes and reports missing quotes and a stale chain", () => {
    const t = text({ legs: [leg("SELL", "CE", 23200)], oi: [{ strike: 23500, call: 9e6, put: 1 }, { strike: 22500, call: 1, put: 8e6 }], missingQuote: 1, stale: true });
    expect(t).toContain("calls at 23,500, puts at 22,500");
    expect(t).toContain("nearer the money than the heaviest call OI at 23,500");
    expect(t).toContain("1 leg has no stored quote");
    expect(t).toContain("stale");
  });
  it("direction and decay come from the model values", () => {
    const t = text({ legs: [leg("BUY", "CE", 23000)], delta: 30, thetaDay: -1500 });
    expect(t).toContain("bullish");
    expect(t).toContain("works against you: about ₹1,500 a day");
  });
});
