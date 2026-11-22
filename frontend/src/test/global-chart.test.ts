// Shaping stored prices for the global-markets chart. Expected values are hand counts.
import { describe, expect, it } from "vitest";
import { compressSeries, gapText, labelIndexes, rangeStats } from "../lib/globalChart";

const GAP = 90 * 60_000;
// IST = UTC + 5:30. Day 1: 09:00, 09:01, 09:02 IST; closed until 20:00 IST; day 1 evening 20:00, 20:01; then closed until 09:00 IST next day.
const T = ["2026-11-20T03:30:00Z", "2026-11-20T03:31:00Z", "2026-11-20T03:32:00Z", "2026-11-20T14:30:00Z", "2026-11-20T14:31:00Z", "2026-11-21T03:30:00Z"];

describe("compressSeries", () => {
  it("keeps every sample in order and marks each closure with its length, adding nothing", () => {
    const c = compressSeries(T, [10, 11, 12, 13, 14, 15], GAP);
    expect(c.values).toEqual([10, 11, 12, 13, 14, 15]); // no price invented, none dropped
    expect(c.breaks).toEqual([
      { index: 3, gapMs: (14.5 - 3.5333333333333333) * 3_600_000 }, // 09:02 -> 20:00 IST = 10h 58m
      { index: 5, gapMs: (27.5 - 14.516666666666667) * 3_600_000 }, // 20:01 -> 09:00 next day = 12h 59m
    ].map((b) => ({ index: b.index, gapMs: Math.round(b.gapMs) })));
  });
  it("skips missing prices and sorts by time; a silence of exactly the limit is not a closure", () => {
    const c = compressSeries(["2026-11-20T03:02:00Z", "2026-11-20T03:00:00Z", "2026-11-20T04:30:00Z", "2026-11-20T03:01:00Z"], [2, 1, 3, null], GAP);
    expect(c.values).toEqual([1, 2, 3]);
    expect(c.breaks).toEqual([]); // 03:02 -> 04:30 is 88 minutes, under 90
    expect(compressSeries(["2026-11-20T03:00:00Z", "2026-11-20T04:30:00Z"], [1, 2], GAP).breaks).toEqual([]); // exactly 90 minutes
    expect(compressSeries(["2026-11-20T03:00:00Z", "2026-11-20T04:31:00Z"], [1, 2], GAP).breaks).toHaveLength(1);
  });
});

describe("labelIndexes", () => {
  const ms = T.map((x) => Date.parse(x));
  it("several days: the first sample of each IST day", () => {
    expect([...labelIndexes(ms, true)]).toEqual([0, 5]); // 20 Nov, 21 Nov
  });
  it("one day: the first sample of every two-hour IST block", () => {
    // 09:00-09:02 -> block 4; 20:00, 20:01 -> block 10; 21 Nov 09:00 -> a new day, block 4
    expect([...labelIndexes(ms, false)]).toEqual([0, 3, 5]);
  });
});

describe("gapText and rangeStats", () => {
  it("formats closures", () => { expect(gapText(45 * 60_000)).toBe("45m"); expect(gapText(5 * 3_600_000 + 20 * 60_000)).toBe("5h 20m"); expect(gapText(2 * 3_600_000)).toBe("2h"); });
  it("change, percent, high and low over the range", () => {
    const r = rangeStats([100, 110, 95, 105])!;
    expect(r.change).toBe(5); expect(r.changePct).toBe(5); expect(r.high).toBe(110); expect(r.low).toBe(95); expect(r.n).toBe(4);
    expect(rangeStats([100])).toBeNull();
  });
});
