// Vega analysis calculations, checked by hand. The maps are formula checks (labelled), not market data.
import { describe, expect, it } from "vitest";
import { anchoredBand, candles, percentileRank, readingOf, regimeOf, stats, vegaChange, vegaLevel, type VegaSample } from "../lib/vegaAnalysis";

// 09:15, 09:16, 09:17, 09:18, 09:19, 09:20 IST on 5 Nov 2026 (03:45 UTC = 09:15 IST)
const T0 = Date.parse("2026-11-05T03:45:00Z");
const at = (min: number) => T0 + min * 60_000;
const sample = (min: number, ce: [number, number][], pe: [number, number][], spot = 24000): VegaSample => ({
  t: at(min), day: "2026-11-05", spot, fwd: spot, ce: new Map(ce), pe: new Map(pe),
});

describe("vegaLevel", () => {
  it("averages call vega and put vega over the chosen strikes, and CE − PE only where both exist", () => {
    const s = [
      sample(0, [[100, 10], [150, 8]], [[100, 9], [150, 7]]),
      sample(1, [[100, 12]], [[100, 10], [150, 6]]), // 150 has no call price now: the call average uses 100 alone
      sample(2, [], [[100, 5]]), // no call at all
    ];
    const l = vegaLevel(s, [100, 150]);
    expect(l[0]).toMatchObject({ ce: 9, pe: 8, avg: 8.5, diff: 1 }); // (10+8)/2, (9+7)/2
    expect(l[1]).toMatchObject({ ce: 12, pe: 8, avg: 10, diff: 4 }); // 12 ; (10+6)/2
    expect(l[2]).toMatchObject({ ce: null, pe: 5, avg: 5, diff: null }); // missing stays missing, never zero
  });
});

describe("candles", () => {
  it("keeps the last point of each candle counted from the open", () => {
    const pts = [0, 1, 2, 3, 4, 5].map((m) => ({ t: at(m), v: m }));
    expect(candles(pts, 3, 555).map((p) => p.v)).toEqual([2, 5]); // 09:15-09:17 ends at 2, 09:18-09:20 at 5
    expect(candles(pts, 1, 555)).toHaveLength(6);
  });
});

describe("percentile rank and regime", () => {
  it("counts the values below plus half of those equal", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5); // below 2, equal 1: (2 + 0.5) / 4
    expect(percentileRank([1, 2, 3, 4], 0.5)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 9)).toBe(100);
    expect(percentileRank([], 3)).toBeNull();
    expect(percentileRank([1, 2], null)).toBeNull();
  });
  it("splits the history into thirds", () => {
    expect([10, 33, 33.4, 66.6, 66.7, 90].map((r) => regimeOf(r))).toEqual(["Low Vega", "Low Vega", "Normal Vega", "Normal Vega", "High Vega", "High Vega"]);
    expect(regimeOf(null)).toBeNull();
  });
});

describe("vegaChange", () => {
  it("is the change of the summed vega since the baseline, strike by strike, and starts at zero", () => {
    const s = [
      sample(0, [[100, 10], [150, 8]], [[50, 9], [100, 7]]),
      sample(1, [[100, 11], [150, 7]], [[50, 8], [100, 7.5]]),
      sample(2, [[100, 12], [150, 9], [200, 5]], [[50, 10], [100, 7]]), // 200 had no vega at the baseline: it adds nothing
    ];
    const c = vegaChange(s, [100, 150, 200], [50, 100], 0);
    expect(c.map((p) => p.call)).toEqual([0, 0, 3]); // (11-10)+(7-8) = 0 ; (12-10)+(9-8) = 3
    expect(c.map((p) => p.put)).toEqual([0, -0.5, 1]); // (8-9)+(7.5-7) = -0.5 ; (10-9)+(7-7) = 1
    expect(c[2]).toMatchObject({ ceN: 2, peN: 2 });
  });
  it("normalized is the percent of the baseline sum, and a later baseline drops the samples before it", () => {
    const s = [sample(0, [[100, 10]], [[100, 10]]), sample(1, [[100, 12]], [[100, 8]]), sample(2, [[100, 15]], [[100, 12]])];
    const n = vegaChange(s, [100], [100], 1, true);
    expect(n).toHaveLength(2);
    expect(n.map((p) => p.call)).toEqual([0, 25]); // (15-12)/12
    expect(n.map((p) => p.put)).toEqual([0, 50]); // (12-8)/8
  });
});

describe("anchoredBand, stats and the readings", () => {
  it("takes calls from the at-the-money strike upwards and puts downwards, that strike in both", () => {
    const listed = [24000, 24050, 24100, 24150, 24200, 24250, 24300];
    expect(anchoredBand(listed, 24150, 3)).toEqual({ ce: [24150, 24200, 24250], pe: [24050, 24100, 24150] });
    expect(anchoredBand(listed, 24160, 2)).toEqual({ ce: [24150, 24200], pe: [24100, 24150] }); // nearest strike
    expect(anchoredBand(listed, 24000, 3).pe).toEqual([24000]); // the band stops at the edge of the chain
  });
  it("gives current, average and range, ignoring missing values", () => {
    expect(stats([null, 2, 4, null, 3])).toEqual({ current: 3, average: 3, low: 2, high: 4 });
    expect(stats([null])).toEqual({ current: null, average: null, low: null, high: null });
  });
  it("says what is and is not known", () => {
    expect(readingOf(null, null, 12, 0.1, 10).environment).toContain("at least 100 stored samples");
    expect(readingOf("Low Vega", 20, 400, 0, 10).environment).toContain("lowest third of the 400 stored samples (rank 20%)");
    expect(readingOf("High Vega", 80, 400, 0, 10).environment).toContain("highest third");
    expect(readingOf("Normal Vega", 50, 400, 0.05, 10).skew).toContain("Balanced"); // 0.5% of the average
    expect(readingOf("Normal Vega", 50, 400, -0.5, 10).skew).toContain("Put vega is higher by 0.500 (5.0%)");
    expect(readingOf("Normal Vega", 50, 400, null, 10).skew).toContain("could not both be read");
  });
});
