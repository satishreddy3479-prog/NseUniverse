// The live skew uses the same definitions as the backend's skew_metrics: the same hand-worked example gives the same numbers.
import { describe, expect, it } from "vitest";
import { chainGreeks } from "../lib/optionTools";
import { ivAtDelta, liveSmile, skewMeasures, type SmileRow } from "../lib/skew";

const r = (strike: number, side: "CE" | "PE", iv: number, delta: number): SmileRow => ({ strike, side, iv, delta, otm: true });

describe("skew measures", () => {
  const rows = [r(23900, "PE", 17, -0.4), r(23800, "PE", 18, -0.26), r(23600, "PE", 20, -0.1), r(24100, "CE", 15, 0.4), r(24200, "CE", 14, 0.24), r(24400, "CE", 13.5, 0.09)];
  it("match the backend's hand calculation (interpolated in delta)", () => {
    const m = skewMeasures(rows, 24000, 16);
    expect(m.put_25d_iv).toBeCloseTo(18.125, 3); // 20 + (0.25-0.10)/(0.26-0.10) x (18-20)
    expect(m.call_25d_iv).toBeCloseTo(14.0625, 2); // 14 + (0.25-0.24)/(0.40-0.24) x (15-14)
    expect(m.skew_25d).toBeCloseTo(4.0625, 2);
    expect(m.call_minus_put_25d).toBeCloseTo(-4.0625, 2);
    expect(m.skew_10d).toBeCloseTo(6.4667, 3); // put exactly on 0.10 (20); call 13.5 + (0.01/0.15) x 0.5 = 13.5333
    expect(m.butterfly_25d).toBeCloseTo(0.09375, 2);
    expect(m.butterfly_10d).toBeCloseTo(0.7667, 3);
    expect(m.slope_per_pct).toBeCloseTo(-2.0571, 3); // moneyness -0.417 ... +1.667 %, mean IV 16.25: Sxy -15, Sxx 7.29167
  });
  it("shows the two contracts a delta point was interpolated from, and does not extrapolate", () => {
    const d = ivAtDelta(rows, "PE", 0.25)!;
    expect([d.hi.strike, d.lo.strike]).toEqual([23800, 23600]);
    expect(ivAtDelta(rows, "CE", 0.05)).toBeNull(); // below the deepest listed call (0.09)
    expect(ivAtDelta(rows, "PE", 0.45)).toBeNull(); // above the nearest listed put (0.40)
  });
  it("leave a measure missing when no contract is near the target delta", () => {
    const m = skewMeasures([r(23000, "PE", 30, -0.02), r(25000, "CE", 12, 0.02)], 24000, 16);
    expect(m.skew_25d).toBeNull();
    expect(m.slope_per_pct).toBeNull();
  });
});

describe("live smile from the chain's prices", () => {
  it("builds the out-of-the-money smile around the forward-nearest strike from solved contracts", () => {
    // a flat 20% volatility chain priced with Black-76 would give a flat smile; here the prices come from the model itself
    const nowMs = Date.parse("2026-11-05T04:30:00Z");
    const rows = Array.from({ length: 9 }, (_, i) => ({ strike: 24000 + 50 * i, call: { ltp: Math.max(0.5, 220 - 40 * i + i * i), oi: 1, volume: 1 }, put: { ltp: Math.max(0.5, 20 + 38 * i - i * i), oi: 1, volume: 1 } })) as never[];
    const g = chainGreeks(rows, 24200, "2026-11-09", nowMs);
    const sm = liveSmile(g.strikes, g.forward, 24200, 3);
    expect(sm.atmStrike).not.toBeNull();
    const strikes = [...new Set(sm.rows.map((x) => x.strike))];
    expect(strikes.length).toBeLessThanOrEqual(7); // three strikes either side of the at-the-money strike
    for (const x of sm.rows) expect(x.otm).toBe(x.side === "CE" ? x.strike >= sm.atmStrike! : x.strike <= sm.atmStrike!);
    expect(sm.rows.some((x) => x.iv != null)).toBe(true);
  });
});
