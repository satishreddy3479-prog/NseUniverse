// Brute-force cross-check of the strategy engine: for many generated strategies, the exact analysis (maximum profit and
// loss, unlimited flags, breakevens) must agree with a plain scan of the expiry payoff on a fine price grid.
import { describe, expect, it } from "vitest";
import { analyzeExpiry, expiryPnl, type Leg } from "../lib/strategy";

let seed = 20261106;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const LOT = 65;

function randomLegs(): Leg[] {
  const n = 1 + Math.floor(rnd() * 5);
  return Array.from({ length: n }, (_, i) => {
    const exited = rnd() < 0.15;
    return {
      id: `l${i}`, expiry: "2026-11-24", strike: 23000 + 50 * Math.floor(rnd() * 40), type: pick(["CE", "PE"] as const), action: pick(["BUY", "SELL"] as const),
      lots: 1 + Math.floor(rnd() * 3), premium: Math.round((20 + rnd() * 400) * 20) / 20, premiumSource: "manual" as const,
      ...(exited ? { exitPrice: Math.round(rnd() * 300 * 20) / 20, exitReason: "manual" as const, realised: Math.round((rnd() - 0.5) * 20000) } : {}),
    };
  });
}

describe("expiry analysis against a brute-force scan", () => {
  it("agrees on 150 generated strategies", { timeout: 60000 }, () => {
    let withBreakevens = 0;
    for (let c = 0; c < 150; c++) {
      const legs = randomLegs();
      const a = analyzeExpiry(legs, LOT);
      expect(a.defined).toBe(true);
      const hi = Math.max(...legs.map((l) => l.strike)) + 4000;
      const grid: { s: number; p: number }[] = [];
      for (let s = 0; s <= hi; s += 1) grid.push({ s, p: expiryPnl(legs, s, LOT)! });
      const ps = grid.map((g) => g.p);
      const last = ps[ps.length - 1]!, prev = ps[ps.length - 5]!;
      const slopeUp = (last - prev) / 4; // far above every strike the payoff is a straight line
      if (a.profitUnlimited) expect(slopeUp).toBeGreaterThan(0);
      else if (a.lossUnlimited) expect(slopeUp).toBeLessThan(0);
      else expect(Math.abs(slopeUp)).toBeLessThan(1e-6);
      if (!a.profitUnlimited) expect(a.maxProfit).toBeCloseTo(Math.max(...ps), 6);
      if (!a.lossUnlimited) expect(a.maxLoss).toBeCloseTo(Math.min(...ps), 6);
      // every sign change on the grid has a breakeven within one grid step, and every reported breakeven sits on a zero
      const found: number[] = [];
      for (let i = 1; i < grid.length; i++) if (ps[i - 1]! * ps[i]! < 0) found.push((grid[i - 1]!.s + grid[i]!.s) / 2);
      for (const f of found) expect(a.breakevens.some((b) => Math.abs(b - f) <= 1.01)).toBe(true);
      for (const b of a.breakevens) expect(Math.abs(expiryPnl(legs, b, LOT)!)).toBeLessThan(0.01);
      if (a.breakevens.length) withBreakevens++;
    }
    expect(withBreakevens).toBeGreaterThan(40); // the generator does exercise the breakeven logic
  });
});
