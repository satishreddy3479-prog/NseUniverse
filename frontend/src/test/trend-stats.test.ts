import { describe, expect, it } from "vitest";
import {
  adx, aggregate, atr, choppiness, efficiencyRatio, openingRange, rangeUsed, regression, runningMean, runningVwap, structure, varianceRatio,
  type RBar,
} from "../lib/trendStats";

// 09:15 IST on 25 Nov 2026 = 03:45 UTC
const T0 = Date.UTC(2026, 10, 25, 3, 45);
const bar = (i: number, o: number, h: number, l: number, c: number, v: number | null = null): RBar => ({ t: T0 + i * 60_000, o, h, l, c, v });

// every expected value below is a hand calculation, written out beside it
describe("trend statistics (hand calculated)", () => {
  it("efficiency ratio: net move over the path travelled", () => {
    // [100,102,101,105,104], n = 4: net 4, path 2+1+4+1 = 8 -> 0.5
    expect(efficiencyRatio([100, 102, 101, 105, 104], 4)).toBe(0.5);
    expect(efficiencyRatio([1, 2, 3, 4], 3)).toBe(1); // a straight line
    expect(efficiencyRatio([5, 5, 5, 5], 3)).toBeNull(); // nothing moved: no figure, not zero
    expect(efficiencyRatio([1, 2], 3)).toBeNull(); // too few closes
  });

  it("ADX / DMI by Wilder with n = 2", () => {
    const b = [bar(0, 0, 10, 8, 9), bar(1, 0, 12, 9, 11), bar(2, 0, 13, 10, 12), bar(3, 0, 12, 9, 10), bar(4, 0, 14, 11, 13)];
    // TR: 3, 3, 3, 4 (bars 1..4). +DM: 2, 1, 0, 2. -DM: 0, 0, 1, 0.
    // bar 2: sums TR 6, +DM 3, -DM 0 -> +DI 50, -DI 0, DX 100
    // bar 3: TR 6+3-3 = 6, +DM 3+0-1.5 = 1.5, -DM 0+1-0 = 1 -> +DI 25, -DI 16.667, DX 100*8.333/41.667 = 20 -> first ADX = (100+20)/2 = 60
    // bar 4: TR 6+4-3 = 7, +DM 1.5+2-0.75 = 2.75, -DM 1+0-0.5 = 0.5 -> +DI 39.286, -DI 7.143, DX 69.231 -> ADX (60*1+69.231)/2 = 64.615
    const r = adx(b, 2);
    expect(r[1]!.plusDi).toBeNull();
    expect(r[2]!.plusDi).toBeCloseTo(50, 9);
    expect(r[2]!.minusDi).toBeCloseTo(0, 9);
    expect(r[2]!.adx).toBeNull(); // needs n DX values
    expect(r[3]!.plusDi).toBeCloseTo(25, 9);
    expect(r[3]!.minusDi).toBeCloseTo(16.6667, 3);
    expect(r[3]!.adx).toBeCloseTo(60, 9);
    expect(r[4]!.plusDi).toBeCloseTo(39.2857, 3);
    expect(r[4]!.minusDi).toBeCloseTo(7.1429, 3);
    expect(r[4]!.adx).toBeCloseTo(64.6154, 3);
  });

  it("average true range", () => {
    const b = [bar(0, 0, 10, 8, 9), bar(1, 0, 12, 9, 11), bar(2, 0, 13, 10, 12), bar(3, 0, 12, 9, 10), bar(4, 0, 14, 11, 13)];
    expect(atr(b, 2)).toBe(3.5); // (3 + 4) / 2
    expect(atr(b, 5)).toBeNull();
  });

  it("regression slope and R squared", () => {
    // y = 1,2,4,3,5 on x = 0..4: Sxy = 9, Sxx = 10, Syy = 10 -> slope 0.9, R2 = 81 / 100
    const r = regression([1, 2, 4, 3, 5], 5)!;
    expect(r.slope).toBeCloseTo(0.9, 12);
    expect(r.r2).toBeCloseTo(0.81, 12);
    expect(regression([3, 3, 3, 3], 4)!.r2).toBeNull(); // a flat line has no R2
    expect(regression([1, 2], 5)).toBeNull();
  });

  it("variance ratio (Lo-MacKinlay)", () => {
    // log prices 0,1,2,4,6,7,8: returns 1,1,2,2,1,1 (N = 6), mean 4/3, squared deviations sum 4/3 -> variance 4/15.
    // q = 2: two-bar changes 2,3,4,3,2 minus 8/3 -> squares sum 26/9; m = 2 x 5 x (1 - 2/6) = 20/3; (26/9)/(20/3) = 0.43333; VR = 0.43333 / (4/15) = 1.625
    // z = 0.625 / sqrt(2 x 3 x 1 / (3 x 2 x 6)) = 0.625 / sqrt(1/6) = 1.5309
    const v = varianceRatio([0, 1, 2, 4, 6, 7, 8].map(Math.exp), 2)!;
    expect(v.vr).toBeCloseTo(1.625, 9);
    expect(v.z).toBeCloseTo(1.5309, 3);
    // alternating 100, 110: the two-bar change is zero everywhere, so VR = 0 (pure mean reversion), z = -1 / sqrt(1/6) = -2.4495
    const alt = varianceRatio([100, 110, 100, 110, 100, 110, 100], 2)!;
    expect(alt.vr).toBeCloseTo(0, 12);
    expect(alt.z).toBeCloseTo(-2.4495, 3);
    expect(varianceRatio([1, 2, 3], 2)).toBeNull(); // too few
  });

  it("choppiness index", () => {
    const b = [bar(0, 0, 10, 8, 9), bar(1, 0, 12, 9, 11), bar(2, 0, 13, 10, 12)];
    // n = 2: TR 3 + 3 = 6, high 13, low 9 -> range 4; 100 x log10(1.5) / log10(2) = 58.496
    expect(choppiness(b, 2)).toBeCloseTo(58.496, 3);
    expect(choppiness(b.slice(0, 2), 2)).toBeNull();
  });

  it("session mean and volume-weighted price", () => {
    expect(runningMean([2, 4, 9])).toEqual([2, 3, 5]);
    // 100 x 10 = 1000; + 102 x 30 = 4060 over 40 -> 101.5; a missing price adds nothing; + 104 x 20 = 6140 over 60 -> 102.3333
    const v = runningVwap([100, 102, null, 104], [10, 30, 50, 20]);
    expect(v[0]).toBe(100);
    expect(v[1]).toBe(101.5);
    expect(v[2]).toBe(101.5);
    expect(v[3]).toBeCloseTo(102.3333, 3);
    expect(runningVwap([100, 101], [null, 5])).toEqual([null, 101]); // no volume yet: no figure
  });

  it("structure around a mean: share above, crossings and the longest stay", () => {
    // closes 10,12,9,9,13 vs mean 11: sides -,+,-,-,+ -> 40 % above, 3 crossings, longest stay 2 bars below, last distance +2
    const s = structure([10, 12, 9, 9, 13], [11, 11, 11, 11, 11])!;
    expect(s.pctAbove).toBe(40);
    expect(s.crossings).toBe(3);
    expect(s.longestRun).toBe(2);
    expect(s.runSide).toBe(-1);
    expect(s.distance).toBe(2);
    expect(structure([10, 12], [null, null])).toBeNull();
  });

  it("opening range: breaks and failed breaks", () => {
    const b = [
      bar(0, 100, 102, 99, 101), bar(1, 101, 103, 100, 102), bar(2, 102, 104, 101, 103), // range 99 - 104
      bar(3, 103, 106, 103, 105), // above: break 1
      bar(4, 105, 105, 102, 103), // back inside: failed break 1
      bar(5, 103, 103, 97, 98), // below: break 2
      bar(6, 98, 98, 96, 97), // still below
    ];
    const r = openingRange(b, 3)!;
    expect([r.high, r.low]).toEqual([104, 99]);
    expect(r.breaks).toBe(2);
    expect(r.falseBreaks).toBe(1);
    expect(r.barsOutside).toBe(3);
    expect(r.state).toBe("below");
    expect(openingRange(b.slice(0, 2), 3)!.ready).toBe(false); // the range is not complete yet
  });

  it("minute bars aggregate onto the 09:15 grid", () => {
    const b = [
      bar(0, 100, 102, 99, 101, 5), bar(1, 101, 103, 100, 102, 6), bar(2, 102, 104, 101, 103, null),
      bar(3, 103, 106, 103, 105, 7), bar(4, 105, 105, 102, 103, null), bar(5, 103, 103, 97, 98, 8), bar(6, 98, 98, 96, 97, null),
    ];
    const a = aggregate(b, 3);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ o: 100, h: 104, l: 99, c: 103, v: 11 });
    expect(a[1]).toMatchObject({ o: 103, h: 106, l: 97, c: 98, v: 15 });
    expect(a[2]).toMatchObject({ o: 98, h: 98, l: 96, c: 97, v: null });
    expect(aggregate(b, 1)).toHaveLength(7);
  });

  it("range used against the implied daily move", () => {
    // sigma_day = 25000 x 0.15 / sqrt(252) = 236.23; x 1.5958 = 376.97; 150 / 376.97 = 0.3979
    expect(rangeUsed(25150, 25000, 25000, 15)).toBeCloseTo(0.3979, 3);
    expect(rangeUsed(25150, 25000, 25000, null)).toBeNull();
  });
});
