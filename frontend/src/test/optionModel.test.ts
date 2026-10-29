import { describe, expect, it } from "vitest";
import vectors from "./vectors/black76.json";
import { black76, cnd, contractDelta, expiryEnd, impliedVol, netGreeks, probabilityOfProfit, sdBands, theoreticalPnl, type Valuation } from "../lib/optionModel";
import { expiryPnl, type Leg } from "../lib/strategy";

const LOT = 65;
let n = 0;
const leg = (action: "BUY" | "SELL", type: "CE" | "PE", strike: number, premium: number | null, lots = 1, expiry = "2026-11-03"): Leg =>
  ({ id: `m${n++}`, expiry, strike, type, action, lots, premium, premiumSource: premium == null ? null : "manual" });
const pnl = (legs: Leg[], s: number) => expiryPnl(legs, s, LOT) as number;

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


describe("probability of profit and standard-deviation bands", () => {
  const NOW = Date.UTC(2026, 9, 29, 4, 30);
  it("a long call at the money wins a little under half the time; a short call a little over half", () => {
    const sig = 0.15;
    const f = (a: "BUY" | "SELL", prem: number) => probabilityOfProfit([leg(a, "CE", 24000, prem)], LOT, 24000, sig, "2026-11-03", NOW, 0.06) as number;
    const lc = f("BUY", 170), sc = f("SELL", 170);
    expect(lc + sc).toBeCloseTo(1, 3); // every outcome is a profit for exactly one side (premium 170 means no exact-zero outcomes)
    expect(lc).toBeGreaterThan(0.3);
    expect(lc).toBeLessThan(0.5);
  });
  it("matches the closed form for a long call: P(S_T > K + premium) under the same lognormal", () => {
    const t = (expiryEnd("2026-11-03") - NOW) / (365 * 86_400_000), sigma = 0.2, spot = 24000, prem = 100;
    const mu = Math.log(spot * Math.exp(0.06 * t)) - 0.5 * sigma * sigma * t, sd = sigma * Math.sqrt(t);
    const exact = 1 - cnd((Math.log(24000 + prem) - mu) / sd);
    expect(probabilityOfProfit([leg("BUY", "CE", 24000, prem)], LOT, spot, sigma, "2026-11-03", NOW, 0.06) as number).toBeCloseTo(exact, 3);
  });
  it("is unavailable, not guessed, without a volatility or after expiry", () => {
    expect(probabilityOfProfit([leg("BUY", "CE", 24000, 100)], LOT, 24000, 0, "2026-11-03", NOW, 0.06)).toBeNull();
    expect(probabilityOfProfit([leg("BUY", "CE", 24000, 100)], LOT, 24000, 0.2, "2026-11-03", Date.UTC(2026, 10, 4), 0.06)).toBeNull();
    expect(probabilityOfProfit([leg("BUY", "CE", 24000, null)], LOT, 24000, 0.2, "2026-11-03", NOW, 0.06)).toBeNull();
  });
  it("one standard deviation = spot x volatility x sqrt(time)", () => {
    const t = (expiryEnd("2026-11-03") - NOW) / (365 * 86_400_000);
    const b = sdBands(24000, 0.16, "2026-11-03", NOW)!;
    expect(b.p1 - 24000).toBeCloseTo(24000 * 0.16 * Math.sqrt(t), 6);
    expect(b.p2 - 24000).toBeCloseTo(2 * (b.p1 - 24000), 9);
    expect(b.m1 - 24000).toBeCloseTo(-(b.p1 - 24000), 9);
  });
  it("contract delta: call delta between 0 and 1, put delta between -1 and 0, parity delta_c - delta_p = 1", () => {
    const t = (expiryEnd("2026-11-03") - NOW) / (365 * 86_400_000);
    const F = 24000 * Math.exp(0.06 * t);
    const c = contractDelta("CE", black76("CE", F, 24100, t, 0.17, 0.06), 24000, 24100, "2026-11-03", NOW, 0.06)!;
    const p = contractDelta("PE", black76("PE", F, 24100, t, 0.17, 0.06), 24000, 24100, "2026-11-03", NOW, 0.06)!;
    expect(c.iv).toBeCloseTo(0.17, 6);
    expect(c.delta - p.delta).toBeCloseTo(1, 6);
    expect(contractDelta("CE", null, 24000, 24100, "2026-11-03", NOW, 0.06)).toBeNull();
  });
});
