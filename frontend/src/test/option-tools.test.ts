import { describe, expect, it } from "vitest";
import { buildupOf, chainGreeks, exposures, peCeDifference, smartOiSummary, type StrikeGreeks } from "../lib/optionTools";
import { contractGreeks } from "../lib/optionModel";
import type { OptionChainRow, OptionQuote } from "../lib/types";

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
