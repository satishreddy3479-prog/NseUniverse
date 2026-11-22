// The NIFTY future as a strategy leg: payoff at expiry, model value, Greeks, validation, rolling and the contract helpers.
// Every expected number below is a hand calculation (shown beside it), not read back from the code under test.
import { describe, expect, it } from "vitest";
import { futureGreeks, futureValue, expiryEnd, legGreeks, theoreticalPnl, type Valuation } from "../lib/optionModel";
import { analyzeExpiry, expiryPnl, payoffCurve, rollFutureLeg, validateStrategy, type Leg } from "../lib/strategy";
import { futureOf, futurePrice, futureToAdd, futureToRollInto, type FutureContracts } from "../lib/futures";
import { legsFromBuilder } from "../lib/risk";

const LOT = 65;
const EXP = "2026-11-24";
const leg = (o: Partial<Leg>): Leg => ({ id: "x", expiry: EXP, strike: 25800, type: "CE", action: "BUY", lots: 1, premium: 100, premiumSource: "manual", ...o }) as Leg;
const fut = (action: "BUY" | "SELL", entry: number, o: Partial<Leg> = {}): Leg => leg({ type: "FUT", strike: 0, action, premium: entry, ...o });

describe("expiry payoff with a future (exact)", () => {
  it("long future + long put (a protected long): P&L = (S-25800)*65 + (max(25800-S,0)-150)*65", () => {
    const legs = [fut("BUY", 25800), leg({ type: "PE", premium: 150 })];
    expect(expiryPnl(legs, 26000, LOT)).toBe(200 * 65 - 150 * 65); // 3 250
    expect(expiryPnl(legs, 25000, LOT)).toBe(-800 * 65 + (800 - 150) * 65); // -9 750
    const a = analyzeExpiry(legs, LOT);
    expect(a.maxLoss).toBe(-150 * 65); // the put's cost, whatever happens below
    expect(a.profitUnlimited).toBe(true); // the future keeps gaining above
    expect(a.breakevens).toEqual([25950]); // (S-25800) = 150
  });

  it("short future + long straddle (delta hedged): flat -200 points above the strike, 2(K-S)-200 below", () => {
    const legs = [fut("SELL", 25800), leg({ type: "CE", premium: 100 }), leg({ type: "PE", premium: 100 })];
    for (const s of [25800, 26000, 27000]) expect(expiryPnl(legs, s, LOT)).toBe(-200 * 65); // CE gains what the short future loses
    expect(expiryPnl(legs, 25500, LOT)).toBe((2 * 300 - 200) * 65); // 400 points
    const a = analyzeExpiry(legs, LOT);
    expect(a.profitUnlimited).toBe(false); expect(a.lossUnlimited).toBe(false); // above the strike the slope is +1 (call) -1 (future) = 0
    expect(a.maxLoss).toBe(-200 * 65);
    expect(a.maxProfit).toBe((2 * 25800 - 200) * 65); // at S = 0: both the put and the short future are at their best
    expect(a.breakevens).toEqual([25700]); // 2(K-S) = 200
    expect(a.kinks).toEqual([25800]); // a future adds no kink
  });

  it("a future alone: breakeven at its entry price, loss or profit unlimited by side", () => {
    const l = analyzeExpiry([fut("BUY", 25800)], LOT);
    expect(l.breakevens).toEqual([25800]); expect(l.profitUnlimited).toBe(true); expect(l.maxLoss).toBe(-25800 * 65);
    const s = analyzeExpiry([fut("SELL", 25800)], LOT);
    expect(s.breakevens).toEqual([25800]); expect(s.lossUnlimited).toBe(true); expect(s.maxProfit).toBe(25800 * 65);
  });

  it("the plotted curve never samples the strike 0 and matches the exact P&L", () => {
    const legs = [fut("SELL", 25800), leg({ type: "CE", premium: 100 }), leg({ type: "PE", premium: 100 })];
    const c = payoffCurve(legs, LOT, 25000, 26600, 100);
    expect(c.every((p) => p.s >= 25000)).toBe(true);
    expect(c.find((p) => p.s === 25800)!.pnl).toBe(-200 * 65);
    expect(c.find((p) => p.s === 25000)!.pnl).toBe((2 * 800 - 200) * 65);
  });

  it("a closed future keeps its booked P&L whatever the index does", () => {
    const closed = fut("BUY", 25800, { exitPrice: 25900, realised: 6500 });
    expect(expiryPnl([closed], 20000, LOT)).toBe(6500);
  });
});

describe("model value and Greeks of a future (carry 6 %, 30 days to expiry)", () => {
  const nowMs = expiryEnd(EXP) - 30 * 86_400_000;
  const v: Valuation = { spotNow: 25800, nowMs, rate: 0.06, carry: 0.06, ivShift: 0 };

  it("value = spot * e^(carry t): 25800 * 1.0049436867 = 25927.5471", () => {
    expect(futureValue(25800, EXP, nowMs, 0.06)).toBeCloseTo(25927.5471, 3);
    expect(futureValue(25800, EXP, expiryEnd(EXP) + 1, 0.06)).toBe(25800); // after expiry: the index itself
  });

  it("delta e^(ct) = 1.0049437, gamma 0, vega 0, theta = carry running off in one day = -4.2617", () => {
    const g = futureGreeks(25800, EXP, nowMs, 0.06)!;
    expect(g.delta).toBeCloseTo(1.0049437, 6);
    expect(g.gamma).toBe(0); expect(g.vegaPt).toBe(0);
    expect(g.thetaDay).toBeCloseTo(-4.2617, 3); // 25800 * (e^(0.06*29/365) - e^(0.06*30/365))
    expect(futureGreeks(25800, EXP, expiryEnd(EXP) + 1, 0.06)).toBeNull(); // expired
  });

  it("a position: short 1 lot = -65 * 1.0049437 = -65.3213 delta; a long lot is the opposite", () => {
    const sell = legGreeks(fut("SELL", 25800), LOT, v)!;
    expect(sell.delta).toBeCloseTo(-65 * 1.0049437, 3);
    expect(sell.gamma).toBe(0); expect(sell.vegaPt).toBe(0);
    expect(legGreeks(fut("BUY", 25800), LOT, v)!.delta).toBeCloseTo(65 * 1.0049437, 3);
  });

  it("the date curve: a long future entered at 25800 at spot 25800 today is worth (25927.5471-25800)*65 = 8290.6 now", () => {
    expect(theoreticalPnl([fut("BUY", 25800)], 25800, nowMs, LOT, v)).toBeCloseTo(127.5471 * 65, 2);
    // at expiry the same position is (S - entry) * 65
    expect(theoreticalPnl([fut("BUY", 25800)], 26000, expiryEnd(EXP), LOT, v)).toBeCloseTo(200 * 65, 6);
  });

  it("a live-price carry overrides the chain's: the model then passes through the market price of the future", () => {
    const f = 25950; // the future's own price at spot 25800
    const carry = Math.log(f / 25800) / (30 / 365);
    const own: Valuation = { ...v, futCarryByExpiry: { [EXP]: carry } };
    expect(futureValue(25800, EXP, nowMs, carry)).toBeCloseTo(f, 6);
    expect(theoreticalPnl([fut("BUY", f)], 25800, nowMs, LOT, own)).toBeCloseTo(0, 6); // entered at the market: nothing made yet
  });
});

describe("validation", () => {
  const ctx = { expiries: [EXP], strikesByExpiry: { [EXP]: [25800] }, today: "2026-11-23" };
  it("a future needs no strike and no listed strike", () => {
    expect(validateStrategy([fut("BUY", 25800)], ctx).filter((i) => i.level === "error")).toEqual([]);
  });
  it("an expired future asks for a roll; a future with a strike is wrong", () => {
    expect(validateStrategy([fut("BUY", 25800, { expiry: "2026-11-20" })], ctx).some((i) => i.field === "expiry" && /roll/i.test(i.message))).toBe(true);
    expect(validateStrategy([fut("BUY", 25800, { strike: 25800 })], ctx).some((i) => i.field === "strike")).toBe(true);
  });
});

describe("rolling a future into the next month", () => {
  it("books the old contract at its price and opens the new one at its own price, stop and target keep their distance", () => {
    const l = fut("BUY", 25800, { stop: 25542, target: 26058, key: "nse_fo|111" }); // 1 % each side
    const r = rollFutureLeg(l, "2026-12-29", "nse_fo|222", 25900, 25950, LOT, "2026-11-24T09:00:00.000Z");
    expect(r.realised).toBe((25900 - 25800) * 65); // 6 500 booked
    expect(r.premium).toBe(25950); expect(r.expiry).toBe("2026-12-29"); expect(r.key).toBe("nse_fo|222");
    expect(r.exitPrice == null).toBe(true);
    expect(r.stop).toBeCloseTo(25950 * (1 - 258 / 25800), 0); // 1 % below the new entry, to the tick
    expect(r.target).toBeCloseTo(25950 * (1 + 258 / 25800), 0);
  });
  it("a sold future books the opposite sign; a closed or non-future leg is left alone", () => {
    expect(rollFutureLeg(fut("SELL", 25800), "2026-12-29", "k", 25900, 25950, LOT, "t").realised).toBe(-6500);
    expect(rollFutureLeg(fut("BUY", 25800, { exitPrice: 25900 }), "2026-12-29", "k", 25900, 25950, LOT, "t").expiry).toBe(EXP);
    expect(rollFutureLeg(leg({}), "2026-12-29", "k", 1, 1, LOT, "t").expiry).toBe(EXP);
    expect(rollFutureLeg(fut("BUY", 25800), EXP, "k", 25900, 25950, LOT, "t").expiry).toBe(EXP); // not later: nothing to roll
  });
});

describe("contract helpers", () => {
  const c = (o: Partial<FutureContracts["current"]>) => ({ role: "current" as const, symbol: "NIFTY26NOVFUT", key: "nse_fo|111", expiry: EXP, ltp: 25820, as_of: "x", fresh: true, note: null, ...o });
  const all: FutureContracts = { current: c({}), next: { ...c({ role: "next" as never }), symbol: "NIFTY26DECFUT", key: "nse_fo|222", expiry: "2026-12-29", ltp: 25910 } as never };
  it("finds the contract by expiry and its price only while fresh", () => {
    expect(futurePrice(all, EXP)).toBe(25820); expect(futurePrice(all, "2026-12-29")).toBe(25910);
    expect(futureOf(all, "2027-01-26")).toBeNull();
    expect(futurePrice({ ...all, current: c({ fresh: false }) }, EXP)).toBeNull();
    expect(futurePrice({ ...all, current: c({ ltp: null }) }, EXP)).toBeNull();
  });
  it("a new future starts on the current month; a rolled one goes to a later expiry only", () => {
    expect(futureToAdd(all, "2026-11-23")?.symbol).toBe("NIFTY26NOVFUT");
    expect(futureToAdd(all, "2026-11-25")).toBeNull(); // the current contract has expired and the backend has not moved on yet
    expect(futureToRollInto(all, EXP)?.expiry).toBe("2026-12-29");
    expect(futureToRollInto(all, "2026-12-29")).toBeNull();
  });
});

describe("the Greeks & What-If page prices options only", () => {
  it("builder legs sent to the risk API leave the future out", () => {
    const out = legsFromBuilder([fut("SELL", 25800), leg({ type: "CE" })]);
    expect(out).toHaveLength(1); expect(out[0]!.type).toBe("CE");
  });
});
