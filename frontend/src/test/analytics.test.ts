import { describe, expect, it } from "vitest";
import { atmStraddle, compactIN, computeTotals, maxPain, pcr, rangeObservations, universeRows } from "../lib/analytics";
import type { OptionChainRow, OptionQuote } from "../lib/types";

const q = (over: Partial<OptionQuote> = {}): OptionQuote => ({
  exchange_segment: "nse_fo", instrument_token: "1", trading_symbol: "X", option_type: "CE",
  ltp: 10, open: null, high: null, low: null, prev_close: null, close: null, volume: 100, oi: 1000,
  oi_previous: 900, oi_change: 100, oi_change_pct: null, moneyness: null, invalid_fields: [], ...over,
});
const row = (strike: number, c: Partial<OptionQuote> | null, p: Partial<OptionQuote> | null): OptionChainRow => ({
  strike, call: c ? q(c) : null, put: p ? q({ option_type: "PE", ...p }) : null,
});

describe("computeTotals", () => {
  it("sums each side and keeps missing values out of the sums, counted", () => {
    const t = computeTotals([
      row(100, { oi: 10, volume: 1, oi_change: 1 }, { oi: 20, volume: 2, oi_change: -2 }),
      row(110, { oi: null, volume: 3, oi_change: null }, { oi: 40, volume: null, oi_change: 4 }),
    ]);
    expect(t).toMatchObject({ ceOi: 10, peOi: 60, ceVolume: 4, peVolume: 2, ceOiChange: 1, peOiChange: 2, strikes: 2 });
    expect(t.missing).toEqual({ oi: 1, oiChange: 1, volume: 1 });
  });
  it("is null, not zero, when nothing is available", () => {
    const t = computeTotals([row(100, { oi: null }, null)]);
    expect(t.ceOi).toBeNull();
    expect(t.peOi).toBeNull();
    expect(computeTotals([]).ceOi).toBeNull();
  });
});

describe("pcr", () => {
  it("is put total over call total", () => expect(pcr(150, 100)).toBe(1.5));
  it("is null for a zero or missing denominator or numerator", () => {
    expect(pcr(10, 0)).toBeNull();
    expect(pcr(10, null)).toBeNull();
    expect(pcr(null, 10)).toBeNull();
  });
  it("a zero numerator is a real 0", () => expect(pcr(0, 10)).toBe(0));
});

describe("maxPain", () => {
  // Hand-checked example. Strikes 100/110/120, units of OI:
  //   CE OI: 100->10, 110->20, 120->30     PE OI: 100->30, 110->20, 120->10
  // payout(S) = sum CE*max(0,S-K) + PE*max(0,K-S):
  //   S=100: CE 0 ; PE 110->20*10=200, 120->10*20=200            => 400
  //   S=110: CE 100->10*10=100 ; PE 120->10*10=100               => 200
  //   S=120: CE 100->10*20=200, 110->20*10=200 ; PE 0            => 400
  const rows = [
    row(100, { oi: 10 }, { oi: 30 }),
    row(110, { oi: 20 }, { oi: 20 }),
    row(120, { oi: 30 }, { oi: 10 }),
  ];
  it("finds the strike with the smallest total payout", () => {
    expect(maxPain(rows)).toMatchObject({ strike: 110, payout: 200, usedStrikes: 3, excludedStrikes: 0 });
  });
  it("matches a brute-force search on a larger chain", () => {
    const big = Array.from({ length: 25 }, (_, i) =>
      row(22000 + i * 50, { oi: ((i * 7919) % 100 + 1) * 65 }, { oi: (((24 - i) * 104729) % 100 + 1) * 65 }));
    const mp = maxPain(big)!;
    let best = Infinity, bestK = 0;
    for (const s of big) {
      let p = 0;
      for (const r of big) p += r.call!.oi! * Math.max(0, s.strike - r.strike) + r.put!.oi! * Math.max(0, r.strike - s.strike);
      if (p < best) { best = p; bestK = s.strike; }
    }
    expect(mp.strike).toBe(bestK);
    expect(mp.payout).toBe(best);
  });
  it("excludes strikes with missing OI and reports them", () => {
    const withGap = [...rows, row(130, { oi: null }, { oi: 5 })];
    expect(maxPain(withGap)).toMatchObject({ strike: 110, excludedStrikes: 1, usedStrikes: 3 });
  });
  it("returns null with no valid strikes", () => {
    expect(maxPain([])).toBeNull();
    expect(maxPain([row(100, { oi: null }, { oi: 1 })])).toBeNull();
  });
});

describe("atmStraddle", () => {
  const rows = [row(100, { ltp: 40.5 }, { ltp: 35.25 }), row(110, { ltp: null }, { ltp: 50 })];
  it("adds the ATM call and put LTP", () => expect(atmStraddle(rows, 100)).toEqual({ strike: 100, call: 40.5, put: 35.25, premium: 75.75 }));
  it("is null when either leg or the strike is missing", () => {
    expect(atmStraddle(rows, 110)).toBeNull();
    expect(atmStraddle(rows, 999)).toBeNull();
    expect(atmStraddle(rows, null)).toBeNull();
  });
});

describe("universeRows", () => {
  const rows = [90, 100, 110, 120, 130].map((k) => row(k, {}, {}));
  it("keeps ATM plus N strikes each side and clips at the ends", () => {
    expect(universeRows(rows, 110, 1).map((r) => r.strike)).toEqual([100, 110, 120]);
    expect(universeRows(rows, 90, 2).map((r) => r.strike)).toEqual([90, 100, 110]);
  });
  it("returns everything for 'all' or an unknown ATM", () => {
    expect(universeRows(rows, 110, "all")).toHaveLength(5);
    expect(universeRows(rows, null, 1)).toHaveLength(5);
    expect(universeRows(rows, 555, 1)).toHaveLength(5);
  });
});

describe("compactIN", () => {
  it("uses lakh and crore", () => {
    expect(compactIN(12_345_678)).toBe("1.23 Cr");
    expect(compactIN(123_456)).toBe("1.23 L");
    expect(compactIN(-250_000)).toBe("−2.50 L");
    expect(compactIN(5_400)).toBe("5.4 K");
    expect(compactIN(null)).toBe("—");
  });
});

describe("rangeObservations", () => {
  // IST wall-clock -> ISO (UTC = IST - 5:30). Samples: yesterday 14:00; today 09:00, 09:15, 12:00, 15:30, 15:31.
  const at = (day: number, h: number, m: number) => ({ retrieved_at: new Date(Date.UTC(2026, 9, day, h, m) - 5.5 * 3600_000).toISOString(), tag: `${day}@${h}:${m}` });
  const obs = [at(28, 14, 0), at(29, 9, 0), at(29, 9, 15), at(29, 12, 0), at(29, 15, 30), at(29, 15, 31)];
  const tags = (r: { rows: { tag: string }[] }) => r.rows.map((o) => o.tag);

  it("session keeps the newest day's 09:15-15:30 samples only (edges included)", () => {
    const r = rangeObservations(obs, "session");
    expect(tags(r)).toEqual(["29@9:15", "29@12:0", "29@15:30"]);
    expect(r.note).toBeNull();
  });
  it("30 min and 1 hour are measured back from the newest sample, not the wall clock", () => {
    expect(tags(rangeObservations(obs, "30m"))).toEqual(["29@15:30", "29@15:31"]); // >= 15:01
    expect(tags(rangeObservations(obs, "1h"))).toEqual(["29@15:30", "29@15:31"]); // >= 14:31, 12:00 is out
  });
  it("all returns everything and an empty input stays empty", () => {
    expect(rangeObservations(obs, "all").rows).toHaveLength(6);
    expect(rangeObservations([], "session")).toEqual({ rows: [], note: null });
  });
  it("a day with only pre-market samples shows that day and says so", () => {
    const pre = [at(28, 14, 0), at(29, 8, 40), at(29, 9, 5)];
    const r = rangeObservations(pre, "session");
    expect(tags(r)).toEqual(["29@8:40", "29@9:5"]);
    expect(r.note).toMatch(/No sample from 09:15–15:30 on 2026-10-29/);
  });
});
