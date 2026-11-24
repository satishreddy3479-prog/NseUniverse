import { describe, expect, it } from "vitest";
import {
  adx, aggregate, atr, choppiness, efficiencyRatio, openingRange, rangeUsed, regression, runningMean, runningRange, runningStd, runningVwap, runningVwapBands, sessionTrend, structure, varianceRatio,
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

  it("the robust variance-ratio z (Lo-MacKinlay z*)", () => {
    // same series as above: e^2 = 1/9,1/9,4/9,4/9,1/9,1/9 (sum 4/3); delta_1 = (1/81 + 4/81 + 16/81 + 4/81 + 1/81) / (4/3)^2 = (26/81) / (16/9) = 0.180556
    // q = 2: theta = [2 x 1 / 2]^2 x delta_1 = 0.180556; z* = sqrt(6) x 0.625 / sqrt(0.180556) = 1.53093 / 0.424918 = 3.6030
    const v = varianceRatio([0, 1, 2, 4, 6, 7, 8].map(Math.exp), 2)!;
    expect(v.zRobust).toBeCloseTo(3.603, 2);
  });

  it("running standard deviation and the volume-weighted bands", () => {
    // [2,4,9]: 0; mean 3 -> 1; mean 5, deviations -3,-1,4 -> sqrt(26/3) = 2.9439
    const sd = runningStd([2, 4, 9]);
    expect(sd[0]).toBe(0);
    expect(sd[1]).toBeCloseTo(1, 12);
    expect(sd[2]).toBeCloseTo(2.9439, 3);
    // prices 100, 102 with volumes 10, 30: vwap 101.5; variance (10 x 100^2 + 30 x 102^2)/40 - 101.5^2 = 10303 - 10302.25 = 0.75
    const b = runningVwapBands([100, 102, null], [10, 30, 5]);
    expect(b[0]).toEqual({ vwap: 100, sd: 0 });
    expect(b[1]!.vwap).toBeCloseTo(101.5, 12);
    expect(b[1]!.sd).toBeCloseTo(Math.sqrt(0.75), 9);
    expect(b[2]).toEqual(b[1]); // a missing price adds nothing
    expect(runningVwapBands([100], [null])).toEqual([{ vwap: null, sd: null }]);
  });

  it("the session so far: net move, path and the day's efficiency ratio", () => {
    // 100, 103, 101, 98: net -2, path 3 + 2 + 3 = 8 -> 0.25, down
    const t = sessionTrend([100, 103, 101, 98])!;
    expect(t).toMatchObject({ net: -2, path: 8, er: 0.25, direction: -1, bars: 4 });
    expect(sessionTrend([100])).toBeNull();
    expect(sessionTrend([5, 5, 5])!.er).toBeNull();
  });

  it("the running range", () => {
    const b = [bar(0, 0, 10, 8, 9), bar(1, 0, 12, 9, 11), bar(2, 0, 11, 7, 8)];
    expect(runningRange(b)).toEqual([2, 4, 5]);
  });

  it("opening range extension, first break and the furthest excursion", () => {
    const b = [
      bar(0, 100, 102, 99, 101), bar(1, 101, 103, 100, 102), bar(2, 102, 104, 101, 103), // range 99 - 104
      bar(3, 103, 106, 103, 105), // first close above: high 106 is 2 beyond
      bar(4, 105, 105, 102, 103), // back inside
      bar(5, 103, 103, 97, 98), // below: low 97 is 2 under the 99 low
    ];
    const r = openingRange(b, 3)!;
    expect(r.firstBreak).toEqual({ t: b[3]!.t, side: "above" });
    expect(r.maxExtension).toBe(2);
    expect(r.extension).toBe(-1); // last close 98 against the low 99
    expect(openingRange(b.slice(0, 4), 3)!.extension).toBe(1); // close 105 against the high 104
  });
});

