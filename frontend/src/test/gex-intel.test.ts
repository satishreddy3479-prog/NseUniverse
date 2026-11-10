// GEX universes, sign scenarios, intraday dynamics and the divergence reading, checked by hand. Prices come from Black-76 (formula checks, not market data).
import { describe, expect, it } from "vitest";
import { black76, expiryEnd } from "../lib/optionModel";
import { gexSamples, nearestStrikes, type GexProfile, type GexRow, type StructurePoint } from "../lib/gammaAnalysis";
import { flipTime, gexDynamics, gexPriceDivergence, gexUniverses, migration, scenarioNet, SIGN_SCENARIOS } from "../lib/gexIntel";
import type { OptionChainRow, StrikeSeries } from "../lib/types";

const EXPIRY = "2026-11-24";
const YEAR = 365 * 86_400_000;
const AT = expiryEnd(EXPIRY) - 0.1 * YEAR;
const q = (ltp: number | null, oi: number | null) => ({ ltp, oi }) as never;
const row = (strike: number, ceOi: number | null, peOi: number | null): OptionChainRow =>
  ({ strike, call: q(black76("CE", 24000, strike, 0.1, 0.2, 0), ceOi), put: q(black76("PE", 24000, strike, 0.1, 0.2, 0), peOi) }) as OptionChainRow;
const chain = [23500, 23600, 23700, 23800, 23900, 24000, 24100, 24200, 24300, 24400, 24500].map((k) => row(k, 1_000_000, 1_500_000));

describe("three universes", () => {
  it("count strikes, keep the same chain and rules, and leave an unbuildable universe out", () => {
    const u = gexUniverses(chain, 24000, EXPIRY, AT, 24200, 2);
    expect(u.map((x) => x.id)).toEqual(["fixed", "dynamic", "full"]);
    const [fixed, dyn, full] = u;
    expect(fixed!.strikes).toEqual([24000, 24100, 24200, 24300, 24400]); // opening ATM 24200 +- 2 strikes
    expect(dyn!.strikes).toEqual([23800, 23900, 24000, 24100, 24200]); // current spot 24000 +- 2 strikes
    expect(full!.listed).toBe(11);
    expect(full!.used + full!.excluded).toBe(full!.listed);
    // the full chain's aggregate is the sum of its strikes: identical calculation, only the strike set differs
    expect(full!.levels.netTotal).toBeCloseTo(full!.profile.rows.reduce((a, r) => a + (r.net ?? 0), 0), 9);
    expect(gexUniverses(chain, 24000, EXPIRY, AT, null, 2).map((x) => x.id)).toEqual(["dynamic", "full"]);
  });
  it("counts a strike without a usable side as excluded", () => {
    const rows = [...chain.slice(0, 5), { strike: 24000, call: q(null, null), put: q(null, null) } as OptionChainRow];
    const [full] = gexUniverses(rows.filter((r, i, a) => a.findIndex((x) => x.strike === r.strike) === i && r.strike !== 24000).concat([{ strike: 24000, call: q(null, null), put: q(null, null) } as OptionChainRow]), 24000, EXPIRY, AT, null, 2).slice(-1);
    expect(full!.excluded).toBe(1);
  });
});

describe("sign scenarios", () => {
  const rowOf = (strike: number, ce: number, pe: number): GexRow => ({ strike, ceOi: 1, peOi: 1, ceIv: 0.2, peIv: 0.2, ceGamma: 1, peGamma: 1, ce, pe, net: ce + pe, abs: ce - pe });
  const p: GexProfile = { rows: [rowOf(1, 30, -10), rowOf(2, 5, -25)], spot: 1, expiry: EXPIRY, at: AT, rate: 0, carry: 0, forward: 1, skipped: 0 };
  it("applies each assumption to the call sum (35) and the put magnitude (35)", () => {
    const by = Object.fromEntries(SIGN_SCENARIOS.map((s) => [s.id, scenarioNet(p, s)]));
    expect(by.default).toBe(0); // 35 - 35
    expect(by.long_all).toBe(70);
    expect(by.short_all).toBe(-70);
    expect(by.reversed).toBe(0);
    expect(scenarioNet({ ...p, rows: [] }, SIGN_SCENARIOS[0]!)).toBeNull();
  });
});

const pt = (t: number, spot: number, net: number | null, o: Partial<StructurePoint> = {}): StructurePoint => ({ t: t * 60_000, spot, net, peak: 24000, callWall: 24200, putWall: 23800, flip: 24000, roc: null, ...o });

describe("through the session", () => {
  it("time above and below the flip, with crossings and minutes without a flip", () => {
    const pts = [pt(0, 24050, 10), pt(5, 24040, 9), pt(10, 23990, 8), pt(15, 23980, 7, { flip: null }), pt(20, 24020, 6)];
    // 0-5 above, 5-10 above, 10-15 below, 15-20 no flip; two crossings (above -> below at minute 10, back above at minute 20)
    expect(flipTime(pts)).toEqual({ above: 10, below: 5, unknown: 5, crossings: 2 });
  });
  it("migration: first, last, change, extremes, moves; missing values skipped", () => {
    const pts = [pt(0, 1, 1, { callWall: 24200 }), pt(1, 1, 1, { callWall: 24300 }), pt(2, 1, 1, { callWall: null }), pt(3, 1, 1, { callWall: 24300 }), pt(4, 1, 1, { callWall: 24100 })];
    expect(migration(pts, "callWall")).toEqual({ first: 24200, last: 24100, change: -100, min: 24100, max: 24300, moves: 2, n: 4 });
  });
  it("dynamics: change, percentage, acceleration, persistence", () => {
    const pts = [pt(0, 24000, 100, { roc: null }), pt(1, 24010, 90, { roc: -10 }), pt(2, 24020, 70, { roc: -20 }), pt(3, 24030, 40, { roc: -30, flip: 24010 })];
    const d = gexDynamics(pts);
    expect(d.netChange).toBe(-30); expect(d.netChangePct).toBeCloseTo(-42.857, 2); // -30 / |70|
    expect(d.acceleration).toBe(-10); // -30 - (-20)
    expect(d.persistence).toEqual({ run: 3, direction: "falling", share: 1 });
    expect(d.flipMove).toBe(10);
    expect(d.spotChangePct).toBeCloseTo(0.04162, 4);
  });
});

describe("GEX-price divergence", () => {
  const base = (spot0: number, spot1: number, n0: number, n1: number) => [pt(0, spot0, n0), pt(30, (spot0 + spot1) / 2, (n0 + n1) / 2), pt(60, spot1, n1)];
  it("reads the four quadrants from the signs of the two changes", () => {
    expect(gexPriceDivergence(base(24000, 24100, 50, 10), 60).label).toContain("NIFTY up while net GEX becomes more negative");
    expect(gexPriceDivergence(base(24000, 24100, 10, 50), 60).label).toContain("NIFTY up while net GEX becomes more positive");
    expect(gexPriceDivergence(base(24100, 24000, 50, 10), 60).label).toContain("potential downside amplification");
    expect(gexPriceDivergence(base(24100, 24000, 10, 50), 60).label).toContain("potential stabilisation");
  });
  it("shows absolute and percentage changes, and no reading for flat NIFTY or unchanged GEX", () => {
    const d = gexPriceDivergence(base(24000, 24100, 50, 10), 60);
    expect(d.spotChange).toBe(100); expect(d.spotChangePct).toBeCloseTo(0.4167, 3);
    expect(d.netChange).toBe(-40); expect(d.netChangePct).toBeCloseTo(-80, 6);
    expect(gexPriceDivergence(base(24000, 24002, 50, 10), 60).kind).toBe("none"); // 0.008 % is flat
    expect(gexPriceDivergence(base(24000, 24100, 50, 49), 60).kind).toBe("none"); // 1 of 50 is under 5 %
  });
  it("is unavailable when no sample sits near the window start, and the whole-session window uses the first sample", () => {
    expect(gexPriceDivergence(base(24000, 24100, 50, 10), 15).kind).toBe("unavailable");
    expect(gexPriceDivergence(base(24000, 24100, 50, 10), null).from).toBe(0);
  });
});

describe("dynamic samples", () => {
  it("keeps only the strikes around each sample's own spot", () => {
    const strikes = [23800, 23900, 24000, 24100, 24200];
    expect(nearestStrikes(strikes, 24090, 1)).toEqual([24000, 24100, 24200]);
    const res = { strikes, times: ["2026-11-09T04:00:00Z"], spot: [24000], ce_price: {}, pe_price: {}, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {} } as unknown as StrikeSeries;
    const [s] = gexSamples(res, EXPIRY, 0, 1);
    expect(s!.profile.rows.map((r) => r.strike)).toEqual([23900, 24000, 24100]);
  });
});
