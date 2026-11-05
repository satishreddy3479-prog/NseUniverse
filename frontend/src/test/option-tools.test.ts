import { describe, expect, it } from "vitest";
import { buildupOf, chainGreeks, exposures, peCeDifference, smartOiSummary, type StrikeGreeks , smartOiCandles, strikeBoard, strikesAround, vegaCandles, vegaSeries } from "../lib/optionTools";
import { contractGreeks, expiryEnd } from "../lib/optionModel";
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
  it("measures the first candle and the day lines against yesterday's close when the stored change exists", () => {
    // 09:15 sample: put OI +151k and call OI −2.77M against yesterday, as in a platform's day-change view
    const withChange = { ...series, pe_change: [151_000, 351_000, 851_000, 901_000], ce_change: [-2_772_000, -2_722_000, -2_672_000, -1_822_000] };
    const r = smartOiCandles(withChange, 3);
    expect(r.candles[0]!.fromPrevClose).toBe(true);
    expect(r.candles[0]!.p).toBe(151_000 + 2_772_000);
    expect(r.candles[1]!.p).toBe(150_000); // later bars are still candle against candle
    expect(r.candles[0]!.diffDay).toBe(2_923_000);
    expect(r.candles[3]!.peDay).toBe(901_000);
    expect(r.candles[0]!.peVolDelta).toBe(100); // 09:15 candle: all volume since the open
  });
  it("flags a candle whose strike count changed, and drops a volume total that went backwards", () => {
    const s = { ...series, ce_strikes_used: [81, 81, 80, 80], pe_strikes_used: [81, 81, 81, 81], pe_volume: [100, 160, 250, 200], ce_volume: [100, 140, 200, 400] };
    const r = smartOiCandles(s, 3);
    expect(r.candles.map((c) => c.strikesChanged)).toEqual([false, false, true, false]);
    expect(r.strikeChangeCandles).toBe(1);
    expect(r.candles[3]!.peVolDelta).toBeNull(); // 250 → 200: a reset or a vanished strike, never a negative volume
    expect(r.candles[3]!.ceVolDelta).toBe(200);
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

describe("Vega Analysis series", () => {
  // Independent arithmetic: prices come from a closed-form Black-76 written here (numeric normal CDF), not from the app's model.
  const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = (x: number) => { let a = -10, sum = 0; const n = 20000, h = (x - a) / n; for (let i = 0; i <= n; i++) sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * pdf(a + i * h); return (sum * h) / 3; };
  const r = 0.06, sigma = 0.2, spot = 24000;
  const at = Date.parse("2026-11-04T04:00:00Z"); // 09:30 IST
  const T = (expiryEnd("2026-11-09") - at) / (365 * 86_400_000);
  const F = spot * Math.exp(r * T);
  const d1 = (k: number) => (Math.log(F / k) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const call = (k: number) => Math.exp(-r * T) * (F * cdf(d1(k)) - k * cdf(d1(k) - sigma * Math.sqrt(T)));
  const put = (k: number) => call(k) - Math.exp(-r * T) * (F - k);
  const vegaPt = (k: number) => (Math.exp(-r * T) * F * pdf(d1(k)) * Math.sqrt(T)) / 100;
  const strikes = [23900, 24000, 24100];
  const per = (f: (k: number) => number | null) => Object.fromEntries(strikes.map((k) => [String(k), [f(k), f(k)]]));
  const res: StrikeSeries = {
    underlying: "NIFTY", expiry: "2026-11-09", strikes, atm_strike: 24000,
    times: [new Date(at).toISOString(), "2026-11-04T18:01:00Z"], // the second is 23:31 IST: not a session sample
    spot: [spot, spot], ce_price: per(call), pe_price: per(put), ce_oi: per((k) => (k === 24000 ? 100_000 : 50_000)), pe_oi: per(() => 80_000),
    ce_change: per(() => 0), pe_change: per(() => 0), stride: 1, warnings: [], definitions: {},
  };
  it("the Greek basis sums vega per point of one unit of each contract, with no open interest in it", () => {
    const g = vegaSeries(res, "2026-11-09", "greek")[0]!;
    const want = vegaPt(23900) + vegaPt(24000) + vegaPt(24100);
    expect(Math.abs(g.call! / want - 1)).toBeLessThan(1e-3);
    expect(Math.abs(g.put! / want - 1)).toBeLessThan(1e-3); // same strikes and volatility: a put has the call's vega
    expect(Math.abs(g.diff!)).toBeLessThan(want * 2e-3);
    const noOi: StrikeSeries = { ...res, ce_oi: { ...res.ce_oi, "24000": [null, null] } };
    expect(vegaSeries(noOi, "2026-11-09", "greek")[0]!.callN).toBe(3); // OI does not matter for the Greek
  });
  it("sums vega per point x OI per side and takes the difference as put minus call", () => {
    const pts = vegaSeries(res, "2026-11-09", "oi");
    expect(pts).toHaveLength(1); // the after-hours sample is dropped
    const wantCall = vegaPt(23900) * 50_000 + vegaPt(24000) * 100_000 + vegaPt(24100) * 50_000;
    const wantPut = (vegaPt(23900) + vegaPt(24000) + vegaPt(24100)) * 80_000;
    expect(pts[0]!.call!).toBeCloseTo(wantCall, -1); // within 5 rupees of ~ crores: the implied-volatility solve is numeric
    expect(Math.abs(pts[0]!.call! / wantCall - 1)).toBeLessThan(1e-3);
    expect(Math.abs(pts[0]!.put! / wantPut - 1)).toBeLessThan(1e-3);
    expect(pts[0]!.diff).toBeCloseTo(pts[0]!.put! - pts[0]!.call!, 6);
    expect(pts[0]!.callN).toBe(3);
  });
  it("the change basis is the OI-weighted vega minus its value at the first session sample, starting at zero", () => {
    const two: StrikeSeries = {
      ...res, times: [new Date(at).toISOString(), new Date(at).toISOString()], spot: [spot, spot], // same instant: only OI differs
      ce_oi: { "23900": [50_000, 50_000], "24000": [100_000, 130_000], "24100": [50_000, 40_000] }, pe_oi: per(() => 80_000),
    };
    const [a, b] = vegaSeries(two, "2026-11-09", "change");
    expect(a!.call).toBeCloseTo(0, 6); // the first sample is the reference
    // +30,000 at 24,000 and -10,000 at 24,100 (one minute later, same vega as before to within the model's tolerance)
    const want = vegaPt(24000) * 30_000 - vegaPt(24100) * 10_000;
    expect(Math.abs(b!.call! / want - 1)).toBeLessThan(2e-3);
    expect(b!.put!).toBeCloseTo(0, 6); // put OI did not change
  });
  it("the change-since-open basis starts both lines at zero, and a volatility rise lifts the call and put sums by hand-checked amounts", () => {
    // second sample with every price raised to the model value at 24 % volatility instead of 20 %
    const sig2 = 0.24;
    const c2 = (k: number) => { const dd = (Math.log(F / k) + 0.5 * sig2 * sig2 * T) / (sig2 * Math.sqrt(T)); return Math.exp(-r * T) * (F * cdf(dd) - k * cdf(dd - sig2 * Math.sqrt(T))); };
    const p2 = (k: number) => c2(k) - Math.exp(-r * T) * (F - k);
    const v2 = (k: number) => { const dd = (Math.log(F / k) + 0.5 * sig2 * sig2 * T) / (sig2 * Math.sqrt(T)); return (Math.exp(-r * T) * F * pdf(dd) * Math.sqrt(T)) / 100; };
    const t2 = [new Date(at).toISOString(), new Date(at).toISOString()]; // same instant: only the volatility differs, not the time left
    const two: StrikeSeries = {
      ...res, times: t2, spot: [spot, spot],
      ce_price: Object.fromEntries(strikes.map((k) => [String(k), [call(k), c2(k)]])), pe_price: Object.fromEntries(strikes.map((k) => [String(k), [put(k), p2(k)]])),
    };
    const [a, b] = vegaSeries(two, "2026-11-09", "dgreek");
    expect(a!.call).toBeCloseTo(0, 9); expect(a!.put).toBeCloseTo(0, 9); expect(a!.diff).toBeCloseTo(0, 9);
    const want = strikes.reduce((x, k) => x + v2(k) - vegaPt(k), 0); // same strikes, same forward: only the volatility moved
    expect(Math.abs(b!.call! / want - 1)).toBeLessThan(5e-3);
    expect(Math.abs(b!.put! / want - 1)).toBeLessThan(5e-3);
    expect(b!.diff).toBeCloseTo(b!.put! - b!.call!, 9);
    expect(b!.fwd).not.toBeNull(); // the synthetic future comes from the chain's own parity
    expect(Math.abs(b!.fwd! - F)).toBeLessThan(1);
  });
  it("a change series measures each strike from its own first value, so a late-priced strike adds nothing at first", () => {
    const at2 = [new Date(at).toISOString(), new Date(at).toISOString()];
    const gap = (k: number) => (k === 24100 ? [null, call(k)] : [call(k), call(k)]); // the 24,100 call has no price in the first sample
    const part: StrikeSeries = {
      ...res, times: at2, spot: [spot, spot],
      ce_price: Object.fromEntries(strikes.map((k) => [String(k), gap(k)])), pe_price: Object.fromEntries(strikes.map((k) => [String(k), [put(k), put(k)]])),
    };
    const s = vegaSeries(part, "2026-11-09", "dgreek");
    expect(s[0]!.callN).toBe(2);
    expect(s[0]!.call).toBeCloseTo(0, 9);
    expect(s[1]!.callN).toBe(3);
    expect(Math.abs(s[1]!.call!)).toBeLessThan(1e-2); // the late strike's first value is its zero
  });
  it("a window keeps ATM ± n strikes of the sample (auto) or of the first sample (fixed)", () => {
    const five = [23800, 23900, 24000, 24100, 24200];
    const mk = (f: (k: number) => number) => Object.fromEntries(five.map((k) => [String(k), [f(k), f(k)]]));
    const w: StrikeSeries = { ...res, strikes: five, ce_price: mk(call), pe_price: mk(put), ce_oi: mk(() => 1), pe_oi: mk(() => 1), ce_change: mk(() => 0), pe_change: mk(() => 0),
      times: [new Date(at).toISOString(), new Date(at + 60_000).toISOString()], spot: [spot, spot] };
    const p = vegaSeries(w, "2026-11-09", "greek", 0.06, undefined, { n: 1, mode: "auto" })[0]!;
    expect(p.callN).toBe(3);
    expect(Math.abs(p.call! / (vegaPt(23900) + vegaPt(24000) + vegaPt(24100)) - 1)).toBeLessThan(1e-3);
    const wide = vegaSeries(w, "2026-11-09", "greek", 0.06, undefined, { n: 2, mode: "fixed" })[0]!;
    expect(wide.callN).toBe(5);
  });
  it("OTM mode takes calls from strikes above NIFTY and puts from strikes below it", () => {
    const p = vegaSeries(res, "2026-11-09", "greek", 0.06, true, { n: 1, mode: "auto" })[0]!; // spot 24,000: the OTM call is 24,100, the OTM put is 23,900
    expect(p.callN).toBe(1);
    expect(p.putN).toBe(1);
    expect(Math.abs(p.call! / vegaPt(24100) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(p.put! / vegaPt(23900) - 1)).toBeLessThan(1e-3);
    expect(p.call!).toBeLessThan(vegaPt(24000)); // an OTM wing has less vega than the money strike
  });
  it("leaves out a contract with no OI instead of counting it as zero, and keeps the last value of each candle", () => {
    const noOi: StrikeSeries = { ...res, ce_oi: { ...res.ce_oi, "24000": [null, null] } };
    const p = vegaSeries(noOi, "2026-11-09", "oi")[0]!;
    expect(p.callN).toBe(2);
    expect(Math.abs(p.call! / (vegaPt(23900) * 50_000 + vegaPt(24100) * 50_000) - 1)).toBeLessThan(1e-3);
    const mk = (min: number, v: number) => ({ t: Date.UTC(2026, 10, 4, 3, 45 + min), spot: 1, fwd: null, call: v, put: v, diff: 0, callN: 1, putN: 1, skipped: 0 });
    const c = vegaCandles([mk(0, 1), mk(1, 2), mk(2, 3), mk(3, 4)], 3, 9 * 60 + 15);
    expect(c.map((x) => x.call)).toEqual([3, 4]); // minutes 0-2 are one 3-minute candle (last value 3), minute 3 starts the next
  });
});

describe("smartOiCandles with one-minute index bars (real highs and lows, no gap to the next candle)", () => {
  const t = (hm: string, day = "2026-11-04") => `${day}T${hm}:00Z`;
  const series = {
    times: [t("03:45"), t("03:48")], spot: [23300, 23310],
    pe_oi: [10_000_000, 10_200_000], ce_oi: [10_000_000, 10_050_000], pe_volume: [100, 160], ce_volume: [100, 140],
  };
  // 09:15, 09:16, 09:17 IST are three minutes of the first 3-minute candle (hand calculation: open of the first, close of the last, extremes of all)
  const bars = [
    { at: t("03:45"), o: 23300, h: 23320, l: 23290, c: 23310 },
    { at: t("03:46"), o: 23310, h: 23315, l: 23305, c: 23308 },
    { at: t("03:47"), o: 23308, h: 23312, l: 23300, c: 23306 },
    { at: t("03:45", "2026-11-03"), o: 1, h: 99999, l: 0.5, c: 2 }, // another day: ignored
  ];
  it("takes open, high, low and close from the minute bars of the slot and leaves a slot without bars on the samples", () => {
    const r = smartOiCandles(series, 3, { bars });
    expect(r.candles[0]!.spot).toEqual({ open: 23300, high: 23320, low: 23290, close: 23306 });
    expect(r.candles[0]!.spotFromBars).toBe(true);
    expect(r.candles[1]!.spot).toEqual({ open: 23310, high: 23310, low: 23310, close: 23310 }); // no bars for 09:18: the one stored sample
    expect(r.candles[1]!.spotFromBars).toBe(false);
  });
  it("is unchanged without bars", () => {
    const r = smartOiCandles(series, 3);
    expect(r.candles[0]!.spot).toEqual({ open: 23300, high: 23300, low: 23300, close: 23300 });
    expect(r.candles.every((c) => !c.spotFromBars)).toBe(true);
  });
});
