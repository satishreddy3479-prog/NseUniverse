import { describe, expect, it } from "vitest";
import vectors from "./vectors/black76.json";
import {
  analyzeExpiry, black76, cnd, DEFAULT_COSTS, executionCost, expiryEnd, expiryPnl, impliedVol, netGreeks, payoffCurve,
  roundTripCost, TEMPLATES, theoreticalPnl, validateStrategy, withIds, type Leg, type TemplateContext, type Valuation,
} from "../lib/strategy";

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
  it("multi-expiry strategies have no single expiry payoff", () => {
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

describe("Black-76 and Greeks", () => {
  it("matches the backend implementation (vectors generated from app/intraday/volatility.py)", () => {
    for (const v of vectors) expect(black76(v.type as "CE" | "PE", v.f, v.k, v.t, v.sigma, v.r)).toBeCloseTo(v.price, 7);
  });
  it("normal CDF: symmetry and known values", () => {
    expect(cnd(0)).toBeCloseTo(0.5, 12);
    expect(cnd(1.96)).toBeCloseTo(0.9750021048517795, 9);
    expect(cnd(-1.96) + cnd(1.96)).toBeCloseTo(1, 12);
  });
  it("put-call parity: C - P = e^{-rT}(F - K)", () => {
    const [f, k, t, s, r] = [24100, 24000, 9 / 365, 0.17, 0.06];
    expect(black76("CE", f, k, t, s, r) - black76("PE", f, k, t, s, r)).toBeCloseTo(Math.exp(-r * t) * (f - k), 9);
  });
  it("implied volatility recovers the volatility that priced the option and refuses impossible prices", () => {
    const px = black76("CE", 24000, 24150, 7 / 365, 0.21, 0.06);
    expect(impliedVol("CE", px, 24000, 24150, 7 / 365, 0.06)).toBeCloseTo(0.21, 6);
    expect(impliedVol("CE", 0.0001, 24000, 20000, 7 / 365, 0.06)).toBeNull(); // below intrinsic
    expect(impliedVol("CE", 100, 24000, 24000, 0, 0.06)).toBeNull();
  });

  const NOW = Date.UTC(2026, 9, 29, 4, 30); // 10:00 IST on 29 Oct
  const SPOT = 24000;
  const val: Valuation = { spotNow: SPOT, nowMs: NOW, rate: 0.06, ivShift: 0 };
  const T = (expiryEnd("2026-11-03") - NOW) / (365 * 86_400_000);
  const modelPrice = (type: "CE" | "PE", k: number, sigma: number) => black76(type, SPOT * Math.exp(0.06 * T), k, T, sigma, 0.06);
  const strat = () => [leg("BUY", "CE", 24000, modelPrice("CE", 24000, 0.15)), leg("SELL", "PE", 23800, modelPrice("PE", 23800, 0.18))];

  it("the expiry date is the session close, 15:40 IST", () => {
    expect(new Date(expiryEnd("2026-11-03")).toISOString()).toBe("2026-11-03T10:10:00.000Z");
  });
  it("at the entry spot and time the theoretical P&L is zero (entry premium = model value)", () => {
    expect(theoreticalPnl(strat(), SPOT, NOW, LOT, val) as number).toBeCloseTo(0, 3); // volatility is solved to 1e-8, worth well under a paisa
  });
  it("at expiry the theoretical P&L equals the exact expiry payoff", () => {
    const s = strat();
    for (const x of [23500, 23900, 24000, 24300]) expect(theoreticalPnl(s, x, expiryEnd("2026-11-03"), LOT, val) as number).toBeCloseTo(pnl(s, x), 9);
  });
  it("net Greeks agree with numerical differences of the theoretical P&L (independent check)", () => {
    const s = strat();
    const f = (spot: number, at = NOW, shift = 0) => theoreticalPnl(s, spot, at, LOT, { ...val, ivShift: shift }) as number;
    const g = netGreeks(s, LOT, val);
    const h = 1;
    expect(g.delta).toBeCloseTo((f(SPOT + h) - f(SPOT - h)) / (2 * h), 4);
    expect(g.gamma).toBeCloseTo((f(SPOT + h) - 2 * f(SPOT) + f(SPOT - h)) / (h * h), 5);
    expect(g.thetaDay).toBeCloseTo(f(SPOT, NOW + 86_400_000) - f(SPOT), 6);
    expect(g.vegaPt).toBeCloseTo(f(SPOT, NOW, 0.01) - f(SPOT), 6);
    expect(g.unavailable).toEqual([]);
  });
  it("a leg whose volatility cannot be found is reported as unavailable, not valued", () => {
    const bad = [leg("BUY", "CE", 24000, 0.5)]; // premium below intrinsic-plus-time: no volatility fits
    const s2 = [{ ...bad[0]!, strike: 20000 }];
    expect(theoreticalPnl(s2, SPOT, NOW, LOT, val)).toBeNull();
    expect(netGreeks(s2, LOT, val).unavailable).toEqual(["CE 20000"]);
  });
});

describe("transaction costs (hand calculated from the stated assumptions)", () => {
  it("buying 65 units at 100: brokerage 20, exchange 0.03503 %, SEBI 0.0001 %, stamp 0.003 %, GST 18 %", () => {
    const turnover = 6500;
    const exch = (turnover * 0.03503) / 100; // 2.276950
    const sebi = (turnover * 0.0001) / 100; // 0.0065
    const stamp = (turnover * 0.003) / 100; // 0.195
    const gst = ((20 + exch + sebi) * 18) / 100;
    expect(executionCost("BUY", 100, 65, DEFAULT_COSTS)).toBeCloseTo(20 + exch + sebi + stamp + gst, 9);
  });
  it("selling pays STT on the premium and no stamp duty", () => {
    const sell = executionCost("SELL", 100, 65, DEFAULT_COSTS);
    const buy = executionCost("BUY", 100, 65, DEFAULT_COSTS);
    expect(sell - buy).toBeCloseTo((6500 * 0.1) / 100 - (6500 * 0.003) / 100, 9);
  });
  it("slippage is paid per unit on every execution", () => {
    const c = { ...DEFAULT_COSTS, slippagePerUnit: 0.5 };
    expect(executionCost("BUY", 100, 65, c) - executionCost("BUY", 100, 65, DEFAULT_COSTS)).toBeCloseTo(32.5, 9);
  });
  it("round trip = entry + exit of every leg", () => {
    const s = [leg("BUY", "CE", 24000, 100)];
    const rt = roundTripCost(s, () => 150, LOT, DEFAULT_COSTS);
    expect(rt).toBeCloseTo(executionCost("BUY", 100, 65, DEFAULT_COSTS) + executionCost("SELL", 150, 65, DEFAULT_COSTS), 9);
  });
});

describe("templates and validation", () => {
  const strikes = Array.from({ length: 21 }, (_, i) => 23500 + i * 50); // 23500 .. 24500
  const ctx: TemplateContext = { strikes, atm: 24000, expiry: "2026-11-03", nextExpiry: "2026-11-10", premium: (e, k, t) => (e === "2026-11-03" ? Math.abs(k - 24000) / 10 + (t === "CE" ? 5 : 4) : null) };
  it("every template builds editable legs on listed strikes", () => {
    for (const t of TEMPLATES) {
      const r = t.build(ctx);
      if ("error" in r) { expect(t.group).toBe("Multi-expiry"); continue; }
      expect(r.length).toBeGreaterThan(0);
      for (const l of r) expect(strikes).toContain(l.strike);
    }
    expect(TEMPLATES.map((t) => t.id)).toEqual(expect.arrayContaining(["long_call", "long_put", "short_call", "short_put", "long_straddle", "short_straddle", "long_strangle", "short_strangle", "bull_call_spread", "bear_put_spread", "bull_put_spread", "bear_call_spread", "iron_condor", "iron_butterfly", "butterfly", "calendar", "diagonal", "ratio_spread"]));
  });
  it("iron condor strikes are two and four listed strikes either side of the ATM", () => {
    const r = TEMPLATES.find((t) => t.id === "iron_condor")!.build(ctx) as Omit<Leg, "id">[];
    expect(r.map((l) => `${l.action} ${l.type} ${l.strike}`)).toEqual(["SELL PE 23900", "BUY PE 23800", "SELL CE 24100", "BUY CE 24200"]);
  });
  it("legs on the next expiry have no premium unless a quote is supplied, and say so", () => {
    const r = TEMPLATES.find((t) => t.id === "calendar")!.build(ctx) as Omit<Leg, "id">[];
    expect(r[1]!.expiry).toBe("2026-11-10");
    expect(r[1]!.premium).toBeNull();
    expect(r[1]!.premiumSource).toBeNull();
  });
  it("a template that does not fit the chain says why", () => {
    const small: TemplateContext = { ...ctx, strikes: [23950, 24000, 24050] };
    expect((TEMPLATES.find((t) => t.id === "iron_condor")!.build(small) as { error: string }).error).toMatch(/no listed strike/);
    expect((TEMPLATES.find((t) => t.id === "calendar")!.build({ ...ctx, nextExpiry: null }) as { error: string }).error).toMatch(/second expiry/);
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
