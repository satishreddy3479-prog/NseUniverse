import { describe, expect, it } from "vitest";
import { buildupOf, chainGreeks, exposures, peCeDifference, smartOiSummary, type StrikeGreeks , smartOiCandles, strikeBoard, strikesAround } from "../lib/optionTools";
import { contractGreeks } from "../lib/optionModel";
import type { OptionChainRow, OptionQuote, StrikeSeries } from "../lib/types";

const q = (o: Partial<OptionQuote>): OptionQuote => ({ exchange_segment: "nse_fo", instrument_token: "1", trading_symbol: "x", option_type: "CE", ltp: null, open: null, high: null, low: null, prev_close: null, close: null, volume: null, oi: null, oi_previous: null, oi_change: null, oi_change_pct: null, moneyness: null, invalid_fields: [], ...o });

describe("Smart OI buildup", () => {
  it("classifies by the sign of the price change and of the OI change (all four cases, hand-checked)", () => {
    expect(buildupOf(q({ ltp: 110, prev_close: 100, oi_change: 5000 }))?.label).toBe("Long buildup");
    expect(buildupOf(q({ ltp: 90, prev_close: 100, oi_change: 5000 }))?.label).toBe("Short buildup");
    expect(buildupOf(q({ ltp: 110, prev_close: 100, oi_change: -5000 }))?.label).toBe("Short covering");
    expect(buildupOf(q({ ltp: 90, prev_close: 100, oi_change: -5000 }))?.label).toBe("Long unwinding");
    expect(buildupOf(q({ ltp: 110, prev_close: 100, oi_change: 5000 }))?.priceChangePct).toBeCloseTo(10, 10);
  });
  it("gives no label when something is missing or exactly unchanged, and counts those strikes", () => {
    expect(buildupOf(q({ ltp: 110, prev_close: null, oi_change: 5 }))).toBeNull();
    expect(buildupOf(q({ ltp: 100, prev_close: 100, oi_change: 5 }))).toBeNull();
    expect(buildupOf(q({ ltp: 110, prev_close: 100, oi_change: 0 }))).toBeNull();
    const rows: OptionChainRow[] = [
      { strike: 24000, call: q({ ltp: 110, prev_close: 100, oi_change: 5 }), put: q({ ltp: 90, prev_close: 100, oi_change: -5 }) },
      { strike: 24050, call: q({ ltp: 50, prev_close: null, oi_change: 5 }), put: null },
    ];
    const s = smartOiSummary(rows);
    expect(s.counts["Long buildup"].ce).toBe(1);
    expect(s.counts["Long unwinding"].pe).toBe(1);
    expect(s.classified).toBe(2);
    expect(s.unclassified).toBe(1); // the call without a previous close; the absent put is not counted
  });
});

describe("PE - CE difference", () => {
  it("is put minus call per strike, leaves out strikes missing a side and totals the rest", () => {
    const rows: OptionChainRow[] = [
      { strike: 1, call: q({ oi: 100 }), put: q({ oi: 250 }) },
      { strike: 2, call: q({ oi: 300 }), put: q({ oi: 100 }) },
      { strike: 3, call: q({ oi: null }), put: q({ oi: 999 }) },
    ];
    const r = peCeDifference(rows, "oi");
    expect(r.points.map((p) => p.diff)).toEqual([150, -200]);
    expect(r.total).toBe(-50);
    expect(r.skipped).toBe(1);
  });
});

describe("exposures", () => {
  const g = (gamma: number, vegaPt: number) => ({ iv: 0.15, price: 1, delta: 0, gamma, thetaDay: 0, vegaPt });
  const greeks: StrikeGreeks[] = [{ strike: 24000, ce: g(0.001, 5), pe: g(0.002, 5) }];
  const rows: OptionChainRow[] = [{ strike: 24000, call: q({ oi: 1_000_000 }), put: q({ oi: 500_000 }) }];
  it("gamma = gamma x OI x spot^2 x 1%: 0.001 x 1e6 x 24000^2 x 0.01 = 5.76e9 for the call, 0.002 x 5e5 x 24000^2 x 0.01 = 5.76e9 for the put", () => {
    const r = exposures(rows, greeks, 24000, "gamma");
    expect(r.points[0]!.call).toBeCloseTo(5.76e9, 0);
    expect(r.points[0]!.put).toBeCloseTo(5.76e9, 0);
    expect(r.points[0]!.net).toBeCloseTo(0, 0);
  });
  it("vega = vega per point x OI: 5 x 1e6 = 5e6 and 5 x 5e5 = 2.5e6; no net is invented for vega", () => {
    const r = exposures(rows, greeks, 24000, "vega");
    expect(r.points[0]!.call).toBe(5_000_000);
    expect(r.points[0]!.put).toBe(2_500_000);
    expect(r.points[0]!.net).toBeNull();
  });
  it("skips a strike with no Greeks or no OI", () => {
    const r = exposures([{ strike: 24000, call: q({ oi: null }), put: null }], greeks, 24000, "gamma");
    expect(r.points).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
});

describe("chain Greeks", () => {
  it("recovers the volatility a price was made from (round trip through the same model, 15 % at 24000 / spot 24050)", () => {
    const now = Date.UTC(2026, 10, 5, 4, 0), expiry = "2026-11-10", carry = 0.06;
    const spot = 24050;
    const px = (type: "CE" | "PE", k: number) => contractGreeks(type, null, spot, k, expiry, now, 0.06, carry, 0.15)!.price;
    const rows: OptionChainRow[] = [23900, 23950, 24000, 24050, 24100, 24150, 24200].map((k) => ({ strike: k, call: q({ ltp: px("CE", k) }), put: q({ ltp: px("PE", k), option_type: "PE" }) }));
    const r = chainGreeks(rows, spot, expiry, now, 0.06);
    const atm = r.strikes.find((s) => s.strike === 24050)!;
    expect(atm.ce!.iv).toBeCloseTo(0.15, 3);
    expect(atm.pe!.iv).toBeCloseTo(0.15, 3);
    expect(r.carry).toBeCloseTo(0.06, 2);
    expect(r.skipped).toBe(0);
  });
});

describe("smartOiCandles (Smart OI spec, section 5 worked example)", () => {
  // The user's spec table: 3-minute candles, put OI 10.0M → 10.2M → 10.7M → 10.75M, call OI 10.0M → 10.05M → 10.1M → 10.95M.
  // Times are IST 09:15, 09:18, 09:21, 09:24 written as UTC (−5:30).
  const t = (hm: string) => `2026-11-04T${hm}:00Z`;
  const series = {
    times: [t("03:45"), t("03:48"), t("03:51"), t("03:54")],
    spot: [23300, 23310, 23290, 23330],
    pe_oi: [10_000_000, 10_200_000, 10_700_000, 10_750_000],
    ce_oi: [10_000_000, 10_050_000, 10_100_000, 10_950_000],
    pe_volume: [100, 160, 250, 300], ce_volume: [100, 140, 200, 400],
  };
  it("gives +150k, +450k and −800k and no bar on the baseline", () => {
    const r = smartOiCandles(series, 3);
    expect(r.candles.map((c) => c.label)).toEqual(["09:15", "09:18", "09:21", "09:24"]);
    expect(r.candles.map((c) => c.p)).toEqual([null, 150_000, 450_000, -800_000]);
    expect(r.candles.map((c) => c.dPe)).toEqual([null, 200_000, 500_000, 50_000]);
    expect(r.candles.map((c) => c.dCe)).toEqual([null, 50_000, 50_000, 850_000]);
    expect(r.candles.map((c) => c.bullish)).toEqual([null, true, true, false]);
  });
  it("day change stays positive on the last candle while the interval bar turns red", () => {
    const last = smartOiCandles(series, 3).candles[3]!;
    expect(last.peDay).toBe(750_000);
    expect(last.ceDay).toBe(950_000);
    expect(last.diffDay).toBe(-200_000);
    expect(last.pcr).toBeCloseTo(10_750_000 / 10_950_000, 10);
    expect(last.volPcr).toBeCloseTo(300 / 400, 10);
    expect(last.peVolDelta).toBe(50);
    expect(last.ceVolDelta).toBe(200);
  });
  it("builds spot candles from the samples inside each candle, and uses the last sample's OI", () => {
    const s = { times: [t("03:45"), t("03:46"), t("03:47"), t("03:48")], spot: [100, 104, 99, 101], pe_oi: [10, 12, 15, 20], ce_oi: [10, 11, 12, 13] };
    const r = smartOiCandles(s, 3);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.spot).toEqual({ open: 100, high: 104, low: 99, close: 99 });
    expect(r.candles[1]!.p).toBe((20 - 15) - (13 - 12));
  });
  it("leaves a missing candle out, flags the span, and never fills it", () => {
    const s = { times: [t("03:45"), t("04:00")], spot: [1, 2], pe_oi: [10, 40], ce_oi: [10, 20] };
    const r = smartOiCandles(s, 5);
    expect(r.candles.map((c) => c.label)).toEqual(["09:15", "09:30"]);
    expect(r.candles[1]!.span).toBe(3);
    expect(r.candles[1]!.p).toBe(20);
    expect(r.gapCandles).toBe(1);
  });
  it("skips samples with missing OI and keeps PCR missing when call OI is 0", () => {
    const s = { times: [t("03:45"), t("03:46"), t("03:48")], spot: [1, 2, 3], pe_oi: [10, null, 30], ce_oi: [0, 5, 0] };
    const r = smartOiCandles(s, 1);
    expect(r.skippedSamples).toBe(1);
    expect(r.candles.map((c) => c.label)).toEqual(["09:15", "09:18"]);
    expect(r.candles.every((c) => c.pcr === null)).toBe(true);
  });
  it("uses only the newest day and ignores samples outside the session", () => {
    const s = { times: ["2026-11-03T04:00:00Z", "2026-11-04T03:00:00Z", t("03:45"), t("03:48")], spot: [1, 1, 1, 1], pe_oi: [1, 1, 10, 20], ce_oi: [1, 1, 10, 15] };
    const r = smartOiCandles(s, 3);
    expect(r.day).toBe("2026-11-04");
    expect(r.candles.map((c) => c.p)).toEqual([null, 5]);
  });
  it("keeps the close minute (15:40 IST by default) and drops later samples", () => {
    // 15:25, 15:40 and 15:41 IST written as UTC
    const s = { times: [t("09:55"), t("10:10"), t("10:11")], spot: [1, 2, 3], pe_oi: [10, 30, 999], ce_oi: [10, 20, 999] };
    const r = smartOiCandles(s, 3);
    expect(r.candles.map((c) => c.label)).toEqual(["15:24", "15:39"]);
    expect(r.candles[1]!.p).toBe(10);
  });
});

describe("Price vs OI strike board", () => {
  // 04 Nov 2026 (Wednesday): 09:20 and 09:21 IST are in the session, 23:31 IST is not (the sampler also stored that one).
  const res: StrikeSeries = {
    underlying: "NIFTY", expiry: "2026-11-09", strikes: [23950], atm_strike: 23950,
    times: ["2026-11-04T03:50:00Z", "2026-11-04T03:51:00Z", "2026-11-04T18:01:00Z"],
    spot: [23960, 23970, 23980],
    ce_price: { "23950": [100, 110, 120] }, pe_price: { "23950": [80, null, 60] },
    ce_oi: { "23950": [400_000, 0, 500_000] }, pe_oi: { "23950": [800_000, 900_000, 700_000] },
    ce_change: { "23950": [10, 20, 30] }, pe_change: { "23950": [-5, null, 7] },
    stride: 1, warnings: [], definitions: {},
  };
  it("keeps session samples only and derives the straddle and PCR by hand-checked arithmetic", () => {
    const b = strikeBoard(res, 23950)!;
    expect(b.times).toHaveLength(2);
    expect(b.outsideSession).toBe(1);
    expect(b.straddle).toEqual([180, null]); // 100 + 80; the second sample has no put price: a gap, not 110 + 0
    expect(b.straddleGaps).toBe(1);
    expect(b.pcr).toEqual([2, null]); // 800000 / 400000; a call OI of 0 gives no ratio
    expect(b.pePrice).toEqual([80, null]);
    expect(b.peChange).toEqual([-5, null]);
  });
  it("returns nothing for a strike that was not asked for", () => {
    expect(strikeBoard(res, 24000)).toBeNull();
  });
  it("picks the listed strikes nearest the ATM, in order", () => {
    const ks = [23800, 23850, 23900, 23950, 24000, 24050, 24100];
    expect(strikesAround(ks, 23950, 3)).toEqual([23900, 23950, 24000]);
    expect(strikesAround(ks, 23800, 3)).toEqual([23800, 23850, 23900]); // at the edge the window slides, it does not shrink
    expect(strikesAround(ks, null, 2)).toEqual([23800, 23850]);
  });
});
