// Strategy-as-a-price maths: small explicit series so every number can be checked by hand.
import { describe, expect, it } from "vitest";
import { alignFuture, bands, buildTimeline, cumMean, cumWeighted, decompose, ema, regress, sma, timelineStats } from "../lib/strategyTimeline";
import type { FuturesSeries, StrikeSeries } from "../lib/types";

const z = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
const ss = (times: string[], ce: (number | null)[], pe: (number | null)[], spot: number[]): StrikeSeries => ({
  underlying: "NIFTY", expiry: "2026-11-17", strikes: [25000], atm_strike: 25000, times, spot, ce_price: { "25000": ce }, pe_price: { "25000": pe },
  ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {}, stride: 1, warnings: [], definitions: {},
});
const short = [{ strike: 25000, type: "CE" as const, action: "SELL" as const, lots: 1, premium: 200 }, { strike: 25000, type: "PE" as const, action: "SELL" as const, lots: 2, premium: 100 }];
const T = ["09:15", "09:16", "09:17", "09:18"].map((h) => z("2026-11-11", h));

describe("buildTimeline", () => {
  const tl = buildTimeline(short, ss(T, [200, 210, null, 190], [100, 95, 90, 105], [25000, 25010, 25020, 24990]), 65);
  it("value, display and P&L by hand", () => {
    // value = -1*CE - 2*PE: -(200+200)=-400, -(210+190)=-400, null (CE missing), -(190+210)=-400
    expect(tl.value).toEqual([-400, -400, null, -400]);
    expect(tl.isCredit).toBe(true);
    expect(tl.display).toEqual([400, 400, null, 400]); // credit shown as the price to buy back
    // P&L = 65 * (-1*(CE-200) - 2*(PE-100)): t0 0; t1 65*(-10 +10)=0; t3 65*(10 -10)=0
    expect(tl.pnl).toEqual([0, 0, null, 0]);
    expect(tl.missing).toBe(1);
    expect(tl.label[0]).toBe("09:15");
  });
  it("P&L moves with the legs (CE 230, PE 80: -30*65 + -2*(-20)*65 = +650)", () => {
    const t = buildTimeline(short, ss(T.slice(0, 2), [200, 230], [100, 80], [25000, 25001]), 65);
    expect(t.pnl[1]).toBe(65 * (-(230 - 200) - 2 * (80 - 100)));
    expect(t.pnl[1]).toBe(650);
  });
  it("without an entry premium there is a premium but no P&L, and a debit stays positive", () => {
    const t = buildTimeline([{ strike: 25000, type: "CE", action: "BUY", lots: 1, premium: null }], ss(T.slice(0, 2), [200, 230], [1, 1], [1, 1]), 65);
    expect(t.pnl).toEqual([null, null]);
    expect(t.isCredit).toBe(false);
    expect(t.display).toEqual([200, 230]);
  });
  it("puts a spacer between days and averages restart on each day", () => {
    const times = [z("2026-11-10", "15:28"), z("2026-11-10", "15:29"), z("2026-11-11", "09:15"), z("2026-11-11", "09:16")];
    const t = buildTimeline([short[0]!], ss(times, [100, 110, 50, 70], [1, 1, 1, 1], [1, 2, 3, 4]), 65, { days: 3 });
    expect(t.spacer).toEqual([false, false, true, false, false]);
    expect(t.label[0]).toBe("11-10 15:28");
    expect(cumMean(t.display, t)).toEqual([100, 105, null, 50, 60]); // restarts after the spacer
    // only the newest day when days = 1
    expect(buildTimeline([short[0]!], ss(times, [100, 110, 50, 70], [1, 1, 1, 1], [1, 2, 3, 4]), 65).samples).toBe(2);
  });
});

describe("a builder leg carries its own live-feed key (12 Nov 2026 regression)", () => {
  it("the leg's `key` (nse_fo|<token>) is not a series key: prices are still found by strike", () => {
    const legs = [{ ...short[0]!, key: "nse_fo|53219" }, { ...short[1]!, key: "nse_fo|53220" }];
    const tl = buildTimeline(legs, ss(T, [200, 210, 220, 190], [100, 95, 90, 105], [25000, 25010, 25020, 24990]), 65);
    expect(tl.value).toEqual([-400, -400, -400, -400]); // -(CE + 2 x PE); it was all null when the feed key was read as the series key
    expect(tl.isCredit).toBe(true);
    expect(tl.pnl[0]).toBe(0);
  });
});

describe("strategy VWAP from each leg's own traded volume", () => {
  const withVol = (ce: number[], pe: number[]) => ({ ...ss(T.slice(0, 3), [200, 210, 220], [100, 100, 90], [1, 2, 3]), ce_volume: { "25000": ce }, pe_volume: { "25000": pe } });
  it("is the legs' VWAPs combined like the strategy value (hand-calculated)", () => {
    // CE: 100 @200, then 200 @210 -> 200, 206.667, 206.667.  PE: 50 @100, none, then 100 @90 -> 100, 100, 93.333.
    const tl = buildTimeline(short, withVol([100, 300, 300], [50, 50, 150]), 65);
    expect(tl.vwap[0]).toBeCloseTo(200 + 2 * 100, 9); // credit: shown as the price to buy back
    // (200*100 + 210*200) / 300 = 206.667 for the call
    expect(tl.vwap[1]).toBeCloseTo(206.6666667 + 200, 6);
    expect(tl.vwap[2]).toBeCloseTo(206.6666667 + 2 * 93.3333333, 6);
    // rupees: 65 * (-(vwapCE - 200) - 2*(vwapPE - 100)) at t2 = 65 * (-6.6667 + 13.3333) = 433.33
    expect(tl.vwapPnl[2]).toBeCloseTo(65 * (-(206.6666667 - 200) - 2 * (93.3333333 - 100)), 4);
  });
  it("is null until every leg has traded, and null with no stored volume", () => {
    const part = buildTimeline(short, withVol([100, 300, 300], [0, 0, 150]), 65);
    expect(part.vwap).toEqual([null, null, expect.any(Number)]); // the put has not traded before the third sample
    const none = buildTimeline(short, ss(T.slice(0, 3), [200, 210, 220], [100, 100, 90], [1, 2, 3]), 65);
    expect(none.vwap).toEqual([null, null, null]);
  });
  it("a volume that falls (a new day's counter) adds nothing and the sums restart on each day", () => {
    const times = [z("2026-11-10", "15:29"), z("2026-11-11", "09:15"), z("2026-11-11", "09:16")];
    const d = { ...ss(times, [100, 50, 60], [1, 1, 1], [1, 2, 3]), ce_volume: { "25000": [1000, 10, 30] } };
    const tl = buildTimeline([short[0]!], d, 65, { days: 3 });
    // yesterday: 1000 @100 -> 100. Today restarts: 10 @50, then 20 @60 -> (500+1200)/30 = 56.667
    const got = tl.vwap.filter((v): v is number => v != null);
    expect(got[0]).toBeCloseTo(100, 9);
    expect(got[1]).toBeCloseTo(50, 9);
    expect(got[2]).toBeCloseTo(56.6666667, 5);
  });
});

describe("indicators", () => {
  const tl = { day: ["d", "d", "d", "d", "d"], spacer: [false, false, false, false, false] };
  it("sma needs n valid values and skips gaps without filling them", () => {
    expect(sma([1, 2, 3, 4, 5], 3, tl)).toEqual([null, null, 2, 3, 4]);
    expect(sma([1, null, 3, 4, 5], 3, tl)).toEqual([null, null, null, 8 / 3, 4]);
  });
  it("ema is seeded by the first n and then 2/(n+1) smoothing", () => {
    const e = ema([2, 4, 6, 8, 10], 3, tl); // seed 4 at i=2; k=0.5: 8*0.5+4*0.5=6; 10*0.5+6*0.5=8
    expect(e).toEqual([null, null, 4, 6, 8]);
  });
  it("bollinger: mean +- k population sd (window 1,2,3: sd = sqrt(2/3))", () => {
    const b = bands([1, 2, 3], 3, 2, { day: ["d", "d", "d"], spacer: [false, false, false] });
    expect(b.mid[2]).toBe(2);
    expect(b.up[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 10);
    expect(b.low[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 10);
  });
  it("weighted running average: (10*1 + 20*3) / 4 = 17.5, zero or missing weights skipped", () => {
    expect(cumWeighted([10, 20, 99, 30], [1, 3, 0, null], { day: ["d", "d", "d", "d"], spacer: [false, false, false, false] })).toEqual([10, 17.5, 17.5, 17.5]);
  });
});

describe("regression and decomposition", () => {
  const n = 40;
  const d = { day: Array.from({ length: n }, () => "d"), spacer: Array.from({ length: n }, () => false) };
  const spot = Array.from({ length: n }, (_, i) => 25000 + (i % 7) * 3 + i);
  it("recovers an exact delta and splits P&L into spot-driven and the rest", () => {
    const pnl = spot.map((s, i) => -50 * (s - 25000) + 8 * i); // delta -50 per point plus a steady +8 per sample
    const r = regress(spot, pnl, d, 5)!;
    expect(r.beta).toBeGreaterThan(-52);
    expect(r.beta).toBeLessThan(-48);
    const { explained, rest } = decompose(pnl, spot, -50);
    expect(explained[0]).toBeCloseTo(0, 9);
    expect(rest[n - 1]).toBeCloseTo(8 * (n - 1), 6); // everything the spot does not explain = the steady +8/sample
    expect(explained[n - 1]! + rest[n - 1]!).toBeCloseTo(pnl[n - 1]! - pnl[0]!, 6);
  });
  it("returns null with too few usable pairs", () => {
    expect(regress([1, 2, 3], [1, 2, 3], { day: ["d", "d", "d"], spacer: [false, false, false] })).toBeNull();
  });
});

describe("futures alignment and stats", () => {
  it("takes the nearest futures sample within 90 s and never carries one forward", () => {
    const tl = { t: [Date.parse(T[0]!), Date.parse(T[1]!), Date.parse(T[3]!)], spacer: [false, false, false] };
    const f = { times: [T[0]!, T[1]!], future: [25100, 25110], volume_per_min: [500, 700] } as unknown as FuturesSeries;
    expect(alignFuture(tl, f)).toEqual({ future: [25100, 25110, null], volume: [500, 700, null] });
  });
  it("stats of the newest day: range, z-score, percentile, max drawdown", () => {
    const tl = buildTimeline(short, ss(T, [200, 210, 220, 190], [100, 100, 100, 100], [1, 2, 3, 4]), 65);
    // display (credit) = CE + 2*PE = 400, 410, 420, 390; pnl = 65*(-(CE-200)) = 0,-650,-1300,+650
    const s = timelineStats(tl);
    expect([s.open, s.high, s.low, s.now, s.change]).toEqual([400, 420, 390, 390, -10]);
    expect(s.percentile).toBe(25); // 1 of 4 values <= 390
    expect(s.maxDrawdown).toBe(-1300); // from the peak 0 down to -1300
    expect(s.pnlHigh).toBe(650);
    expect(s.spotMove).toBe(3);
    expect(s.zScore).toBeCloseTo((390 - 405) / Math.sqrt((25 + 25 + 225 + 225) / 4), 10);
  });
});

describe("merging the samples of two expiries", () => {
  it("lays the second expiry on the first one's time axis (nearest sample within 90 s, else blank) and keys prices by expiry:strike", async () => {
    const { mergeStrikeSeries, mergedKey } = await import("../lib/strategyTimeline");
    const t0 = ["09:15", "09:16", "09:20"].map((h) => z("2026-11-11", h));
    const base = ss(t0, [100, 101, 102], [10, 11, 12], [25000, 25001, 25002]);
    // the other expiry was sampled 20 s after the first two, then nothing for four minutes: its last sample is 09:16:20
    const t1 = [new Date(Date.parse(t0[0]!) + 20_000).toISOString(), new Date(Date.parse(t0[1]!) + 20_000).toISOString()];
    const other = ss(t1, [200, 201], [20, 21], [1, 1]);
    const m = mergeStrikeSeries([{ expiry: "A", ss: base }, { expiry: "B", ss: other }]);
    expect(m.ce_price[mergedKey("A", 25000)]).toEqual([100, 101, 102]);
    expect(m.ce_price[mergedKey("B", 25000)]).toEqual([200, 201, null]); // 09:20 is 3 min 40 s from the nearest sample of B: left blank, not carried
    expect(m.pe_price[mergedKey("B", 25000)]).toEqual([20, 21, null]);
    expect(m.spot).toEqual([25000, 25001, 25002]);
    // a calendar built on the merged series: sell the A call, buy the B call
    const legs = [
      { strike: 25000, type: "CE" as const, action: "SELL" as const, lots: 1, premium: 100, seriesKey: mergedKey("A", 25000) },
      { strike: 25000, type: "CE" as const, action: "BUY" as const, lots: 1, premium: 200, seriesKey: mergedKey("B", 25000) },
    ];
    const tl = buildTimeline(legs, m, 65);
    expect(tl.value).toEqual([100, 100, null]); // -100 + 200 = +100 at the first two samples; the third has no price for leg B
    expect(tl.pnl).toEqual([0, 0, null]); // 65 * (-(101-100) + (201-200)) = 0
  });
});
