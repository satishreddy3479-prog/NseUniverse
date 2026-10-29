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
