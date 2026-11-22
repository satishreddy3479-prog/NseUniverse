// Smart OI divergence indicators, checked by hand on small series built for the purpose. Expected values are counted, not read back from the code.
import { describe, expect, it } from "vitest";
import {
  alignFuture, analyseSmartOi, buildStrikeFlow, candlesFor, collapseBursts, composeOf, ema, gradeOf, pressureOf, qualityOf, TH,
  type FutureLeg, type Reading, type Signal, type StrikeFlow,
} from "../lib/smartOiDivergence";
import type { SmartOiCandle, SmartOiResult } from "../lib/optionTools";
import type { FuturesSeries, StrikeSeries } from "../lib/types";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
interface C { high: number; low: number; close?: number; p?: number | null; csoi?: number; dPe?: number; dCe?: number; pcr?: number | null; volPcr?: number | null; ceV?: number | null; peV?: number | null; span?: number; strikesChanged?: boolean; proxy?: boolean; noSpot?: boolean }
const result = (tf: number, cs: C[], extra: Partial<SmartOiResult> = {}): SmartOiResult => ({
  day: "2026-11-20", timeframe: tf, baselineAt: null, gapCandles: 0, skippedSamples: 0, strikeChangeCandles: 0, stalls: [], thinBars: 0, unconfirmedBars: [], proxyMinutes: 0, indicativeMinutes: 0, jumps: [], ...extra,
  candles: cs.map((c, i) => ({
    slot: i, label: hhmm(555 + i * tf), spot: c.noSpot ? null : { open: c.close ?? c.high - 0.5, high: c.high, low: c.low, close: c.close ?? c.high - 0.5 }, spotFromBars: true, spotProxy: !!c.proxy,
    ceOi: 0, peOi: 0, dPe: c.dPe ?? 0, dCe: c.dCe ?? 0, p: c.p === undefined ? 0 : c.p, bullish: null, span: c.span ?? 1, peDay: 0, ceDay: 0, diffDay: c.csoi ?? 0,
    pcr: c.pcr === undefined ? 1 : c.pcr, volPcr: c.volPcr === undefined ? null : c.volPcr, ceVol: null, peVol: null, ceVolDelta: c.ceV === undefined ? null : c.ceV, peVolDelta: c.peV === undefined ? null : c.peV,
    fromPrevClose: false, strikesChanged: !!c.strikesChanged,
  }) as SmartOiCandle),
}) as SmartOiResult;
const only = (r: ReturnType<typeof analyseSmartOi>, id: string) => r.signals.filter((s) => s.id === id);

describe("windows", () => {
  it("30 minutes is 10 candles of 3 minutes or 6 of 5; a pivot needs 3 or 2 candles each side", () => {
    expect(candlesFor(3, TH.windowMin)).toBe(10); expect(candlesFor(5, TH.windowMin)).toBe(6);
    expect(TH.pivotK[3]).toBe(3); expect(TH.pivotK[5]).toBe(2);
  });
});

describe("1 flow divergence", () => {
  // highs 100,101,103,101,100,101,102,104,102,101: swings at index 2 (103) and 7 (104); cumulative Smart OI there 500 and 200
  const H = [100, 101, 103, 101, 100, 101, 102, 104, 102, 101];
  const CS = [0, 100, 500, 400, 300, 250, 220, 200, 150, 100];
  const build = (extraHigh: number[] = []) => result(5, [...H, ...extraHigh].map((h, i) => ({ high: h, low: h - 1, csoi: CS[i] ?? 100 })));

  it("regular bearish: higher high in price (+0.97 %), lower high in cumulative Smart OI (500 to 200), confirmed two candles after the second swing", () => {
    const s = only(analyseSmartOi(build()), "flow");
    expect(s).toHaveLength(1);
    expect(s[0]!).toMatchObject({ direction: "bearish", i: 9, state: "confirmed", link: { a: 2, b: 7, price: "high" } });
    expect(s[0]!.evidence.priceChange).toBeCloseTo(104 / 103 - 1, 12);
    expect(s[0]!.evidence.flowChange).toBe(-300);
    expect(s[0]!.strength).toBe(1); // 300 of a range of 500 is 0.6, and 0.5 is full strength
    expect(s[0]!.text).toContain("Regular bearish");
  });
  it("is failed once price goes beyond the second swing", () => {
    const s = only(analyseSmartOi(build([105])), "flow")[0]!;
    expect(s.state).toBe("failed"); expect(s.failedAt).toBe(10);
  });
  it("uses nothing after the candle it is confirmed on: cut at candle 8 there is no signal", () => {
    expect(only(analyseSmartOi(build(), { asOf: 8 }), "flow")).toHaveLength(0);
    expect(only(analyseSmartOi(build(), { asOf: 9 }), "flow")).toHaveLength(1);
  });
  it("regular bullish: lower low in price (-2.06 %), higher low in cumulative Smart OI (100 to 300)", () => {
    const L = [100, 99, 97, 99, 100, 99, 98, 95, 98, 99];
    const CB = [0, 50, 100, 120, 150, 200, 250, 300, 320, 330];
    const s = only(analyseSmartOi(result(5, L.map((l, i) => ({ high: l + 1, low: l, csoi: CB[i]! })))), "flow");
    expect(s).toHaveLength(1);
    expect(s[0]!).toMatchObject({ direction: "bullish", i: 9, link: { a: 2, b: 7, price: "low" } });
    expect(s[0]!.evidence.flowChange).toBe(200);
  });
  it("hidden bearish: lower high in price while cumulative Smart OI makes a higher one", () => {
    const Hh = [100, 101, 104, 101, 100, 101, 102, 103, 102, 101]; // swings 104 then 103
    const C2 = [0, 100, 200, 250, 260, 300, 350, 500, 450, 400]; // 200 then 500
    const s = only(analyseSmartOi(result(5, Hh.map((h, i) => ({ high: h, low: h - 1, csoi: C2[i]! })))), "flow");
    expect(s).toHaveLength(1); expect(s[0]!.direction).toBe("bearish"); expect(s[0]!.text).toContain("Hidden bearish");
  });
  it("needs a real price move and a real flow move: 0.02 % in price, or a flow change under a tenth of the range, gives nothing", () => {
    const flat = [100, 101, 103, 101, 100, 101, 102, 103.01, 102, 101];
    expect(only(analyseSmartOi(result(5, flat.map((h, i) => ({ high: h, low: h - 1, csoi: CS[i]! })))), "flow")).toHaveLength(0);
    const small = [0, 100, 500, 400, 300, 250, 220, 480, 150, 100];
    expect(only(analyseSmartOi(result(5, H.map((h, i) => ({ high: h, low: h - 1, csoi: small[i]! })))), "flow")).toHaveLength(0); // 500 to 480 is 20 of a range of 500
  });
  it("a missing high leaves the swing unconfirmed instead of guessing", () => {
    const cs = H.map((h, i) => ({ high: h, low: h - 1, csoi: CS[i]!, noSpot: i === 8 }));
    expect(only(analyseSmartOi(result(5, cs)), "flow")).toHaveLength(0); // the right-hand candle of the second swing has no price
  });
});

describe("2 writing or buying", () => {
  const sf = (o: Partial<StrikeFlow>): StrikeFlow => ({ put: { writing: 0, buying: 0, covering: 0, unwinding: 0 }, call: { writing: 0, buying: 0, covering: 0, unwinding: 0 }, unclassified: 0, supportDelta: 0, resistDelta: 0, supportStrike: null, resistStrike: null, strikes: 4, ...o });
  it("pressure: put writing 100 + call buying 50 - call writing 30 over 180 classified, 20 unclassified = bias 0.6667, share 0.9", () => {
    const p = pressureOf(sf({ put: { writing: 100, buying: 0, covering: 0, unwinding: 0 }, call: { writing: 30, buying: 50, covering: 0, unwinding: 0 }, unclassified: 20 }));
    expect(p.classified).toBe(180); expect(p.bias).toBeCloseTo(120 / 180, 12); expect(p.share).toBeCloseTo(0.9, 12);
  });
  it("covering and unwinding take the opposite side of writing and buying: put covering is bearish, call covering bullish", () => {
    expect(pressureOf(sf({ put: { writing: 0, buying: 0, covering: 100, unwinding: 0 } })).bias).toBe(-1);
    expect(pressureOf(sf({ call: { writing: 0, buying: 0, covering: 100, unwinding: 0 } })).bias).toBe(1);
    expect(pressureOf(sf({ put: { writing: 0, buying: 0, covering: 0, unwinding: 100 } })).bias).toBe(1);
    expect(pressureOf(sf({ call: { writing: 0, buying: 0, covering: 0, unwinding: 100 } })).bias).toBe(-1);
  });
  it("raised when the label says bullish but the money is bearish, for two candles in a row (not after one)", () => {
    const cs = Array.from({ length: 6 }, (_, i) => ({ high: 100 + i, low: 99 + i, p: 1000 }));
    const bad = sf({ put: { writing: 0, buying: 600, covering: 0, unwinding: 0 }, call: { writing: 500, buying: 0, covering: 0, unwinding: 0 } });
    const good = sf({ put: { writing: 600, buying: 0, covering: 0, unwinding: 0 } });
    const r = analyseSmartOi(result(5, cs), { strikeFlow: [null, good, bad, bad, good, good] });
    const s = only(r, "writing");
    expect(s).toHaveLength(1);
    expect(s[0]!).toMatchObject({ i: 3, direction: "bearish", strength: 1 }); // candle 2 is the first conflict, candle 3 the second
    expect(only(analyseSmartOi(result(5, cs), { strikeFlow: [null, good, bad, good, bad, good] }), "writing")).toHaveLength(0);
  });
  it("is silent when too little of the change could be classified", () => {
    const cs = Array.from({ length: 4 }, (_, i) => ({ high: 100 + i, low: 99 + i, p: 1000 }));
    const murky = sf({ put: { writing: 0, buying: 100, covering: 0, unwinding: 0 }, unclassified: 900 }); // 10 % classified
    expect(only(analyseSmartOi(result(5, cs), { strikeFlow: [null, murky, murky, murky] }), "writing")).toHaveLength(0);
  });

  it("classifies from premiums: put OI +500 with the premium down is writing, call OI -200 with the premium up is covering", () => {
    const times = ["2026-11-20T03:45:00Z", "2026-11-20T03:46:00Z", "2026-11-20T03:48:00Z"]; // 09:15, 09:16 (same 3-minute candle), 09:18
    const ss = {
      underlying: "NIFTY", expiry: "2026-11-24", strikes: [25800], atm_strike: 25800, times, spot: [25800, 25800, 25800],
      ce_price: { "25800": [80, 80, 90] }, pe_price: { "25800": [100, 100, 90] },
      ce_oi: { "25800": [2000, 2000, 1800] }, pe_oi: { "25800": [1000, 1000, 1500] }, ce_change: {}, pe_change: {},
    } as unknown as StrikeSeries;
    const res = result(3, [{ high: 25801, low: 25799 }, { high: 25801, low: 25799 }]);
    const out = buildStrikeFlow(res, ss, 555);
    expect(out[0]).toBeNull(); // the first candle has no earlier candle
    const x = out[1]!;
    expect(x.put.writing).toBe(500); expect(x.call.covering).toBe(200);
    expect(x.put.buying + x.put.covering + x.put.unwinding + x.call.writing + x.call.buying + x.call.unwinding).toBe(0);
    expect(x.unclassified).toBe(0);
    expect(x.supportDelta).toBe(500); expect(x.resistDelta).toBe(-200); // the strike equals spot: it counts on both sides
    expect(x.supportStrike).toBe(25800); expect(x.resistStrike).toBeNull(); // no call OI was added
  });
  it("an index move explains a premium move: a call premium up by exactly delta x the move is not buying", () => {
    const times = ["2026-11-20T03:45:00Z", "2026-11-20T03:48:00Z"];
    const mk = (spot1: number, ce1: number) => ({
      underlying: "NIFTY", expiry: "2026-11-24", strikes: [25800], atm_strike: 25800, times, spot: [25800, spot1],
      ce_price: { "25800": [100, ce1] }, pe_price: { "25800": [null, null] }, ce_oi: { "25800": [1000, 1500] }, pe_oi: { "25800": [null, null] }, ce_change: {}, pe_change: {},
    }) as unknown as StrikeSeries;
    const res = result(3, [{ high: 1, low: 1 }, { high: 1, low: 1 }]);
    // spot +50 raises an at-the-money call by about half of that; a rise of 25 is the move, not buying: classified as nothing
    const moved = buildStrikeFlow(res, mk(25850, 125), 555)[1]!;
    expect(moved.call.buying + moved.call.writing).toBeLessThanOrEqual(500);
    const flat = buildStrikeFlow(res, mk(25800, 112), 555)[1]!; // the index did not move but the premium rose 12: buying
    expect(flat.call.buying).toBe(500);
    const down = buildStrikeFlow(res, mk(25800, 90), 555)[1]!;
    expect(down.call.writing).toBe(500);
  });
});

describe("3 conviction", () => {
  const base = (lowConv: boolean, flat = false) => Array.from({ length: 20 }, (_, i) => {
    const late = i >= 12;
    const d = late ? (lowConv ? 50 : 600) : 300;
    const vol = late && lowConv ? 700 : 500;
    return { high: 100 + (flat ? 0 : 0.05 * i) + 0.1, low: 100 + (flat ? 0 : 0.05 * i) - 0.1, close: 100 + (flat ? 0 : 0.05 * i), dPe: d, dCe: d, ceV: vol, peV: vol };
  });
  it("a rally of 0.3 % on a sixth of the usual new OI per contract is a move on churn: bearish, convRatio 0.0714 / 0.6", () => {
    const s = only(analyseSmartOi(result(5, base(true))), "conviction");
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.i >= 12)).toBe(true); // nothing in the steady part
    const last = s.find((x) => x.i === 17)!;
    expect(last.direction).toBe("bearish");
    expect(last.evidence.convRatio as number).toBeCloseTo((100 / 1400) / 0.6, 6);
    expect(last.evidence.move as number).toBeCloseTo(100.85 / 100.55 - 1, 9);
  });
  it("absorption: positions built at twice the usual rate with price standing still is neutral", () => {
    const s = only(analyseSmartOi(result(5, base(false, true))), "conviction");
    expect(s.length).toBeGreaterThan(0); expect(s.every((x) => x.direction === "neutral")).toBe(true);
    // the first signal comes when three of the six candles of the window are the busy ones: (3 x 0.6 + 3 x 1.2 + 0 ... ) / 6 = 0.9 = 1.5 times the median 0.6
    expect(s[0]!.evidence.convRatio as number).toBeCloseTo(0.9 / 0.6, 6);
    expect(s.find((x) => x.i === 17)!.evidence.convRatio as number).toBeCloseTo(1200 / 1000 / 0.6, 6); // a full window of the busy candles: twice the median
  });
  it("needs eight candles of history and ignores candles without volume", () => {
    const short = Array.from({ length: 7 }, (_, i) => ({ high: 100 + i, low: 99 + i, dPe: 50, dCe: 50, ceV: 700, peV: 700 }));
    expect(only(analyseSmartOi(result(5, short)), "conviction")).toHaveLength(0);
    const none = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i * 0.05, low: 99.8 + i * 0.05, dPe: 50, dCe: 50 }));
    expect(only(analyseSmartOi(result(5, none)), "conviction")).toHaveLength(0); // volume not stored: no reading, not a zero
  });
});

describe("4 PCR divergence", () => {
  it("OI PCR up 0.12 while volume PCR down 0.12 over 30 minutes: positions held lead, bullish, full strength", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ high: 100, low: 99, pcr: 1 + 0.02 * i, volPcr: 0.9 - 0.02 * i }));
    const s = only(analyseSmartOi(result(5, cs)), "pcr");
    expect(s[0]!).toMatchObject({ i: 6, direction: "bullish", strength: 1 });
    expect(s[0]!.evidence.oiPcrChange as number).toBeCloseTo(0.12, 12);
    expect(s[0]!.evidence.volPcrChange as number).toBeCloseTo(-0.12, 12);
  });
  it("price down 0.3 % while OI PCR rises 0.12: put support is building against the move", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ high: 100.1 - 0.05 * i, low: 99.9 - 0.05 * i, close: 100 - 0.05 * i, pcr: 1 + 0.02 * i }));
    const s = only(analyseSmartOi(result(5, cs)), "pcr")[0]!;
    expect(s.direction).toBe("bullish"); expect(s.text).toContain("put support is building against the move");
  });
  it("small changes, or a missing volume PCR, give nothing", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ high: 100, low: 99, pcr: 1 + 0.002 * i, volPcr: 0.9 - 0.002 * i }));
    expect(only(analyseSmartOi(result(5, cs)), "pcr")).toHaveLength(0);
    const nov = Array.from({ length: 12 }, (_, i) => ({ high: 100, low: 99, pcr: 1 + 0.02 * i }));
    expect(only(analyseSmartOi(result(5, nov)), "pcr")).toHaveLength(0); // price flat, volume PCR missing
  });
});

describe("5 future against options", () => {
  const n = 12;
  const cs = Array.from({ length: n }, () => ({ high: 100, low: 99, p: -100 }));
  const fl: FutureLeg[] = Array.from({ length: n }, (_, i) => ({ price: 25000 * (1 + 0.0004 * i), oi: 1e6 * (1 + 0.002 * i), basis: 10 + i }));
  it("future long build-up (+0.24 %, OI +1.2 %) while Smart OI leans bearish over the same 30 minutes: bullish future, strength 0.9", () => {
    const s = only(analyseSmartOi(result(5, cs), { future: fl }), "future");
    expect(s[0]!).toMatchObject({ i: 6, direction: "bullish" });
    expect(s[0]!.strength).toBeCloseTo(0.5 * 1 + 0.5 * (0.0024 / 0.003), 9);
    expect(s[0]!.evidence.basisChange).toBe(6);
  });
  it("silent when both agree, when the future barely moved, or when it is missing", () => {
    expect(only(analyseSmartOi(result(5, cs.map((c) => ({ ...c, p: 100 }))), { future: fl }), "future")).toHaveLength(0);
    expect(only(analyseSmartOi(result(5, cs), { future: fl.map((x, i) => ({ ...x, price: 25000 + i })) }), "future")).toHaveLength(0);
    const r = analyseSmartOi(result(5, cs), { future: fl.map(() => ({ price: null, oi: null, basis: null })) });
    expect(only(r, "future")).toHaveLength(0); expect(r.missing.future).toBe(true);
  });
  it("short build-up, short covering and long unwinding are named from the signs of price and OI", () => {
    const down = fl.map((x, i) => ({ ...x, price: 25000 * (1 - 0.0004 * i) }));
    const pos = cs.map((c) => ({ ...c, p: 100 }));
    expect(only(analyseSmartOi(result(5, pos), { future: down }), "future")[0]!.direction).toBe("bearish"); // short build-up
    const sc = down.map((x, i) => ({ ...x, oi: 1e6 * (1 - 0.002 * i) }));
    expect(only(analyseSmartOi(result(5, cs), { future: sc }), "future")).toHaveLength(0); // long unwinding is bearish, options already bearish
    const cover = fl.map((x, i) => ({ ...x, oi: 1e6 * (1 - 0.002 * i) }));
    expect(only(analyseSmartOi(result(5, cs), { future: cover }), "future")[0]!.text).toContain("short covering");
  });
  it("aligns the future to the end of each candle, and not across a long silence", () => {
    const res = result(3, [{ high: 1, low: 1 }, { high: 1, low: 1 }]);
    const fut = { times: ["2026-11-20T03:47:30Z", "2026-11-20T03:49:00Z", "2026-11-20T03:55:00Z"], future: [100, 101, 102], oi: [10, 11, 12], basis: [1, 2, 3] } as unknown as FuturesSeries;
    const a = alignFuture(res, fut);
    expect(a[0]).toEqual({ price: 100, oi: 10, basis: 1 }); // 09:15 candle ends 09:18 = 03:48Z: the 03:47:30 value
    expect(a[1]).toEqual({ price: 101, oi: 11, basis: 2 }); // 09:18 candle ends 09:21 = 03:51Z: the 03:49 value
    expect(alignFuture(res, undefined)[0]).toEqual({ price: null, oi: null, basis: null });
  });
});

describe("6 zone divergence", () => {
  const sf = (support: number, resist: number): StrikeFlow => ({ put: { writing: 0, buying: 0, covering: 0, unwinding: 0 }, call: { writing: 0, buying: 0, covering: 0, unwinding: 0 }, unclassified: 0, supportDelta: support, resistDelta: resist, supportStrike: 25700, resistStrike: 25900, strikes: 2 });
  const up = Array.from({ length: 10 }, (_, i) => ({ high: 100.1 + 0.05 * i, low: 99.9 + 0.05 * i, close: 100 + 0.05 * i }));
  it("price +0.3 % into a ceiling: call OI above grew 3000 against 300 of put OI below: bearish, balance (300-3000)/3300", () => {
    const r = analyseSmartOi(result(5, up), { strikeFlow: up.map(() => sf(50, 500)) });
    const s = only(r, "zone")[0]!;
    expect(s.direction).toBe("bearish");
    expect(s.evidence.zoneBalance as number).toBeCloseTo((300 - 3000) / 3300, 12); expect(s.strength).toBeCloseTo(2700 / 3300, 12);
    expect(s.text).toContain("25,900".replace(",", "")); // names the strike where the most call OI was added
  });
  it("price -0.3 % onto a floor: bullish; a balanced book gives nothing", () => {
    const down = up.map((_c, i) => ({ high: 100.1 - 0.05 * i, low: 99.9 - 0.05 * i, close: 100 - 0.05 * i }));
    expect(only(analyseSmartOi(result(5, down), { strikeFlow: down.map(() => sf(500, 50)) }), "zone")[0]!.direction).toBe("bullish");
    expect(only(analyseSmartOi(result(5, up), { strikeFlow: up.map(() => sf(300, 300)) }), "zone")).toHaveLength(0);
  });
  it("is silent without the per-strike series, and says so", () => {
    const r = analyseSmartOi(result(5, up));
    expect(only(r, "zone")).toHaveLength(0); expect(r.missing.strikes).toBe(true);
    expect(r.readings.find((x) => x.id === "zone")!.text).toBe("No stored per-strike series.");
  });
});

describe("7 momentum divergence", () => {
  it("ema with span 5: 3, 6, 9 gives 3, 4, 5.6667 (alpha 1/3)", () => {
    const e = ema([3, 6, 9], 5);
    expect(e[0]).toBe(3); expect(e[1]).toBeCloseTo(4, 12); expect(e[2]).toBeCloseTo(17 / 3, 12);
    expect(ema([3, null, 9], 5)[1]).toBe(3); // a missing value carries the average, it does not move it
  });
  const alt = [100, -100, 100, -100, 100, -100, 100, -100, 100, -100];
  it("price +0.3 % over 30 minutes while smoothed Smart OI falls: bearish", () => {
    const p = [...alt, 100, 50, 0, -50, -100, -150, -200, -250];
    const cs = p.map((v, i) => ({ high: 100 + 0.05 * i + 0.1, low: 100 + 0.05 * i - 0.1, close: 100 + 0.05 * i, p: v }));
    const s = only(analyseSmartOi(result(5, cs)), "momentum").filter((x) => x.direction === "bearish" && x.text.includes("fading"));
    expect(s.length).toBeGreaterThan(0);
    expect((s[0]!.evidence.slope as number)).toBeLessThanOrEqual(-TH.momSlope);
  });
  it("an unusual reading is flagged once, with its robust z-score: 1000 against a median of 0 and a scale of 148.26 is 6.7", () => {
    const p = [...alt, 1000, 100, -100];
    const cs = p.map((v) => ({ high: 100, low: 99, close: 100, p: v }));
    const s = only(analyseSmartOi(result(5, cs)), "momentum").filter((x) => x.text.startsWith("Unusual"));
    expect(s).toHaveLength(1);
    expect(s[0]!.evidence.z as number).toBeCloseTo(1000 / (1.4826 * 100), 2); expect(s[0]!.direction).toBe("bullish");
  });
  it("is silent while the day has fewer than ten readings", () => {
    const cs = alt.slice(0, 8).map((v, i) => ({ high: 100 + i, low: 99 + i, p: v * (i === 7 ? 50 : 1) }));
    expect(only(analyseSmartOi(result(5, cs)), "momentum")).toHaveLength(0);
  });
});

describe("8 composite and quality", () => {
  const rd = (id: Reading["id"], direction: Reading["direction"], active = true): Reading => ({ id, active, direction, strength: 0.5, at: "09:15", text: "" });
  it("a direction needs three agreeing and a lead of two", () => {
    // an inactive reading counts for nothing: 3 bearish against 1 bullish is a lead of two
    expect(composeOf([rd("flow", "bearish"), rd("zone", "bearish"), rd("pcr", "bearish"), rd("future", "bullish"), rd("writing", "bullish", false)], "A")).toMatchObject({ direction: "bearish", bearish: 3, bullish: 1, agree: 3, text: "3 of 5 indicators agree bearish." });
  });
  it("3 against 1 is bearish, 3 against 2 is mixed, 2 alone is mixed, none says none", () => {
    expect(composeOf([rd("flow", "bearish"), rd("zone", "bearish"), rd("pcr", "bearish"), rd("future", "bullish")], "A").direction).toBe("bearish");
    expect(composeOf([rd("flow", "bearish"), rd("zone", "bearish"), rd("pcr", "bearish"), rd("future", "bullish"), rd("momentum", "bullish")], "A").direction).toBe("neutral");
    const two = composeOf([rd("flow", "bullish"), rd("zone", "bullish")], "A");
    expect(two.direction).toBe("neutral"); expect(two.text).toBe("Mixed: 2 bullish and 0 bearish divergences active.");
    expect(composeOf([rd("flow", "bullish", false)], "A").text).toBe("No divergence is active.");
  });
  it("evidence grade: A with clean candles, B with one or two flagged, C with three or a stalled index feed", () => {
    const clean = Array.from({ length: 10 }, () => ({ gap: false, strikes: false, proxy: false, noSpot: false }));
    expect(gradeOf(clean, 9, 6, false)).toBe("A");
    const one = clean.map((x, i) => (i === 8 ? { ...x, gap: true } : x));
    expect(gradeOf(one, 9, 6, false)).toBe("B");
    const three = clean.map((x, i) => (i >= 6 && i <= 8 ? { ...x, strikes: true } : x));
    expect(gradeOf(three, 9, 6, false)).toBe("C");
    expect(gradeOf(clean, 9, 6, true)).toBe("C");
    expect(gradeOf(one, 9, 6, false)).toBe("B"); expect(gradeOf(one, 2, 6, false)).toBe("A"); // the flagged candle is outside an earlier window
  });
  it("quality flags come from the candles: a gap, a changed strike count, a proxy minute, no price", () => {
    const q = qualityOf(result(5, [{ high: 1, low: 1 }, { high: 1, low: 1, span: 2 }, { high: 1, low: 1, strikesChanged: true }, { high: 1, low: 1, proxy: true }, { high: 1, low: 1, noSpot: true }]));
    expect(q.map((x) => [x.gap, x.strikes, x.proxy, x.noSpot])).toEqual([[false, false, false, false], [true, false, false, false], [false, true, false, false], [false, false, true, false], [false, false, false, true]]);
  });
  it("the report keeps a signal for a window of candles, then it is no longer active", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ high: 100, low: 99, pcr: 1 + 0.02 * i, volPcr: 0.9 - 0.02 * i }));
    const r = analyseSmartOi(result(5, cs));
    expect(r.readings.find((x) => x.id === "pcr")!.active).toBe(true);
    const calm = [...cs, ...Array.from({ length: 14 }, () => ({ high: 100, low: 99, pcr: 1.22, volPcr: 0.68 }))];
    expect(analyseSmartOi(result(5, calm)).readings.find((x) => x.id === "pcr")!.active).toBe(false); // flat for a full window since
  });
});

describe("collapseBursts: one marker for a run of the same signal", () => {
  const sig = (id: Signal["id"], i: number, direction: Signal["direction"], strength = 0.5): Signal => ({ id, i, at: `09:${String(15 + i).padStart(2, "0")}`, direction, strength, state: "confirmed", title: "", text: "", evidence: {} });
  it("signals of one indicator and direction within 3 candles of each other are one burst: its start, its length, its last candle, its strongest reading", () => {
    const b = collapseBursts([sig("momentum", 10, "bullish", 0.2), sig("momentum", 11, "bullish", 0.7), sig("momentum", 13, "bullish", 0.4), sig("momentum", 20, "bullish", 0.3)]);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ i: 10, count: 3, lastI: 13, strength: 0.7 });
    expect(b[1]).toMatchObject({ i: 20, count: 1, lastI: 20 }); // 7 candles later: a new burst
  });
  it("different indicators, or different directions, never merge", () => {
    const b = collapseBursts([sig("momentum", 10, "bullish"), sig("momentum", 11, "bearish"), sig("pcr", 11, "bullish")]);
    expect(b).toHaveLength(3);
    expect(collapseBursts([])).toEqual([]);
  });
  it("a gap of exactly 3 candles still joins, 4 does not", () => {
    expect(collapseBursts([sig("zone", 5, "bearish"), sig("zone", 8, "bearish")])).toHaveLength(1);
    expect(collapseBursts([sig("zone", 5, "bearish"), sig("zone", 9, "bearish")])).toHaveLength(2);
  });
  it("the report itself keeps every signal: collapsing is for drawing only", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ high: 100, low: 99, pcr: 1 + 0.02 * i, volPcr: 0.9 - 0.02 * i }));
    const r = analyseSmartOi(result(5, cs));
    expect(r.signals.length).toBeGreaterThan(collapseBursts(r.signals).length);
  });
});
