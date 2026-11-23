// Mark-to-market of a strategy through the stored samples. Every expected number is a hand calculation (lot 65).
import { describe, expect, it } from "vitest";
import { appendTick, buildMtm, joinLive, mtmStats, splitAtZero } from "../lib/strategyMtm";
import type { Leg } from "../lib/strategy";
import type { FuturesSeries, StrikeSeries } from "../lib/types";

const LOT = 65;
const EXP = "2026-11-24";
const at = (hm: string) => `2026-11-20T${hm}:00.000Z`; // minutes only matter
const times = [at("03:50"), at("03:51"), at("03:52"), at("03:53"), at("03:54")]; // 09:20 .. 09:24 IST

const ss = (ce: (number | null)[], pe: (number | null)[]): StrikeSeries =>
  ({ underlying: "NIFTY", expiry: EXP, strikes: [25800], atm_strike: 25800, times, spot: [], ce_price: { "25800": ce }, pe_price: { "25800": pe }, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {} }) as unknown as StrikeSeries;
const fs = (f: (number | null)[]): FuturesSeries => ({ day: "2026-11-20", contract: "NIFTY26NOVFUT", expiry: EXP, times, future: f }) as unknown as FuturesSeries;
const leg = (o: Partial<Leg>): Leg => ({ id: "x", expiry: EXP, strike: 25800, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", enteredAt: at("03:51"), ...o }) as Leg;

const CE = [100, 100, 105, 110, 95]; // 09:20 .. 09:24
const PE = [90, 90, 85, 80, 92];
const FUT = [25800, 25800, 25790, 25770, 25810];
const legs = [leg({ id: "ce", enteredAt: at("03:50") }), leg({ id: "pe", type: "PE", premium: 90, enteredAt: at("03:51") }), leg({ id: "f", type: "FUT", strike: 0, action: "BUY", premium: 25800, enteredAt: at("03:51") })];

describe("strategy mark-to-market", () => {
  it("short straddle + long future: starts at the first entry, each leg counts from its own entry, and every value is the hand sum", () => {
    const m = buildMtm(legs, LOT, { [EXP]: ss(CE, PE) }, fs(FUT));
    expect(m.reason).toBeNull();
    expect(m.from).toBe(Date.parse(at("03:50")));
    expect(m.t).toHaveLength(5);
    // 09:20 only the call is in (entered 09:20), at its entry price: 0
    // 09:21 all at entry: 0
    // 09:22 CE -(105-100)*65 = -325, PE -(85-90)*65 = +325, FUT (25790-25800)*65 = -650  => -650
    // 09:23 CE -650, PE +650, FUT -30*65 = -1950                                         => -1950
    // 09:24 CE +325 (95), PE -(92-90)*65 = -130, FUT +10*65 = +650                       => +845
    expect(m.pnl).toEqual([0, 0, -650, -1950, 845]);
    expect(m.now).toBe(845);
    expect(m.peak).toEqual({ pnl: 845, t: Date.parse(at("03:54")) });
    expect(m.trough).toEqual({ pnl: -1950, t: Date.parse(at("03:53")) });
    expect(m.drawdown).toEqual({ amount: 1950, from: Date.parse(at("03:50")), to: Date.parse(at("03:53")) }); // from the high of 0 to the low of -1950
  });

  it("a leg that has exited keeps what it booked: the call stopped at 110 (-650) is a constant afterwards", () => {
    const out = [leg({ id: "ce", enteredAt: at("03:50"), exitPrice: 110, exitedAt: at("03:52"), exitReason: "stop", realised: -650 }), legs[1]!, legs[2]!];
    const m = buildMtm(out, LOT, { [EXP]: ss(CE, PE) }, fs(FUT));
    // the call exits at 09:22: from then on it is -650 flat. 09:21 is before the exit (0); 09:22: -650 + 325 - 650 = -975
    // 09:23: -650 + 650 - 1950 = -1950 ; 09:24: -650 - 130 + 650 = -130
    expect(m.pnl).toEqual([0, 0, -975, -1950, -130]);
  });

  it("a price that was not stored leaves a gap, counted, never zero or carried forward", () => {
    const m = buildMtm(legs, LOT, { [EXP]: ss(CE, [90, 90, null, 80, 92]) }, fs(FUT));
    expect(m.pnl).toEqual([0, 0, null, -1950, 845]);
    expect(m.missing).toBe(1);
  });

  it("a leg re-entered after a booked cycle counts the earlier booking from its new entry", () => {
    // the call was stopped once for -650, then entered again at 100 at 09:21: realised -650 stays, the current cycle is open
    const re = [leg({ id: "ce", enteredAt: at("03:51"), realised: -650, cycles: 1 })];
    const m = buildMtm(re, LOT, { [EXP]: ss(CE, PE) }, undefined);
    expect(m.pnl).toEqual([-650, -650 - 325, -650 - 650, -650 + 325]);
  });

  it("says why nothing is drawn: no legs, no entry price, no entry time, no samples yet, a future whose contract is not stored", () => {
    expect(buildMtm([], LOT, {}, undefined).reason).toMatch(/at least one leg/);
    expect(buildMtm([leg({ premium: null })], LOT, {}, undefined).reason).toMatch(/entry price/);
    const untimed = buildMtm([leg({ enteredAt: null })], LOT, { [EXP]: ss(CE, PE) }, undefined);
    expect(untimed.reason).toMatch(/no recorded entry time/); expect(untimed.untimed).toBe(1);
    expect(buildMtm([leg({ enteredAt: at("05:00") })], LOT, { [EXP]: ss(CE, PE) }, undefined).reason).toMatch(/No stored sample/);
    const wrong = buildMtm([legs[2]!], LOT, {}, { ...fs(FUT), expiry: "2026-12-29" } as FuturesSeries); // the stored future is the other month's
    expect(wrong.pnl.every((v) => v == null)).toBe(true);
  });
});

describe("splitAtZero: green above, red below", () => {
  it("a rise from -10 to +10 over 10 minutes crosses zero exactly halfway: the added point is at 5, value 0", () => {
    const z = splitAtZero([0, 10], [-10, 10]);
    expect(z.full).toEqual([[0, -10], [5, 0], [10, 10]]);
    expect(z.pos).toEqual([[0, 0], [5, 0], [10, 10]]); // the green area starts at the crossing, not at the first sample
    expect(z.neg).toEqual([[0, -10], [5, 0], [10, 0]]);
    expect(z.linePos).toEqual([[0, null], [5, 0], [10, 10]]);
    expect(z.lineNeg).toEqual([[0, -10], [5, 0], [10, null]]);
  });
  it("an uneven crossing is interpolated: +30 to -10 over 4 minutes crosses at 3 minutes", () => {
    expect(splitAtZero([0, 4], [30, -10]).full[1]).toEqual([3, 0]);
  });
  it("no crossing adds nothing; a sample exactly at zero is not a crossing; a gap stays a gap and is not bridged", () => {
    expect(splitAtZero([0, 1, 2], [1, 2, 3]).full).toHaveLength(3);
    expect(splitAtZero([0, 1, 2], [-1, 0, 1]).full).toEqual([[0, -1], [1, 0], [2, 1]]);
    const g = splitAtZero([0, 1, 2], [-5, null, 5]);
    expect(g.full).toEqual([[0, -5], [1, null], [2, 5]]); // no crossing is invented across a missing minute
    expect(g.pos[1]).toEqual([1, null]);
  });
});

describe("live ticks", () => {
  it("a point is kept only when the value changed", () => {
    let s = appendTick([], 1000, 50);
    s = appendTick(s, 2000, 50); s = appendTick(s, 3000, 70);
    expect(s).toEqual([{ t: 1000, v: 50 }, { t: 3000, v: 70 }]);
  });
  it("past the cap the oldest are thinned and the newest point is kept", () => {
    let s: { t: number; v: number }[] = [];
    for (let i = 0; i < 11; i++) s = appendTick(s, i, i + 1, 10);
    expect(s.length).toBeLessThanOrEqual(7); expect(s[s.length - 1]).toEqual({ t: 10, v: 11 });
  });
  it("stored samples before the first live tick, then the live ticks; a missing stored value is left out", () => {
    const j = joinLive([{ t: 1, pnl: 10 }, { t: 2, pnl: null }, { t: 3, pnl: -5 }, { t: 9, pnl: 99 }], [{ t: 5, v: 20 }, { t: 6, v: 15 }]);
    expect(j).toEqual([{ t: 1, v: 10 }, { t: 3, v: -5 }, { t: 5, v: 20 }, { t: 6, v: 15 }]);
    expect(joinLive([], [{ t: 5, v: 20 }])).toEqual([{ t: 5, v: 20 }]);
  });
  it("high, low and the largest fall from a high, by hand: 0, 300, 100, 250, -50, 80 gives high 300, low -50, drawdown 350 from 300 to -50", () => {
    const st = mtmStats([0, 300, 100, 250, -50, 80].map((v, i) => ({ t: i, v })));
    expect(st.high).toEqual({ v: 300, t: 1 }); expect(st.low).toEqual({ v: -50, t: 4 }); expect(st.now).toBe(80);
    expect(st.drawdown).toEqual({ amount: 350, from: 1, to: 4 });
    expect(mtmStats([]).high).toBeNull();
    expect(mtmStats([{ t: 0, v: 5 }, { t: 1, v: 9 }]).drawdown).toBeNull(); // only rising: no fall
  });
});
