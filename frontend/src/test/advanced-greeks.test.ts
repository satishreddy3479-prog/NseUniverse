import { describe, expect, it } from "vitest";
import {
  attribution, closeToCloseVol, forwardVol, gammaThetaBreakeven, greekLadder, hedgeSheet, largestMoves, optRisk, positionGreeks, reverseStress, smileMetrics,
  stressGrid, valueAtRisk, vegaBuckets, smileFactors, deltaFlipSpot, type PLeg,
} from "../lib/advancedGreeks";
import { black76, expiryEnd } from "../lib/optionModel";

const EXP = "2026-12-29";
const now = Date.UTC(2026, 10, 23, 5, 0, 0); // 23 Nov 2026 10:30 IST
const T = (expiryEnd(EXP) - now) / (365 * 86_400_000);
const m = { rate: 0.065 };
const px = (type: "CE" | "PE", S: number, K: number, sigma: number, c: number, t = T) => black76(type, S * Math.exp(c * t), K, t, sigma, m.rate);

describe("closed-form Greeks equal finite differences of the Black-76 price", () => {
  for (const type of ["CE", "PE"] as const) {
    it(`${type} 25400 at 25300, iv 16 %, carry 6 %`, () => {
      const S = 25300, K = 25400, s = 0.16, c = 0.06;
      const g = optRisk(type, S, K, T, s, m.rate, c)!;
      const hS = 1, hv = 1e-4, hT = 1e-5;
      const delta = (px(type, S + hS, K, s, c) - px(type, S - hS, K, s, c)) / (2 * hS);
      const gamma = (px(type, S + hS, K, s, c) - 2 * px(type, S, K, s, c) + px(type, S - hS, K, s, c)) / (hS * hS);
      const vega = (px(type, S, K, s + hv, c) - px(type, S, K, s - hv, c)) / (2 * hv);
      const d = (ss: number, v: number, t = T) => optRisk(type, ss, K, t, v, m.rate, c)!;
      const vanna = (d(S, s + hv).delta - d(S, s - hv).delta) / (2 * hv);
      const volga = (d(S, s + hv).vega - d(S, s - hv).vega) / (2 * hv);
      const charm = -((d(S, s, T + hT).delta - d(S, s, T - hT).delta) / (2 * hT)) / 365;
      expect(g.delta).toBeCloseTo(delta, 6);
      expect(g.gamma).toBeCloseTo(gamma, 6);
      expect(g.vega).toBeCloseTo(vega, 3);
      expect(g.vanna).toBeCloseTo(vanna, 4);
      expect(g.volga / 1000).toBeCloseTo(volga / 1000, 3);
      expect(g.charmDay).toBeCloseTo(charm, 6);
    });
  }
  it("put-call parity on delta: delta(call) - delta(put) = e^((c-r)T)", () => {
    const c = optRisk("CE", 25000, 25000, T, 0.15, m.rate, 0.05)!, p = optRisk("PE", 25000, 25000, T, 0.15, m.rate, 0.05)!;
    expect(c.delta - p.delta).toBeCloseTo(Math.exp((0.05 - m.rate) * T), 10);
    expect(c.gamma).toBeCloseTo(p.gamma, 12);
    expect(c.vanna).toBeCloseTo(p.vanna, 12);
  });
  it("invalid inputs give null, not a number", () => {
    expect(optRisk("CE", 25000, 25000, 0, 0.15, m.rate, 0)).toBeNull();
    expect(optRisk("CE", 25000, 25000, T, 0, m.rate, 0)).toBeNull();
  });
});

const leg = (o: Partial<PLeg>): PLeg => ({ id: "a", type: "CE", strike: 25400, expiry: EXP, qty: -65, iv: 0.16, carry: 0.06, entry: null, ...o });

describe("position Greeks, ladder, hedge", () => {
  it("a future is delta qty x e^(cT), no gamma or vega; a leg with no volatility is listed, never counted as zero", () => {
    const g = positionGreeks([leg({ type: "FUT", strike: 0, qty: 65 }), leg({ id: "b", iv: null })], 25300, now, m);
    expect(g.delta).toBeCloseTo(65 * Math.exp(0.06 * T), 10);
    expect(g.gamma).toBe(0);
    expect(g.unavailable).toEqual(["25400 CE (no volatility)"]);
  });
  it("short straddle: delta flips sign inside the ladder, hedge lots = -delta / lot size", () => {
    const legs = [leg({ id: "c", type: "CE", strike: 25300 }), leg({ id: "p", type: "PE", strike: 25300 })];
    const rows = greekLadder(legs, 25300, now, m);
    const flip = deltaFlipSpot(rows);
    expect(rows.find((r) => r.pct === 0)!.pnl).toBe(0);
    expect(flip).not.toBeNull();
    const h = hedgeSheet(rows, 65)!;
    expect(h.now).toBeCloseTo(-rows.find((r) => r.pct === 0)!.greeks.delta / 65, 12);
    expect(h.rows.find((r) => r.pct === 0)!.adjust).toBeCloseTo(0, 12);
    // short gamma: after a rally the position is short delta, so the hedge is to buy
    expect(h.rows.find((r) => r.pct === 2)!.lots).toBeGreaterThan(h.now);
  });
  it("ladder P&L at +1 % equals the repriced position", () => {
    const legs = [leg({})];
    const row = greekLadder(legs, 25300, now, m, [1])[0]!;
    const v = (S: number) => -65 * px("CE", S, 25400, 0.16, 0.06);
    expect(row.pnl).toBeCloseTo(v(25300 * 1.01) - v(25300), 8);
  });
});

describe("breakeven and calendar maths", () => {
  it("gamma 0.001, theta -50: m = sqrt(2 x 50 / 0.001) = 316.23; same signs: no breakeven", () => {
    const b = gammaThetaBreakeven(0.001, -50, 25000, 0.16, null)!;
    expect(b.points).toBeCloseTo(316.2278, 3);
    expect(b.impliedDay).toBeCloseTo((25000 * 0.16) / Math.sqrt(365), 8);
    expect(b.kind).toBe("long gamma pays theta");
    expect(gammaThetaBreakeven(-0.001, 50, 25000, 0.16, null)!.kind).toBe("short gamma earns theta");
    expect(gammaThetaBreakeven(0.001, 50, 25000, 0.16, null)).toBeNull();
    expect(gammaThetaBreakeven(0.001, 0, 25000, 0.16, null)).toBeNull();
    expect(gammaThetaBreakeven(-0.001, 50, 25000, null, null)!.impliedRatio).toBeNull();
  });
  it("forward vol: flat 20 % stays 20 %; falling total variance has none", () => {
    expect(forwardVol(0.2, 0.1, 0.2, 0.2)).toBeCloseTo(0.2, 12);
    expect(forwardVol(0.2, 0.1, 0.1, 0.15)).toBeNull();
    expect(forwardVol(0.2, 0.2, 0.2, 0.1)).toBeNull();
  });
  it("25-delta quotes interpolate in delta: risk reversal and butterfly by hand", () => {
    const rows = [
      { strike: 25600, ceIv: 0.18, ceDelta: 0.3, peIv: null, peDelta: null },
      { strike: 25800, ceIv: 0.2, ceDelta: 0.2, peIv: null, peDelta: null },
      { strike: 25000, ceIv: null, ceDelta: null, peIv: 0.22, peDelta: -0.3 },
      { strike: 24800, ceIv: null, ceDelta: null, peIv: 0.24, peDelta: -0.2 },
    ];
    const s = smileMetrics(rows, 0.2);
    expect(s.call25).toBeCloseTo(0.19, 12); expect(s.put25).toBeCloseTo(0.23, 12);
    expect(s.riskReversal).toBeCloseTo(-0.04, 12); expect(s.butterfly).toBeCloseTo(0.01, 12);
    expect(smileMetrics(rows.slice(0, 2), 0.2).riskReversal).toBeNull();
  });
});

describe("vega buckets and smile factors", () => {
  it("level exposure is the sum of leg vega; a skew shape weights the puts negatively and calls positively as defined", () => {
    const legs = [leg({ id: "1", qty: 65 }), leg({ id: "2", type: "PE", strike: 24000, qty: 65 })];
    const b = vegaBuckets(legs, 25300, now, m), f = smileFactors(legs, 25300, now, m);
    expect(f.level).toBeCloseTo(b.total, 10);
    expect(b.byZone[0]!.vega).toBeGreaterThan(0); // the 24000 put is more than 5 % under the forward
    expect(f.skew).toBeGreaterThan(0); // long a downside put: gains when the downside steepens
    expect(f.curvature).toBeGreaterThan(0);
  });
});

describe("attribution, VaR, stress", () => {
  it("a long future: all delta, 65 x 100 = 6,500, nothing in the other columns", () => {
    const f = leg({ type: "FUT", strike: 0, qty: 65, carry: 0, entry: 25000 });
    const a = attribution([{ leg: f, entrySpot: 25000, entryMs: now - 86_400_000, nowSpot: 25100, nowMs: now, nowPrice: 25100 }], m);
    expect(a.total.delta).toBeCloseTo(6500, 8); expect(a.total.theta).toBeCloseTo(0, 8); expect(a.total.actual).toBeCloseTo(6500, 8);
  });
  it("an option: the parts plus the residual add to the actual P&L, and a small move leaves a small residual", () => {
    const S0 = 25300, S1 = 25340, t0 = now - 3_600_000;
    const T0 = (expiryEnd(EXP) - t0) / (365 * 86_400_000), T1 = T;
    const e = black76("CE", S0 * Math.exp(0.06 * T0), 25400, T0, 0.16, m.rate), n = black76("CE", S1 * Math.exp(0.06 * T1), 25400, T1, 0.16, m.rate);
    const a = attribution([{ leg: leg({ entry: e }), entrySpot: S0, entryMs: t0, nowSpot: S1, nowMs: now, nowPrice: n }], m);
    const t = a.total;
    expect(t.delta + t.gamma + t.vega + t.theta + t.residual).toBeCloseTo(t.actual, 8);
    expect(t.actual).toBeCloseTo(-65 * (n - e), 8);
    expect(Math.abs(t.residual)).toBeLessThan(Math.abs(t.actual) * 0.05);
    expect(Math.abs(t.vega)).toBeLessThan(1e-6);
  });
  it("a leg with no entry price is skipped and named, not guessed", () => {
    const a = attribution([{ leg: leg({}), entrySpot: 25000, entryMs: now, nowSpot: 25000, nowMs: now, nowPrice: 100 }], m);
    expect(a.rows).toHaveLength(0); expect(a.skipped[0]!.name).toBe("25400 CE");
  });
  it("VaR of a long future: delta-normal is z x 65 x S x sigma/sqrt(252); the seeded Monte Carlo agrees within 4 % and is reproducible", () => {
    const f = [leg({ type: "FUT", strike: 0, qty: 65, carry: 0 })];
    const a = valueAtRisk(f, 25000, now, m, 0.16)!, b = valueAtRisk(f, 25000, now, m, 0.16)!;
    const sd = (25000 * 0.16) / Math.sqrt(252);
    expect(a.deltaNormal95).toBeCloseTo(1.6448536 * 65 * sd, 6);
    expect(Math.abs(a.var95 / a.deltaNormal95! - 1)).toBeLessThan(0.04);
    expect(a.es95).toBeGreaterThan(a.var95); expect(a.var99).toBeGreaterThan(a.var95);
    expect(b.var95).toBe(a.var95);
  });
  it("VaR is null when a leg cannot be valued", () => {
    expect(valueAtRisk([leg({ iv: null })], 25000, now, m, 0.16)).toBeNull();
  });
  it("reverse stress on a long future with no carry: losing 6,500 needs -100 points = -0.4 % at 25,000; the up side never loses", () => {
    const r = reverseStress([leg({ type: "FUT", strike: 0, qty: 65, carry: 0 })], 25000, now, m, 6500);
    expect(r.down).toBeCloseTo(-0.4, 6); expect(r.up).toBeNull();
  });
  it("stress grid centre is zero and a long future loses on the down shocks", () => {
    const cells = stressGrid([leg({ type: "FUT", strike: 0, qty: 65, carry: 0 })], 25000, now, m, 0.16);
    expect(cells.find((c) => c.k === 0 && c.volShift === 0)!.pnl).toBeCloseTo(0, 8);
    expect(cells.find((c) => c.k === -2 && c.volShift === 0)!.pnl!).toBeLessThan(0);
  });
  it("realised vol and the largest moves, by hand", () => {
    const r = [Math.log(1.01), Math.log(100 / 101)], mean = (r[0]! + r[1]!) / 2;
    expect(closeToCloseVol([100, 101, 100])).toBeCloseTo(Math.sqrt(((r[0]! - mean) ** 2 + (r[1]! - mean) ** 2) * 252), 10);
    expect(closeToCloseVol([100, 101])).toBeNull();
    const mv = largestMoves([{ day: "a", close: 100 }, { day: "b", close: 97 }, { day: "c", close: 98 }, { day: "d", close: 103 }], 1);
    expect(mv[0]!.label).toBe("b"); expect(mv[0]!.pct).toBeCloseTo(-3, 10); expect(mv[1]!.label).toBe("d");
  });
});
