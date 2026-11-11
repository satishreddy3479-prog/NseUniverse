// Strategies with legs on different expiries: payoff read at a date, hand-checkable cases.
import { describe, expect, it } from "vitest";
import { analyzeCurve, curveOf, isEstimateAt, legExpiries, pnlAtExpiry } from "../lib/multiExpiry";
import { black76, expiryEnd, probabilityOfProfit, probabilityOfProfitFn, type Valuation } from "../lib/optionModel";
import { TEMPLATES, analyzeExpiry, expiryPnl, intrinsic, type Leg } from "../lib/strategy";

const NEAR = "2026-11-17", FAR = "2026-11-24";
const LOT = 65;
const leg = (o: Partial<Leg> & Pick<Leg, "expiry" | "strike" | "type" | "action" | "premium">): Leg => ({ id: `${o.expiry}${o.strike}${o.type}${o.action}`, lots: 1, premiumSource: "manual", enabled: true, ...o });
const NOW = expiryEnd("2026-11-11");
const V: Valuation = { spotNow: 25000, nowMs: NOW, rate: 0.06, carry: 0.06, ivShift: 0 };
const YEAR = 365 * 86_400_000;

describe("legExpiries / isEstimateAt", () => {
  const legs = [leg({ expiry: FAR, strike: 25000, type: "CE", action: "BUY", premium: 300 }), leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200 })];
  it("lists the distinct expiries earliest first", () => expect(legExpiries(legs)).toEqual([NEAR, FAR]));
  it("a curve is a model estimate only while some leg is still alive at the chosen date", () => {
    expect(isEstimateAt(legs, NEAR)).toBe(true);
    expect(isEstimateAt(legs, FAR)).toBe(false);
    expect(isEstimateAt([legs[0]!], FAR)).toBe(false);
  });
});

describe("one expiry: the curve equals the exact payoff", () => {
  const strad = [leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200 }), leg({ expiry: NEAR, strike: 25000, type: "PE", action: "SELL", premium: 180 })];
  it("pnlAtExpiry equals expiryPnl at every level", () => {
    for (const s of [24000, 24620, 25000, 25380, 26100]) expect(pnlAtExpiry(strad, s, NEAR, LOT, V)).toBeCloseTo(expiryPnl(strad, s, LOT) as number, 9);
  });
  it("breakevens and extremes match the exact analysis", () => {
    const exact = analyzeExpiry(strad, LOT);
    const c = analyzeCurve(strad, LOT, 25000, (s) => pnlAtExpiry(strad, s, NEAR, LOT, V), false);
    expect(c.estimate).toBe(false);
    expect(c.breakevens).toHaveLength(2);
    c.breakevens.forEach((b, i) => expect(b).toBeCloseTo(exact.breakevens[i]!, 1)); // 24620 and 25380
    expect(c.maxProfit).toBeCloseTo(exact.maxProfit as number, 6); // (200+180) * 65 at the strike
    expect(c.lossUnlimited).toBe(true);
    expect(c.maxLoss).toBeNull();
  });
});

describe("calendar spread: sell the near call, buy the far call, same strike", () => {
  const cal = [leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200, iv: 0.15 }), leg({ expiry: FAR, strike: 25000, type: "CE", action: "BUY", premium: 300, iv: 0.15 })];
  const tFarAtNear = (expiryEnd(FAR) - expiryEnd(NEAR)) / YEAR; // exactly 7 days
  const farValue = (s: number) => black76("CE", s * Math.exp(0.06 * tFarAtNear), 25000, tFarAtNear, 0.15, 0.06);
  it("at the near expiry: the near leg is intrinsic, the far leg is its Black-76 value 7 days before its own expiry", () => {
    expect(tFarAtNear).toBeCloseTo(7 / 365, 12);
    for (const s of [24500, 25000, 25400]) {
      const expected = LOT * (-(intrinsic({ type: "CE", strike: 25000 }, s) - 200) + (farValue(s) - 300));
      expect(pnlAtExpiry(cal, s, NEAR, LOT, V)).toBeCloseTo(expected, 8);
    }
  });
  it("is best at the strike and loses on both sides", () => {
    const at = (s: number) => pnlAtExpiry(cal, s, NEAR, LOT, V) as number;
    expect(at(25000)).toBeGreaterThan(at(24600));
    expect(at(25000)).toBeGreaterThan(at(25400));
    expect(at(25000)).toBeGreaterThan(0); // far ATM value (about 207) beats the 100 net debit
    expect(at(23000)).toBeLessThan(0);
  });
  it("analysis: two breakevens, bounded both ways, flagged as an estimate", () => {
    const f = (s: number) => pnlAtExpiry(cal, s, NEAR, LOT, V);
    const a = analyzeCurve(cal, LOT, 25000, f, isEstimateAt(cal, NEAR));
    expect(a.defined && a.estimate).toBe(true);
    expect(a.breakevens).toHaveLength(2);
    a.breakevens.forEach((b) => expect(Math.abs(f(b) as number)).toBeLessThan(1)); // breakevens are rounded to 0.01 index points (about 0.3 rupees here)
    expect(a.profitUnlimited || a.lossUnlimited).toBe(false); // the net call quantity is zero: no unbounded side
    expect(a.maxProfit as number).toBeGreaterThan(0);
    expect(a.maxLoss as number).toBeLessThan(0);
  });
  it("at the far expiry every leg is intrinsic: a flat loss equal to the net debit (the earlier leg settled at the same level)", () => {
    for (const s of [23000, 25000, 27000]) expect(pnlAtExpiry(cal, s, FAR, LOT, V)).toBeCloseTo(-100 * LOT, 8);
    const a = analyzeCurve(cal, LOT, 25000, (s) => pnlAtExpiry(cal, s, FAR, LOT, V), false);
    expect(a.estimate).toBe(false);
    expect(a.maxProfit).toBeCloseTo(-6500, 6);
    expect(a.maxLoss).toBeCloseTo(-6500, 6);
  });
});

describe("the unlimited side follows the net call quantity", () => {
  it("short near call + long far put: loss unlimited upward", () => {
    const legs = [leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200, iv: 0.15 }), leg({ expiry: FAR, strike: 24800, type: "PE", action: "BUY", premium: 150, iv: 0.15 })];
    const a = analyzeCurve(legs, LOT, 25000, (s) => pnlAtExpiry(legs, s, NEAR, LOT, V), true);
    expect(a.lossUnlimited).toBe(true);
    expect(a.profitUnlimited).toBe(false);
  });
  it("one near short call against two far long calls: profit unlimited upward", () => {
    const legs = [leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200, iv: 0.15 }), leg({ expiry: FAR, strike: 25000, type: "CE", action: "BUY", premium: 300, iv: 0.15, lots: 2 })];
    const a = analyzeCurve(legs, LOT, 25000, (s) => pnlAtExpiry(legs, s, NEAR, LOT, V), true);
    expect(a.profitUnlimited).toBe(true);
  });
});

describe("closed legs and missing premiums", () => {
  it("an exited leg adds only its realised P&L", () => {
    const closed = leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200, exitPrice: 150, realised: 3250 });
    const far = leg({ expiry: FAR, strike: 25000, type: "CE", action: "BUY", premium: 300, iv: 0.15 });
    const v = pnlAtExpiry([closed, far], 25000, NEAR, LOT, V) as number;
    expect(v).toBeCloseTo(3250 + LOT * (black76("CE", 25000 * Math.exp((0.06 * 7) / 365), 25000, 7 / 365, 0.15, 0.06) - 300), 8);
  });
  it("a missing entry premium means no curve, with the reason", () => {
    const a = analyzeCurve([leg({ expiry: NEAR, strike: 25000, type: "CE", action: "BUY", premium: null })], LOT, 25000, () => 0, false);
    expect(a.defined).toBe(false);
    expect(a.reason).toMatch(/entry premium/);
  });
});

describe("per-expiry carry and probability of profit", () => {
  it("each expiry uses its own carry for its own legs", () => {
    const far = [leg({ expiry: FAR, strike: 25000, type: "CE", action: "BUY", premium: 300, iv: 0.15 })];
    const a = pnlAtExpiry(far, 25000, NEAR, LOT, { ...V, carry: 0.06 }) as number;
    const b = pnlAtExpiry(far, 25000, NEAR, LOT, { ...V, carry: 0.06, carryByExpiry: { [FAR]: 0.0 } }) as number;
    expect(b).toBeLessThan(a); // a lower forward makes a call worth less
    expect(b).toBeCloseTo(LOT * (black76("CE", 25000, 25000, 7 / 365, 0.15, 0.06) - 300), 8);
  });
  it("the function form with the exact payoff equals the original estimate", () => {
    const legs = [leg({ expiry: NEAR, strike: 25000, type: "CE", action: "SELL", premium: 200 }), leg({ expiry: NEAR, strike: 25000, type: "PE", action: "SELL", premium: 180 })];
    const p1 = probabilityOfProfit(legs, LOT, 25000, 0.15, NEAR, NOW, 0.06);
    const p2 = probabilityOfProfitFn((s) => expiryPnl(legs, s, LOT), 25000, 0.15, NEAR, NOW, 0.06);
    expect(p2).toBe(p1);
    expect(p1).toBeGreaterThan(0.2);
    expect(p1).toBeLessThan(0.9);
  });
});

describe("curveOf", () => {
  it("samples the function and returns nothing when a level cannot be valued", () => {
    expect(curveOf((s) => s * 2, 1, 3, 1)).toEqual([{ s: 1, pnl: 2 }, { s: 2, pnl: 4 }, { s: 3, pnl: 6 }]);
    expect(curveOf((s) => (s > 2 ? null : s), 1, 3, 1)).toEqual([]);
  });
});

describe("calendar templates", () => {
  const ks = [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200];
  const ctx = { strikes: ks, atm: 25000, expiry: NEAR, far: FAR, farStrikes: ks, premium: (e: string, k: number) => (e === NEAR ? 100 : 200) + (k - 25000) / 100 };
  it("calendar call: sell the near ATM call, buy the far ATM call", () => {
    const out = TEMPLATES.find((t) => t.id === "calendar_call")!.build(ctx);
    expect(out).toEqual([
      { expiry: NEAR, strike: 25000, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market" },
      { expiry: FAR, strike: 25000, type: "CE", action: "BUY", lots: 1, premium: 200, premiumSource: "market" },
    ]);
  });
  it("diagonal call: far ATM bought, near call two steps up sold", () => {
    const out = TEMPLATES.find((t) => t.id === "diagonal_call")!.build(ctx) as { expiry: string; strike: number; action: string }[];
    expect(out.map((l) => [l.expiry, l.strike, l.action])).toEqual([[FAR, 25000, "BUY"], [NEAR, 25100, "SELL"]]);
  });
  it("double calendar has four legs on two strikes and two expiries", () => {
    const out = TEMPLATES.find((t) => t.id === "double_calendar")!.build(ctx) as { expiry: string; strike: number }[];
    expect(out).toHaveLength(4);
    expect(new Set(out.map((l) => l.expiry))).toEqual(new Set([NEAR, FAR]));
    expect(new Set(out.map((l) => l.strike))).toEqual(new Set([25100, 24900]));
  });
  it("says so when there is no later expiry or the later chain lacks the strike", () => {
    const t = TEMPLATES.find((x) => x.id === "calendar_put")!;
    expect(t.build({ ...ctx, far: undefined })).toEqual({ error: expect.stringContaining("later expiry") });
    expect(t.build({ ...ctx, farStrikes: [24800] })).toEqual({ error: expect.stringContaining("no listed strike 25000") });
  });
});
