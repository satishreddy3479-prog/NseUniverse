// ATM rolling straddle: hand-calculated on a six-sample path (strikes 24000, 24050, 24100), every number worked out below.
import { describe, expect, it } from "vitest";
import { heldStrikes, nearestStrike, readRollingStraddle, rollingStraddle, strikeStep, type StrikeStraddle } from "../lib/rollingStraddle";

const MIN = 60_000;
const times = [0, 1, 2, 3, 4, 5].map((i) => 1_000_000 + i * MIN);
const spot = [24010, 24030, 24060, 24090, 24070, 24040];
const boards: StrikeStraddle[] = [
  { strike: 24000, straddle: [100, 104, 111, 120, 116, 112] },
  { strike: 24050, straddle: [90, 96, 102, 110, 107, 103] },
  { strike: 24100, straddle: [98, 101, 105, 109, 106, 104] },
];
const strikes = boards.map((b) => b.strike);

describe("held strike", () => {
  it("nearest strike with the lower one on an exact tie, and the strike step", () => {
    expect(nearestStrike(strikes, 24010)).toBe(24000);
    expect(nearestStrike(strikes, 24025)).toBe(24000); // equidistant from 24000 and 24050: the lower
    expect(nearestStrike(strikes, 24026)).toBe(24050);
    expect(strikeStep(strikes)).toBe(50);
    expect(strikeStep([24000])).toBeNull();
  });
  it("'nearest' follows spot at every sample; 'after 1 step' stays until spot is a full gap away", () => {
    expect(heldStrikes(spot, strikes, { kind: "nearest" })).toEqual([24000, 24050, 24050, 24100, 24050, 24050]);
    expect(heldStrikes(spot, strikes, { kind: "steps", n: 1 })).toEqual([24000, 24000, 24050, 24050, 24050, 24050]); // |24060-24000| = 60 >= 50 rolls once
    expect(heldStrikes([24010, null, 24030], strikes, { kind: "nearest" })).toEqual([24000, 24000, 24050]); // no spot: nothing to roll on
  });
});

describe("rolling premium, fixed premium and the roll-adjusted premium", () => {
  const r = rollingStraddle(times, spot, boards, { kind: "nearest" });
  it("rolling = the held strike's straddle at each sample", () => {
    expect(r.rolling).toEqual([100, 96, 102, 109, 107, 103]); // 24000@0, 24050@1, 24050@2, 24100@3, 24050@4, 24050@5
    expect(r.openingStrike).toBe(24000);
  });
  it("fixed = the opening strike all session", () => expect(r.fixed).toEqual([100, 104, 111, 120, 116, 112]));
  it("roll-adjusted adds only same-contract changes, so a roll makes no jump", () => {
    // t1: 24000 (held at t0) 104-100 = +4 -> 104; t2: 24050 102-96 = +6 -> 110; t3: 24050 110-102 = +8 -> 118; t4: 24100 106-109 = -3 -> 115; t5: 24050 103-107 = -4 -> 111
    expect(r.adjusted).toEqual([100, 104, 110, 118, 115, 111]);
    expect(r.rolling[1]! - r.rolling[0]!).toBe(-4); // the plain line fell 4 at the first roll while the adjusted line rose 4
  });
  it("roll events carry the credit new - old at that sample", () => {
    expect(r.rolls.map((x) => [x.index, x.from, x.to, x.credit])).toEqual([[1, 24000, 24050, -8], [3, 24050, 24100, -1], [4, 24100, 24050, 1]]); // 96-104, 109-110, 107-106
    expect(r.stats.rolls).toBe(3);
    expect(r.stats.rollCreditTotal).toBe(-8);
  });
  it("implied move is the premium as a percent of spot", () => {
    expect(r.impliedPct[0]).toBeCloseTo((100 / 24010) * 100, 3);
    expect(r.impliedPct[3]).toBeCloseTo((109 / 24090) * 100, 3);
  });
  it("statistics", () => {
    const s = r.stats;
    expect([s.open, s.high, s.low, s.current]).toEqual([100, 109, 96, 103]);
    expect(s.average).toBeCloseTo(617 / 6, 2); // (100+96+102+109+107+103)/6
    expect([s.changeFromOpen, s.changeFromOpenPct]).toEqual([3, 3]);
    expect(s.adjustedChange).toBe(11); // 111 - 100
    expect([s.spotOpen, s.spotNow, s.spotMove]).toEqual([24010, 24040, 30]);
    expect(s.moveVsOpeningPremium).toBe(0.3); // 30 / 100
    expect(s.heldNow).toBe(24050);
    expect([s.bandLow, s.bandHigh]).toEqual([23947, 24153]); // 24050 -/+ 103
    expect(s.adjustedLast60).toBeNull(); // five minutes of samples: no full hour
  });
});

describe("another rule gives another path from the same samples", () => {
  const r = rollingStraddle(times, spot, boards, { kind: "steps", n: 1 });
  it("held 24000 for two samples then 24050: one roll", () => {
    expect(r.rolling).toEqual([100, 104, 102, 110, 107, 103]);
    expect(r.rolls.map((x) => [x.index, x.credit])).toEqual([[2, -9]]); // 24050 vs 24000 at t2: 102 - 111
    // adjusted: t1 24000 +4 -> 104; t2 24000 111-104 = +7 -> 111; t3 24050 110-102 = +8 -> 119; t4 24050 107-110 = -3 -> 116; t5 -4 -> 112
    expect(r.adjusted).toEqual([100, 104, 111, 119, 116, 112]);
  });
});

describe("missing prices stay missing", () => {
  it("a missing price gives a null point, the adjusted line resumes from its last value, and nothing is filled", () => {
    const b: StrikeStraddle[] = [{ strike: 24000, straddle: [100, null, 108, 110] }, { strike: 24050, straddle: [90, 94, 99, 101] }];
    const r = rollingStraddle(times.slice(0, 4), [24000, 24005, 24010, 24012], b, { kind: "nearest" });
    expect(r.rolling).toEqual([100, null, 108, 110]);
    expect(r.adjusted).toEqual([100, null, null, 102]); // t1 and t2 lack a valid pair; t3: 24000 110-108 = +2 on the last known 100
    expect(r.stats.missingPoints).toBe(1);
    expect(r.stats.current).toBe(110);
  });
  it("a roll with a missing price has a null credit and is counted", () => {
    const b: StrikeStraddle[] = [{ strike: 24000, straddle: [100, 101, 102] }, { strike: 24050, straddle: [90, null, 95] }];
    const r = rollingStraddle(times.slice(0, 3), [24000, 24040, 24060], b, { kind: "nearest" });
    expect(r.rolls[0]!.credit).toBeNull();
    expect(r.stats.rollsWithMissingPrice).toBe(1);
    expect(r.stats.rollCreditTotal).toBeNull(); // 24000->24050 at t1 has no price for 24050; t2 is a roll only if the held strike changes again
  });
  it("no data at all", () => {
    const r = rollingStraddle([], [], boards);
    expect(r.stats.open).toBeNull();
    expect(readRollingStraddle(r)[0]).toContain("Not enough stored samples");
  });
});

describe("the last-hour change", () => {
  it("needs a full hour of samples", () => {
    const t = Array.from({ length: 70 }, (_, i) => i * MIN);
    const sp = t.map(() => 24000);
    const b: StrikeStraddle[] = [{ strike: 24000, straddle: t.map((_, i) => 200 - i) }]; // falls one point a minute
    const r = rollingStraddle(t, sp, b, { kind: "nearest" });
    expect(r.stats.adjustedLast60).toBe(-60); // from minute 9 to minute 69
  });
});

describe("the reading is descriptive", () => {
  it("states the numbers and never makes a call", () => {
    const text = readRollingStraddle(rollingStraddle(times, spot, boards)).join(" ");
    expect(text).toContain("opened at 100.0 and is 103.0 now (+3.0 points)");
    expect(text).toContain("roll-adjusted premium");
    expect(text).toContain("+11.0 points");
    expect(text).toContain("30% of the opening straddle premium");
    expect(text).toContain("23947 and 24153");
    expect(text.toLowerCase()).not.toMatch(/buy|sell now|should|recommend/);
  });
});
