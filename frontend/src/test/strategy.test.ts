import { describe, expect, it } from "vitest";
import { analyzeExpiry, expiryPnl, payoffCurve, TEMPLATES, validateStrategy, withIds, type Leg, type TemplateContext } from "../lib/strategy";

const LOT = 65;
let n = 0;
const leg = (action: "BUY" | "SELL", type: "CE" | "PE", strike: number, premium: number | null, lots = 1, expiry = "2026-11-03"): Leg =>
  ({ id: `t${n++}`, expiry, strike, type, action, lots, premium, premiumSource: premium == null ? null : "manual" });
const pnl = (legs: Leg[], s: number) => expiryPnl(legs, s, LOT) as number;

describe("single-leg expiry payoff (hand calculated, lot size 65)", () => {
  it("long call: (max(S-K,0) - premium) x 65", () => {
    const c = [leg("BUY", "CE", 24000, 100)];
    expect(pnl(c, 24000)).toBe(-6500); // loses the whole premium: 100 x 65
    expect(pnl(c, 24300)).toBe(13000); // (300 - 100) x 65
    const a = analyzeExpiry(c, LOT);
    expect(a.breakevens).toEqual([24100]);
    expect(a.maxLoss).toBe(-6500);
    expect(a.profitUnlimited).toBe(true);
    expect(a.maxProfit).toBeNull();
  });
  it("long put: profit is bounded because the underlying cannot go below zero", () => {
    const p = [leg("BUY", "PE", 24000, 80)];
    expect(pnl(p, 23800)).toBe(7800); // (200 - 80) x 65
    const a = analyzeExpiry(p, LOT);
    expect(a.breakevens).toEqual([23920]);
    expect(a.maxLoss).toBe(-5200);
    expect(a.maxProfit).toBe((24000 - 80) * 65); // at S = 0
    expect(a.profitUnlimited).toBe(false);
  });
  it("short call and short put mirror the long ones", () => {
    const sc = [leg("SELL", "CE", 24000, 100)];
    expect(pnl(sc, 24300)).toBe(-13000);
    const a = analyzeExpiry(sc, LOT);
    expect(a.maxProfit).toBe(6500);
    expect(a.lossUnlimited).toBe(true);
    expect(a.maxLoss).toBeNull();
    const sp = [leg("SELL", "PE", 24000, 80)];
    expect(pnl(sp, 23800)).toBe(-7800);
    const b = analyzeExpiry(sp, LOT);
    expect(b.maxProfit).toBe(5200);
    expect(b.maxLoss).toBe(-(24000 - 80) * 65);
  });
  it("quantity multiplies by lots and the contract size", () => {
    expect(pnl([leg("BUY", "CE", 24000, 100, 3)], 24300)).toBe((300 - 100) * 3 * 65);
  });
  it("zero intrinsic and deep in the money", () => {
    const c = [leg("BUY", "CE", 24000, 100)];
    expect(pnl(c, 20000)).toBe(-6500);
    expect(pnl(c, 30000)).toBe((6000 - 100) * 65);
  });
});

describe("multi-leg strategies", () => {
  it("bull call spread: buy 24000 @150, sell 24200 @60", () => {
    const s = [leg("BUY", "CE", 24000, 150), leg("SELL", "CE", 24200, 60)];
    const a = analyzeExpiry(s, LOT);
    expect(a.maxProfit).toBe((200 - 90) * 65); // width 200 minus net debit 90
    expect(a.maxLoss).toBe(-90 * 65);
    expect(a.breakevens).toEqual([24090]);
    expect(a.profitUnlimited || a.lossUnlimited).toBe(false);
  });
  it("long straddle has two breakevens; short strangle has unlimited loss both ways round the range", () => {
    const st = [leg("BUY", "CE", 24000, 100), leg("BUY", "PE", 24000, 80)];
    const a = analyzeExpiry(st, LOT);
    expect(a.breakevens).toEqual([23820, 24180]);
    expect(a.maxLoss).toBe(-180 * 65);
    const sg = [leg("SELL", "CE", 24200, 50), leg("SELL", "PE", 23800, 40)];
    const b = analyzeExpiry(sg, LOT);
    expect(b.breakevens).toEqual([23710, 24290]);
    expect(b.maxProfit).toBe(90 * 65);
    expect(b.lossUnlimited).toBe(true);
  });
  it("iron condor: credit 55, width 200", () => {
    const ic = [leg("SELL", "PE", 23800, 40), leg("BUY", "PE", 23600, 15), leg("SELL", "CE", 24200, 50), leg("BUY", "CE", 24400, 20)];
    const a = analyzeExpiry(ic, LOT);
    expect(a.maxProfit).toBe(55 * 65);
    expect(a.maxLoss).toBe(-(200 - 55) * 65);
    expect(a.breakevens).toEqual([23745, 24255]);
  });
  it("call butterfly: debit 40, peak at the middle strike", () => {
    const b = [leg("BUY", "CE", 23800, 220), leg("SELL", "CE", 24000, 110, 2), leg("BUY", "CE", 24200, 40)];
    const a = analyzeExpiry(b, LOT);
    expect(a.maxProfit).toBe((200 - 40) * 65);
    expect(a.maxLoss).toBe(-40 * 65);
    expect(a.breakevens).toEqual([23840, 24160]);
  });
  it("1:2 call ratio spread: profit capped, unlimited loss above", () => {
    const r = [leg("BUY", "CE", 24000, 150), leg("SELL", "CE", 24200, 60, 2)];
    const a = analyzeExpiry(r, LOT);
    expect(a.maxProfit).toBe(170 * 65); // at 24200: long 200-150, short 2 x 60
    expect(a.breakevens).toEqual([24030, 24370]);
    expect(a.lossUnlimited).toBe(true);
  });
  it("a strategy with a finite payoff everywhere reports no unbounded side", () => {
    const a = analyzeExpiry([leg("BUY", "PE", 24000, 80), leg("SELL", "PE", 23800, 30)], LOT);
    expect(a.profitUnlimited).toBe(false);
    expect(a.lossUnlimited).toBe(false);
  });
  it("the curve matches the exact payoff at every point", () => {
    const s = [leg("BUY", "CE", 24000, 150), leg("SELL", "CE", 24200, 60)];
    const curve = payoffCurve(s, LOT, 23800, 24400, 50);
    expect(curve).toHaveLength(13);
    for (const p of curve) expect(p.pnl).toBe(pnl(s, p.s));
    expect(Math.max(...curve.map((p) => p.pnl))).toBe(analyzeExpiry(s, LOT).maxProfit);
  });
});

describe("incomplete or unsupported input is reported, never guessed", () => {
  it("legs on different expiries have no single expiry payoff", () => {
    const a = analyzeExpiry([leg("SELL", "CE", 24000, 100), leg("BUY", "CE", 24000, 190, 1, "2026-11-24")], LOT);
    expect(a.defined).toBe(false);
    expect(a.reason).toMatch(/different dates/);
  });
  it("a missing premium makes the payoff undefined, not zero", () => {
    const l = [leg("BUY", "CE", 24000, null)];
    expect(expiryPnl(l, 24100, LOT)).toBeNull();
    expect(analyzeExpiry(l, LOT).defined).toBe(false);
    expect(payoffCurve(l, LOT, 23900, 24100, 50)).toEqual([]);
  });
  it("no legs", () => expect(analyzeExpiry([], LOT).defined).toBe(false));
});

describe("templates and validation", () => {
  const strikes = Array.from({ length: 21 }, (_, i) => 23500 + i * 50); // 23500 .. 24500
  const ctx: TemplateContext = { strikes, atm: 24000, expiry: "2026-11-03", premium: (_e, k, t) => Math.abs(k - 24000) / 10 + (t === "CE" ? 5 : 4) };
  it("every one of the 16 templates builds editable legs on listed strikes", () => {
    for (const t of TEMPLATES) {
      const r = t.build(ctx);
      if ("error" in r) throw new Error(`${t.id}: ${r.error}`);
      expect(r.length).toBeGreaterThan(0);
      for (const l of r) expect(strikes).toContain(l.strike);
    }
    expect(TEMPLATES.map((t) => t.id)).toEqual(expect.arrayContaining(["long_call", "long_put", "short_call", "short_put", "long_straddle", "short_straddle", "long_strangle", "short_strangle", "bull_call_spread", "bear_put_spread", "bull_put_spread", "bear_call_spread", "iron_condor", "iron_butterfly", "butterfly", "ratio_spread"]));
  });
  it("iron condor strikes are two and four listed strikes either side of the ATM", () => {
    const r = TEMPLATES.find((t) => t.id === "iron_condor")!.build(ctx) as Omit<Leg, "id">[];
    expect(r.map((l) => `${l.action} ${l.type} ${l.strike}`)).toEqual(["SELL PE 23900", "BUY PE 23800", "SELL CE 24100", "BUY CE 24200"]);
  });
  it("a template that does not fit the chain says why", () => {
    const small: TemplateContext = { ...ctx, strikes: [23950, 24000, 24050] };
    expect((TEMPLATES.find((t) => t.id === "iron_condor")!.build(small) as { error: string }).error).toMatch(/no listed strike/);
  });
  it("validation catches bad lots, unlisted strikes, past or unknown expiries, negative and missing premiums, duplicates", () => {
    const vctx = { expiries: ["2026-11-03", "2026-11-10"], strikesByExpiry: { "2026-11-03": strikes }, today: "2026-10-29" };
    const legs = withIds([
      { expiry: "2026-11-03", strike: 24025, type: "CE", action: "BUY", lots: 1, premium: 10, premiumSource: "manual" },
      { expiry: "2026-11-03", strike: 24000, type: "CE", action: "BUY", lots: 0, premium: -1, premiumSource: "manual" },
      { expiry: "2026-10-27", strike: 24000, type: "PE", action: "BUY", lots: 1, premium: null, premiumSource: null },
      { expiry: "2026-12-31", strike: 24000, type: "PE", action: "SELL", lots: 1, premium: 5, premiumSource: "manual" },
      { expiry: "2026-11-10", strike: 24000, type: "PE", action: "SELL", lots: 1, premium: 5, premiumSource: "manual" },
      { expiry: "2026-11-10", strike: 24000, type: "PE", action: "SELL", lots: 1, premium: 5, premiumSource: "manual" },
    ]);
    const msgs = validateStrategy(legs, vctx).map((i) => `${i.level}:${i.field}`);
    expect(msgs).toEqual(expect.arrayContaining(["error:strike", "error:lots", "error:premium", "error:expiry", "warning:premium", "warning:leg"]));
    expect(validateStrategy([legs[4]!], vctx).filter((i) => i.level === "error")).toEqual([]);
  });
});

import { applyAutomation, applyStrategyRules, hitOf, lockFloor, NO_RULES, rulesProblem, trailLeg } from "../lib/strategy";

describe("percentage trailing stop (hand calculated)", () => {
  const sold: Leg = { id: "a", expiry: "2026-11-09", strike: 23300, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", stop: 130, trailEvery: 10, trailBy: 5 };
  it("moves the stop 5 % of the entry for every 10 % the sold leg falls, only tightens, and may end on the profit side", () => {
    expect(trailLeg(sold, 95)).toBe(sold); // 5 %: no full step
    expect(trailLeg(sold, 90).stop).toBe(125);
    const two = trailLeg(sold, 80);
    expect(two).toMatchObject({ stop: 120, stopBase: 130, stopTrailed: true });
    expect(trailLeg(two, 90)).toBe(two); // price came back: stop stays
    const far = trailLeg(two, 30); // 70 % = seven steps: 130 - 35
    expect(far.stop).toBe(95);
    expect(hitOf(far, "stop", 95)).toBe(true);
    expect(hitOf(far, "stop", 94.95)).toBe(false);
    expect(hitOf({ ...sold, stop: 95 }, "stop", 95)).toBe(false); // a typed stop on the profit side is still a slip
  });
  it("works for a bought leg and ignores incomplete or impossible settings", () => {
    const buy: Leg = { ...sold, action: "BUY", stop: 70 };
    expect(trailLeg(buy, 120).stop).toBe(80); // +20 %: two steps of 5 up from 70
    expect(trailLeg({ ...sold, trailBy: null }, 50)).toEqual({ ...sold, trailBy: null });
    expect(trailLeg({ ...sold, trailBy: 20 }, 50).stop).toBe(130); // moving by more than the step is ignored
    expect(trailLeg({ ...sold, stop: null }, 50).stop).toBeNull();
  });
  it("applyAutomation trails first and then closes at the trailed stop, keeping the stop distance the user set for a re-entry", () => {
    const priced = (px: number) => () => px;
    let r = applyAutomation([{ ...sold, target: null, reentry: 1 }], priced(80), 65, "2026-11-05T04:00:00Z");
    expect(r.legs[0]!.stop).toBe(120);
    expect(r.events[0]).toContain("Trailing stop");
    r = applyAutomation(r.legs, priced(120.5), 65, "2026-11-05T04:00:01Z");
    expect(r.legs[0]).toMatchObject({ exitPrice: 120.5, exitReason: "stop" });
    expect(r.legs[0]!.stopPct).toBeCloseTo(0.3, 9);
    r = applyAutomation(r.legs, priced(99), 65, "2026-11-05T04:00:02Z");
    expect(r.legs[0]!.stop).toBeCloseTo(128.7, 2);
    expect(r.legs[0]!.stopTrailed).toBe(false);
  });
});

describe("strategy stop loss, target and lock-and-trail (hand calculated, lot 65)", () => {
  const leg = (id: string, strike: number, type: "CE" | "PE", premium: number): Leg => ({ id, expiry: "2026-11-09", strike, type, action: "SELL", lots: 1, premium, premiumSource: "market" });
  it("lock floor: 1,000 locks 500, then +200 for every further 300", () => {
    const r = { ...NO_RULES, lockAt: 1000, lockProfit: 500, trailEvery: 300, trailBy: 200 };
    expect([999, 1000, 1299, 1300, 1625].map((p) => lockFloor(r, p))).toEqual([null, 500, 500, 700, 900]);
    expect(lockFloor({ ...r, trailEvery: null, trailBy: null }, 5000)).toBe(500);
    expect(lockFloor({ ...r, lockProfit: 1000 }, 5000)).toBeNull();
    expect(rulesProblem({ ...r, lockProfit: 1000 })).toMatch(/below/);
    expect(lockFloor({ ...r, trailBy: 400 }, 5000)).toBeNull();
    expect(rulesProblem({ ...NO_RULES, trailEvery: 100, trailBy: 50 })).toMatch(/after a lock/);
  });
  it("a stop loss closes every open leg at its live price, nothing re-enters, and it never fires twice", () => {
    const legs = [{ ...leg("a", 23300, "CE", 100), reentry: 2 }, { ...leg("b", 23100, "PE", 80), reentry: 2 }];
    const px = { 23300: 100, 23100: 80 } as Record<number, number>;
    const price = (k: number) => px[k] ?? null;
    const rules = { ...NO_RULES, sl: 2000, target: 3000 };
    const empty = { floor: null, done: null } as const;
    px[23300] = 115; px[23100] = 95; // -(15 + 15) x 65 = -1,950: inside
    expect(applyStrategyRules(legs, rules, empty, price, 65, "t").events).toEqual([]);
    px[23300] = 116; // -2,015
    const r = applyStrategyRules(legs, rules, empty, price, 65, "2026-11-05T04:00:00Z");
    expect(r.state.done).toBe("sl");
    expect(r.legs.map((l) => l.exitReason)).toEqual(["strategy", "strategy"]);
    expect(r.legs.every((l) => l.reentry === 0)).toBe(true);
    expect(r.legs.reduce((t, l) => t + (l.realised ?? 0), 0)).toBeCloseTo(-2015, 6);
    expect(r.events[0]).toContain("Strategy stop loss");
    expect(applyStrategyRules(r.legs, rules, r.state, price, 65, "t").events).toEqual([]);
    px[23300] = 50; px[23100] = 40; // multiplier 2: (50 + 40) x 65 x 2 = 11,700
    expect(applyStrategyRules(legs, rules, empty, price, 65, "t", 2).state.done).toBe("target");
  });
  it("the floor only rises and the strategy exits when the P&L falls back to it", () => {
    let legs = [leg("a", 23300, "CE", 100)];
    let state: { floor: number | null; done: "sl" | "target" | "lock" | null } = { floor: null, done: null };
    let px = 85;
    const rules = { ...NO_RULES, lockAt: 1000, lockProfit: 500, trailEvery: 300, trailBy: 200 };
    const step = (p: number) => { px = p; const r = applyStrategyRules(legs, rules, state, () => px, 65, "2026-11-05T04:00:00Z"); legs = r.legs; state = r.state; return r; };
    step(85); expect(state.floor).toBeNull(); // 975
    step(80); expect(state.floor).toBe(700); // 1,300
    step(75); expect(state.floor).toBe(900); // 1,625
    expect(step(78).events).toEqual([]); // 1,430: below the peak, floor stays 900
    expect(state.floor).toBe(900);
    expect(step(86).events).toEqual([]); // 910
    const r = step(86.5); // 877.5: through the floor
    expect(state.done).toBe("lock");
    expect(legs[0]).toMatchObject({ exitPrice: 86.5, exitReason: "strategy" });
    expect(legs[0]!.realised).toBeCloseTo(877.5, 6);
    expect(r.events[0]).toContain("Locked profit");
  });
  it("waits for every open leg to have a price", () => {
    const legs = [leg("a", 23300, "CE", 100), leg("b", 23100, "PE", 80)];
    const r = applyStrategyRules(legs, { ...NO_RULES, sl: 10 }, { floor: null, done: null }, (k) => (k === 23300 ? 500 : null), 65, "t");
    expect(r.legs).toBe(legs);
    expect(r.events).toEqual([]);
  });
});
