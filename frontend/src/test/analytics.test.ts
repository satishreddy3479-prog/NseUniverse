import { describe, expect, it } from "vitest";
import { sessionDays, sessionWindow, atmStraddle, buildupRows, buildupSession, classifyBuildup, compactIN, computeTotals, maxPain, OI_WINDOWS, oiWindowStats, isSessionMs, pcr, rangeObservations, spanMinutes, universeRows, windowEndIso, windowStartIso } from "../lib/analytics";
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
  // IST wall-clock -> ISO (UTC = IST - 5:30). Samples: yesterday 14:00; today 09:00, 09:15, 12:00, 15:40, 15:41 (derivatives trade until 15:40; 09:00 and 15:41 are outside the session).
  const at = (day: number, h: number, m: number) => ({ retrieved_at: new Date(Date.UTC(2026, 9, day, h, m) - 5.5 * 3600_000).toISOString(), tag: `${day}@${h}:${m}` });
  const obs = [at(28, 14, 0), at(29, 9, 0), at(29, 9, 15), at(29, 12, 0), at(29, 15, 40), at(29, 15, 41)];
  const tags = (r: { rows: { tag: string }[] }) => r.rows.map((o) => o.tag);

  it("session keeps the newest day's 09:15-15:40 samples only (edges included)", () => {
    const r = rangeObservations(obs, "session");
    expect(tags(r)).toEqual(["29@9:15", "29@12:0", "29@15:40"]);
    expect(r.note).toBeNull();
  });
  it("30 min and 1 hour are measured back from the newest in-session sample; the 15:41 after-hours sample is never drawn", () => {
    expect(tags(rangeObservations(obs, "30m"))).toEqual(["29@15:40"]);
    expect(tags(rangeObservations(obs, "1h"))).toEqual(["29@15:40"]); // >= 14:40, 12:00 is out
  });
  it("all returns every in-session sample (not the 09:00 and 15:41 ones) and an empty input stays empty", () => {
    expect(tags(rangeObservations(obs, "all"))).toEqual(["28@14:0", "29@9:15", "29@12:0", "29@15:40"]);
    expect(rangeObservations([], "session")).toEqual({ rows: [], note: null, bounds: null, afterHoursOnly: false });
  });
  it("session fixes the axis to that day's 09:15 to 15:40", () => {
    const b = rangeObservations(obs, "session").bounds!;
    expect(b.min).toBe(Date.UTC(2026, 9, 29, 9, 15) - 5.5 * 3600_000);
    expect(b.max).toBe(Date.UTC(2026, 9, 29, 15, 40) - 5.5 * 3600_000);
  });
  it("the axis fits the data: a morning's samples end a little after the newest one, not at the close", () => {
    const m = (h: number, mi: number) => Date.UTC(2026, 9, 29, h, mi) - 5.5 * 3600_000;
    const morning = [at(29, 9, 15), at(29, 9, 25), at(29, 9, 33)];
    // session: from the 09:15 open; room = max(2 min, 6 % of the 18 min) = 2 min
    expect(rangeObservations(morning, "session").bounds).toEqual({ min: m(9, 15), max: m(9, 35) });
    // 30 min and 1 hour cannot start before the first sample: the same line, the same axis
    expect(rangeObservations(morning, "30m").bounds).toEqual({ min: m(9, 15), max: m(9, 35) });
    expect(rangeObservations(morning, "1h").bounds).toEqual({ min: m(9, 15), max: m(9, 35) });
    // later in the day the windows differ: 30 min = 14:30-15:00 (+2 min), 1 hour = 14:00-15:00 (+3.6 min), session = 09:15-15:00 (+6 % of 5 h 45 min = 20.7 min)
    const day = [at(29, 9, 15), at(29, 12, 0), at(29, 14, 0), at(29, 14, 30), at(29, 15, 0)];
    expect(rangeObservations(day, "30m").bounds).toEqual({ min: m(14, 30), max: m(15, 0) + 2 * 60_000 });
    expect(rangeObservations(day, "1h").bounds).toEqual({ min: m(14, 0), max: m(15, 0) + 3.6 * 60_000 });
    expect(rangeObservations(day, "session").bounds).toEqual({ min: m(9, 15), max: m(15, 0) + 20.7 * 60_000 });
    expect(rangeObservations(day, "all").bounds).toBeNull(); // All: the chart fits itself
  });
  it("spanMinutes says how much history there really is", () => {
    expect(spanMinutes([at(29, 9, 15), at(29, 9, 33)])).toBe(18);
    expect(spanMinutes([at(29, 9, 15)])).toBe(0);
  });
  it("samples fetched overnight or at the weekend are not session samples", () => {
    const night = [at(30, 2, 37), at(30, 8, 17), at(31, 12, 0), at(29, 12, 0)]; // Fri 02:37, Fri 08:17, Sat noon, Thu noon
    expect(tags(rangeObservations(night, "all"))).toEqual(["29@12:0"]);
    expect(isSessionMs(Date.UTC(2026, 9, 31, 6, 30))).toBe(false); // Saturday 12:00 IST
    expect(isSessionMs(Date.UTC(2026, 9, 30, 6, 30))).toBe(true); // Friday 12:00 IST
    expect(isSessionMs(Date.UTC(2026, 9, 30, 10, 10))).toBe(true); // Friday 15:40 IST, the close
    expect(isSessionMs(Date.UTC(2026, 9, 30, 10, 11))).toBe(false); // 15:41
  });
  it("with no in-session sample at all, the after-hours ones are returned and the note says so", () => {
    const pre = [at(29, 8, 40), at(29, 9, 5)];
    const r = rangeObservations(pre, "session");
    expect(tags(r)).toEqual(["29@8:40", "29@9:5"]);
    expect(r.afterHoursOnly).toBe(true);
    expect(r.note).toMatch(/No sample was taken during 09:15–15:40/);
  });
});

describe("OI by window", () => {
  it("starts the window at the newest stored sample minus its length", () => {
    expect(windowStartIso("2026-10-28T04:45:00.000Z", 30)).toBe("2026-10-28T04:15:00.000Z");
    expect(windowStartIso("2026-10-28T04:45:00Z", 180)).toBe("2026-10-28T01:45:00.000Z");
    expect(OI_WINDOWS.map((w) => w.minutes)).toEqual([3, 5, 10, 15, 30, 60, 120, 180, null]);
  });

  it("derives totals, PCR and PCR of OI change by hand", () => {
    // calls 210 now (+60 -> 150 before), puts 90 now (-30 -> 120 before)
    const s = oiWindowStats({ ce_oi: 210, pe_oi: 90, ce_change: 60, pe_change: -30 });
    expect(s.pcr).toBeCloseTo(90 / 210, 10);
    expect(s.pcrBaseline).toBeCloseTo(120 / 150, 10);
    expect(s.pcrChange).toBeCloseTo(90 / 210 - 0.8, 10);
    expect(s.pcrOiChange).toBe(-0.5); // put change -30 / call change +60
  });

  it("leaves a ratio empty instead of dividing by zero or inventing a baseline", () => {
    expect(oiWindowStats({ ce_oi: 100, pe_oi: 80, ce_change: 0, pe_change: 20 })).toMatchObject({ pcrOiChange: null, pcrOiChangeNote: "call OI did not increase, so the ratio is not meaningful" });
    expect(oiWindowStats({ ce_oi: 100, pe_oi: 80, ce_change: -5, pe_change: 20 }).pcrOiChange).toBeNull();
    const none = oiWindowStats({ ce_oi: 100, pe_oi: 80, ce_change: null, pe_change: null });
    expect(none.pcrBaseline).toBeNull();
    expect(none.pcrChange).toBeNull();
    expect(none.pcrOiChangeNote).toBe("no baseline OI for the window");
    expect(oiWindowStats({ ce_oi: 0, pe_oi: 80, ce_change: null, pe_change: null }).pcr).toBeNull();
    expect(oiWindowStats({ ce_oi: null, pe_oi: null, ce_change: null, pe_change: null }).pcr).toBeNull();
  });
});

describe("windowEndIso", () => {
  // IST 15:30 is 10:00Z and 09:15 IST is 03:45Z
  it("is the newest sample while the session runs", () => {
    expect(windowEndIso(["2026-10-29T04:00:00Z", "2026-10-29T06:00:00Z"])).toBe("2026-10-29T06:00:00Z");
  });
  it("after the close it is the last sample taken inside the session of the same day", () => {
    const s = ["2026-10-29T09:58:00Z", "2026-10-29T09:59:02Z", "2026-10-29T14:51:00Z", "2026-10-29T18:11:00Z"];
    expect(windowEndIso(s)).toBe("2026-10-29T09:59:02Z");
  });
  it("still finds the session when after-hours samples run past midnight IST", () => {
    // 18:36Z on 29 Oct is 00:06 IST on 30 Oct
    expect(windowEndIso(["2026-10-29T09:59:02Z", "2026-10-29T14:51:00Z", "2026-10-29T18:36:00Z"])).toBe("2026-10-29T09:59:02Z");
  });
  it("falls back to the newest sample when nothing was taken in session that day; null when empty", () => {
    expect(windowEndIso(["2026-10-29T00:38:00Z"])).toBe("2026-10-29T00:38:00Z");
    expect(windowEndIso([])).toBeNull();
  });
});

describe('futures buildup', () => {
  it('classifies the four combinations, zero as unchanged and a missing change as missing', () => {
    expect(classifyBuildup(1, 1)).toBe('long buildup');
    expect(classifyBuildup(-1, 1)).toBe('short buildup');
    expect(classifyBuildup(1, -1)).toBe('short covering');
    expect(classifyBuildup(-1, -1)).toBe('long unwinding');
    expect(classifyBuildup(0, 5)).toBe('unchanged');
    expect(classifyBuildup(null, 5)).toBe('missing');
    expect(classifyBuildup(5, null)).toBe('missing');
  });

  // 09:15 IST = 03:45 UTC. Hand calculation per 15-minute window; each starts from the last value known before it.
  const T = ['2026-11-05T03:45:00Z', '2026-11-05T03:50:00Z', '2026-11-05T04:01:00Z', '2026-11-05T04:16:00Z', '2026-11-05T04:31:00Z', '2026-11-05T04:46:00Z'];
  const P = [100, 101, 100.5, 101, 100, 101];
  const O: (number | null)[] = [1000, 1100, 1050, null, 1200, 1100];
  it('builds windows from the open and never fills a missing value', () => {
    const r = buildupRows(T, P, O, 15);
    expect(r.map((x) => x.state)).toEqual(['long buildup', 'long unwinding', 'missing', 'short buildup', 'short covering']);
    expect(r[0]).toMatchObject({ priceFrom: 100, priceTo: 101, priceChg: 1, oiFrom: 1000, oiTo: 1100, oiChg: 100 });
    expect(r[0]!.priceChgPct).toBeCloseTo(1, 10);
    expect(r[0]!.oiChgPct).toBeCloseTo(10, 10);
    expect(r[1]).toMatchObject({ priceChg: -0.5, oiChg: -50 }); // 101 -> 100.5 and 1100 -> 1050
    expect(r[2]).toMatchObject({ priceChg: 0.5, oiTo: null, oiChg: null }); // OI not recorded in this window
    expect(r[3]).toMatchObject({ priceChg: -1, oiFrom: 1050, oiChg: 150 }); // OI start is the last known value, 1050
    expect(r[4]).toMatchObject({ priceChg: 1, oiChg: -100 });
  });
  it('gives the whole session as one window and ignores samples before the open', () => {
    const s = buildupSession(['2026-11-05T03:30:00Z', ...T], [90, ...P], [500, ...O]);
    expect(s).toMatchObject({ priceFrom: 100, priceTo: 101, oiFrom: 1000, oiTo: 1100, state: 'long buildup' });
    expect(buildupSession([], [], [])).toBeNull();
  });
});

describe("session and timeline of the price boards", () => {
  // Wed 4 Nov 09:15-09:30 IST (03:45-04:00 UTC) and Thu 5 Nov 09:15-10:15 IST (03:45-04:45 UTC); 15:40 IST close = 10:10 UTC
  const at = (iso: string) => ({ retrieved_at: `2026-11-0${iso}Z` });
  const obs = [at("4T03:45:00"), at("4T03:50:00"), at("4T04:00:00"), at("5T03:45:00"), at("5T04:15:00"), at("5T04:45:00"), at("5T14:30:00")]; // the last is after hours
  const ms = (s: string) => new Date(`2026-11-0${s}Z`).getTime();

  it("lists the days that have in-session samples, newest first, and ignores after-hours ones", () => {
    expect(sessionDays(obs)).toEqual(["2026-11-05", "2026-11-04"]);
  });

  it("fits the newest session from its first to its newest sample plus a little room for the value tags", () => {
    const w = sessionWindow(obs, null, "fit");
    expect(w.day).toBe("2026-11-05");
    expect(w.since).toBe("2026-11-05T03:45:00Z");
    expect(w.until).toBeUndefined(); // the newest day keeps updating
    // 60 minutes of data: room = max(2 min, 6 % of 60 min = 3.6 min)
    expect(w.bounds).toEqual({ min: ms("5T03:45:00"), max: ms("5T04:45:00") + 3.6 * 60_000 });
  });

  it("shows the whole session, or only the last stretch of it", () => {
    expect(sessionWindow(obs, null, "day").bounds).toEqual({ min: ms("5T03:45:00"), max: ms("5T10:10:00") });
    // last 30 min of a 60-minute session: from 04:15, room = max(2 min, 6 % of 30 min = 1.8 min) = 2 min
    expect(sessionWindow(obs, null, "30m").bounds).toEqual({ min: ms("5T04:15:00"), max: ms("5T04:45:00") + 2 * 60_000 });
    // a longer window than the data starts at the first sample, not before it
    expect(sessionWindow(obs, null, "2h").bounds!.min).toBe(ms("5T03:45:00"));
  });

  it("an earlier session is cut at its own close and never extends into the next day", () => {
    const w = sessionWindow(obs, "2026-11-04", "fit");
    expect(w.day).toBe("2026-11-04");
    expect(w.since).toBe("2026-11-04T03:45:00Z");
    expect(w.until).toBe("2026-11-04T10:11:00.000Z"); // close 10:10 UTC + 1 minute
    expect(w.bounds).toEqual({ min: ms("4T03:45:00"), max: ms("4T04:00:00") + 2 * 60_000 });
    expect(w.samples).toBe(3);
    expect(sessionWindow(obs, "2020-01-01", "fit").day).toBe("2026-11-05"); // an unknown day falls back to the newest
  });

  it("says when only after-hours samples exist, and when there are none", () => {
    const night = sessionWindow([at("5T14:30:00")], null, "fit");
    expect(night).toMatchObject({ days: [], day: null, bounds: null, afterHoursOnly: true });
    expect(sessionWindow([], null, "fit")).toMatchObject({ day: null, afterHoursOnly: false });
  });
});

describe("sessionDays on an exchange holiday", () => {
  const at = (day: string, min: number, same = false) => ({ retrieved_at: new Date(Date.parse(`${day}T03:45:00Z`) + min * 60_000).toISOString(), same_as_previous: same }); // 09:15 IST + min
  it("does not count a day of stale repeated samples as a session, but counts a real day and a real day that has only just started", () => {
    const real = Array.from({ length: 30 }, (_, i) => at("2026-11-09", i));
    const holiday = [...Array.from({ length: 3 }, (_, i) => at("2026-11-10", i)), ...Array.from({ length: 12 }, (_, i) => at("2026-11-10", 3 + i, true))];
    expect(sessionDays([...real, ...holiday])).toEqual(["2026-11-09"]); // 3 changed + 12 unchanged: not a session
    const justStarted = Array.from({ length: 3 }, (_, i) => at("2026-11-11", i)); // nothing unchanged: a real session beginning
    expect(sessionDays([...real, ...justStarted])).toEqual(["2026-11-11", "2026-11-09"]);
    const busy = Array.from({ length: 14 }, (_, i) => at("2026-11-12", i, i === 5)); // one unchanged but 13 changed: a session
    expect(sessionDays(busy)).toEqual(["2026-11-12"]);
  });
});
