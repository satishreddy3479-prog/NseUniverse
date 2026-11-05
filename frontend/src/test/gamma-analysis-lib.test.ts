// Gamma exposure calculations, checked by hand. Prices are generated with Black-76 (formula checks, not market data).
import { describe, expect, it } from "vitest";
import { black76, expiryEnd } from "../lib/optionModel";
import {
  corridor, fmtCrore, gammaDensity, gammaFlip, gexLevels, gexProfile, gexStructure, netGexAt, regimeFor, strikeType, type GexProfile, type GexRow, type GexSample,
} from "../lib/gammaAnalysis";
import type { OptionChainRow } from "../lib/types";

const EXPIRY = "2026-11-24";
const YEAR = 365 * 86_400_000;
const AT = expiryEnd(EXPIRY) - 0.1 * YEAR; // 0.1 year to expiry
const q = (ltp: number | null, oi: number | null) => ({ ltp, oi }) as never;
const row = (strike: number, ceOi: number | null, peOi: number | null, sigma = 0.2, spot = 24000): OptionChainRow =>
  ({ strike, call: q(black76("CE", spot, strike, 0.1, sigma, 0), ceOi), put: q(black76("PE", spot, strike, 0.1, sigma, 0), peOi) }) as OptionChainRow;

describe("gexProfile", () => {
  it("is gamma x OI x spot^2 x 1% in rupees crore, calls positive and puts negative", () => {
    // at the money, 20% volatility, 0.1 year, no carry: d1 = 0.5 x 0.2 x sqrt(0.1) = 0.031623; phi(d1) = 0.39874;
    // gamma = phi / (S sigma sqrt(t)) = 0.39874 / (24000 x 0.2 x 0.316228) = 2.6269e-4
    // GEX = 2.6269e-4 x 1 000 000 x 24000^2 x 0.01 / 1e7 = 151.31 crore
    const p = gexProfile([row(24000, 1_000_000, 1_000_000)], 24000, EXPIRY, AT, 0);
    const r = p.rows[0]!;
    expect(r.ceGamma).toBeCloseTo(2.6269e-4, 7);
    expect(r.ce).toBeCloseTo(151.31, 0);
    expect(r.pe).toBeCloseTo(-151.31, 0); // put gamma equals call gamma at the same strike
    expect(Math.abs(r.net!)).toBeLessThan(0.5); // equal OI cancels
    expect(r.abs).toBeCloseTo(302.6, 0);
  });
  it("leaves a side without a price or OI out instead of counting it as zero", () => {
    const rows = [row(24000, 1_000_000, null), { strike: 24100, call: q(null, 500_000), put: q(null, 500_000) } as OptionChainRow];
    const p = gexProfile(rows, 24000, EXPIRY, AT, 0);
    expect(p.rows[0]!.ce).not.toBeNull();
    expect(p.rows[0]!.pe).toBeNull();
    expect(p.rows[0]!.net).toBeNull(); // not a half sum
    expect(p.rows[1]!.ce).toBeNull();
    expect(gexLevels(p, 5, false).netTotal).toBeNull(); // nothing usable
  });
});

const lit = (rows: Partial<GexRow>[], spot: number): GexProfile => ({
  rows: rows.map((r) => ({ ceOi: null, peOi: null, ceIv: null, peIv: null, ceGamma: null, peGamma: null, ce: null, pe: null, net: null, abs: null, ...r }) as GexRow),
  spot, expiry: EXPIRY, at: AT, rate: 0, carry: 0, forward: spot, skipped: 0,
});
const lr = (strike: number, ce: number, pe: number): Partial<GexRow> => ({ strike, ce, pe, net: ce + pe, abs: ce - pe });

describe("levels", () => {
  // spot 24 050; call GEX / put GEX per strike: 23900 (1, -6), 24000 (3, -4), 24100 (5, -2), 24200 (8, -1), 24300 (2, -1)
  const p = lit([lr(23900, 1, -6), lr(24000, 3, -4), lr(24100, 5, -2), lr(24200, 8, -1), lr(24300, 2, -1)], 24050);
  it("finds the walls beyond spot, the peak anywhere and the totals", () => {
    const l = gexLevels(p, 1, false);
    expect(l.callWall).toBe(24200); // largest call GEX at or above spot: 24100 (5), 24200 (8), 24300 (2)
    expect(l.putWall).toBe(23900); // largest put GEX at or below spot: 23900 (6), 24000 (4)
    expect(l.peak).toBe(24200); // absolute GEX: 7, 7, 7, 9, 3
    expect(l.netTotal).toBe(5); // (1-6) + (3-4) + (5-2) + (8-1) + (2-1) = -5 -1 +3 +7 +1
    expect(l.atmStrike).toBe(24000); // 24 000 and 24 100 are equally near: the lower one
    expect(l.nearNet).toBe(-3); // the ATM strike and one either side: -5 -1 +3
  });
  it("names each strike by what it is", () => {
    const l = gexLevels(p, 1, false);
    expect(p.rows.map((r) => strikeType(r, l))).toEqual(["Put wall", "−GEX", "+GEX", "Call wall", "+GEX"]);
  });
});

describe("gamma flip", () => {
  it("is where re-priced net GEX crosses zero: puts below and calls above in equal size cross at the middle", () => {
    // 1 M puts at 23 900 and 1 M calls at 24 100, 20% volatility, 0.1 year. Their GEX is equal where |d1| is equal:
    // ln(S/23900) + h = -(ln(S/24100) + h) with h = 0.5 x 0.2^2 x 0.1 = 0.002, so S = sqrt(23900 x 24100) x e^-0.002 = 23 951.1
    // (negative below it, where the puts' gamma is larger; positive above)
    const p = gexProfile([
      { strike: 23900, call: q(null, null), put: q(black76("PE", 24000, 23900, 0.1, 0.2, 0), 1_000_000) },
      { strike: 24100, call: q(black76("CE", 24000, 24100, 0.1, 0.2, 0), 1_000_000), put: q(null, null) },
    ] as OptionChainRow[], 24000, EXPIRY, AT, 0);
    const flip = gammaFlip(p)!;
    expect(Math.abs(flip - 23951.1)).toBeLessThan(2);
    expect(Math.abs(netGexAt(p, flip)!)).toBeLessThan(Math.abs(netGexAt(p, 23950)!) * 0.1); // zero to within the interpolation
    expect(netGexAt(p, 23950)!).toBeLessThan(0);
    expect(netGexAt(p, 24050)!).toBeGreaterThan(0);
  });
  it("is null when the aggregate keeps one sign across the range", () => {
    const p = gexProfile([{ strike: 24000, call: q(black76("CE", 24000, 24000, 0.1, 0.2, 0), 1_000_000), put: q(black76("PE", 24000, 24000, 0.1, 0.2, 0), 1) }] as OptionChainRow[], 24000, EXPIRY, AT, 0);
    expect(gammaFlip(p)).toBeNull();
  });
});

describe("regime and corridor", () => {
  const lv = (over: Partial<ReturnType<typeof gexLevels>>) => ({ spot: 24500, netTotal: 5, absTotal: 10, strikesUsed: 5, peak: 24500, callWall: 24600, putWall: 24400, flip: 24420, atmStrike: 24500, atmNet: 1, nearNet: 2, ...over });
  it("follows the sign of the aggregate, and is unstable within 0.2% of the flip", () => {
    expect(regimeFor(lv({}))).toMatchObject({ name: "Positive Gamma", volatility: "LOW VOL" });
    expect(regimeFor(lv({ netTotal: -5 }))).toMatchObject({ name: "Negative Gamma", volatility: "HIGH VOL" });
    expect(regimeFor(lv({ flip: 24480 }))).toMatchObject({ name: "Near the gamma flip", volatility: "UNSTABLE" }); // 20 points = 0.08%
    expect(regimeFor(lv({ flip: 24420 }))!.name).toBe("Positive Gamma"); // 80 points = 0.33%
    expect(regimeFor(lv({ netTotal: null }))).toBeNull();
  });
  it("brackets spot with the nearest level on each side", () => {
    expect(corridor(24500, [24400, 24600, 24500, 24420, 24450])).toEqual({ lower: 24500, upper: 24600, widthPct: (100 / 24500) * 100 });
    expect(corridor(24500, [null, 24600])).toEqual({ lower: null, upper: 24600, widthPct: null });
  });
});

describe("gamma density", () => {
  it("peaks near the strikes with exposure and crosses between a call strike and a put strike", () => {
    const rows = [lr(24000, 10, 0), lr(24050, 0, 0), lr(24100, 0, -10), lr(24150, 0, 0), lr(23950, 0, 0)].map((r) => ({ ...r, ceOi: 1, peOi: 1 }));
    const d = gammaDensity(lit(rows, 24050).rows)!;
    expect(Math.abs(d.sellPeak! - 24000)).toBeLessThan(15);
    expect(Math.abs(d.buyPeak! - 24100)).toBeLessThan(15);
    expect(d.sellBuy).toHaveLength(1);
    expect(d.sellBuy[0]).toBeCloseTo(24050, 0); // the two curves are mirror images about 24 050
    expect(gammaDensity(lit([lr(24000, 1, -1)], 24000).rows)).toBeNull(); // too few strikes
    const wide = gammaDensity(lit(rows, 24050).rows, 2)!;
    expect(Math.max(...wide.neutral)).toBeLessThan(Math.max(...d.neutral)); // a wider kernel flattens the peak
  });
});

describe("structure through the session and formatting", () => {
  it("gives net GEX, the levels and the change per minute at each sample", () => {
    const sample = (min: number, net: number, spot: number): GexSample => ({
      t: Date.parse("2026-11-05T03:45:00Z") + min * 60_000, day: "2026-11-05",
      profile: lit([lr(24000, 1, -1 + net), lr(24100, 2, -1)], spot),
    });
    const s = gexStructure([sample(0, 0, 24050), sample(5, 5, 24060), sample(10, 0, 24040)]);
    expect(s.map((x) => x.net)).toEqual([1, 6, 1]); // (1-1) + (2-1) = 1 ; with net 5: (1+4) + 1 = 6
    expect(s[0]!.roc).toBeNull();
    expect(s[1]!.roc).toBe(1); // +5 over 5 minutes
    expect(s[2]!.roc).toBe(-1);
  });
  it("shows thousands of crore with K", () => {
    expect(fmtCrore(5382.86)).toBe("5.38K");
    expect(fmtCrore(-2080)).toBe("−2.08K");
    expect(fmtCrore(151.31)).toBe("151");
    expect(fmtCrore(12.345)).toBe("12.35");
    expect(fmtCrore(null)).toBe("—");
  });
});
