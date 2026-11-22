// The smile in plain words: every figure in the text is read from the surface. Hand-built smile: fit(K) = 12 % + 2e-8 (K - 26000)^2, plus 2 points on the left of the forward.
import { describe, expect, it } from "vitest";
import { fitAt, smileOption, smileReading, smileTop } from "../lib/riskCharts";
import type { SurfaceStrike } from "../lib/risk";

const fit = (k: number) => 0.12 + 2e-8 * (k - 26000) ** 2 + (k < 26000 ? 0.02 : 0);
const row = (strike: number, o: Partial<SurfaceStrike> = {}): SurfaceStrike => ({ expiry: "2026-11-24", strike, cp: 1, price: 1, source: "ltp", iv: fit(strike), status: "used", reason: null, fit_iv: fit(strike), residual_vol_pts: 0, ...o }) as SurfaceStrike;
const grid = [24000, 24500, 25000, 25500, 26000, 26500, 27000, 27500, 28000].map((k) => row(k));
const slice = { n_used: 9, n_rejected: 0, n_flagged: 0, rms_vol_pts: 0.31, butterfly_ok: true, calendar_ok: true, params: {} };

describe("fitAt", () => {
  it("is exact on a fitted strike and linear between two: 24700 lies 40 % of the way from 24500 (18.5 %) to 25000 (16 %) = 17.5 %", () => {
    expect(fitAt(grid, 26000)).toBeCloseTo(0.12, 12);
    expect(fitAt(grid, 24700)).toBeCloseTo(fit(24500) + (fit(25000) - fit(24500)) * 0.4, 12);
    expect(fitAt(grid, 24700)).toBeCloseTo(0.175, 12);
  });
  it("is null outside the fitted strikes and ignores quotes that were not used", () => {
    expect(fitAt(grid, 23000)).toBeNull(); expect(fitAt(grid, 29000)).toBeNull();
    expect(fitAt([row(25000, { status: "unused" }), row(27000, { status: "unused" })], 26000)).toBeNull();
  });
});

describe("smileTop", () => {
  it("is 1.6 times the highest fitted volatility rounded up to 5: 24000 gives 12 + 2e-8 x 4e6 + 2 = 22 %... x 1.6 = 35.2, so 40", () => {
    expect(smileTop(grid)).toBe(40); // the highest fit is at 24000: 0.12 + 0.08 + 0.02 = 22 %
    expect(smileTop([])).toBeUndefined();
  });
  it("is what the chart axis uses, so a stray 110 % quote does not squash the curve", () => {
    const o = smileOption([...grid, row(27250, { status: "unused", iv: 1.1, fit_iv: null })], 26000, { up: "", down: "", brass: "", info: "", muted: "", rule: "", paper: "", slate: "" }) as { yAxis: { max: number; min: number } };
    expect(o.yAxis.max).toBe(40); expect(o.yAxis.min).toBe(0);
  });
});

describe("smileReading", () => {
  it("reads the money level, both wings, and which side is richer, from the numbers", () => {
    const r = smileReading(grid, 26000, slice);
    expect(r.headline).toBe("12.0% at the money, steeper on the downside");
    expect(r.lines[0]).toContain("26,000"); expect(r.lines[0]).toContain("12.0% volatility");
    // 5 % below 26000 = 24700 -> 17.5 %; 5 % above = 27300 -> fit between 27000 (14.0 %) and 27500 (16.5 %) = 15.5 %
    expect(r.lines[1]).toBe("5% below the forward the line is at 17.5% (5.5 points above the money) and 5% above it 15.5% (3.5 points above).");
    expect(r.lines[2]).toContain("puts (downside protection) are priced richer than calls");
  });
  it("says the two sides are level when they are within a point, and calls richer when the right side is higher", () => {
    const sym = grid.map((x) => ({ ...x, fit_iv: 0.12 + 2e-8 * (x.strike - 26000) ** 2 }));
    expect(smileReading(sym, 26000, slice).lines[2]).toContain("about level");
    expect(smileReading(sym, 26000, slice).headline).toContain("level on both sides");
    const right = grid.map((x) => ({ ...x, fit_iv: 0.12 + 2e-8 * (x.strike - 26000) ** 2 + (x.strike > 26000 ? 0.03 : 0) }));
    expect(smileReading(right, 26000, slice).lines[2]).toContain("calls are priced richer");
  });
  it("describes the fit, the arbitrage checks, the grey dots, the flagged and rejected quotes, and counts what is above the chart", () => {
    const more = [...grid, row(27250, { status: "unused", iv: 1.1, fit_iv: null }), row(24250, { status: "unused", iv: 0.5, fit_iv: null }), row(25250, { status: "flagged" })];
    const r = smileReading(more, 26000, { ...slice, n_flagged: 1, n_rejected: 2, rms_vol_pts: 0.31 });
    const text = r.lines.join(" ");
    expect(text).toContain("9 quotes shape the line; on average they sit 0.31 volatility points from it (a tight fit)");
    expect(text).toContain("The no-arbitrage checks pass");
    expect(text).toContain("2 grey dots are quotes that were not used");
    expect(text).toContain("1 flagged (hollow red diamonds");
    expect(text).toContain("2 rejected quotes");
    expect(r.above).toBe(2); // the 110 % quote and the 50 % one are above the 40 % top
  });
  it("a loose fit and a failed check are said plainly; no forward means nothing to read", () => {
    const text = smileReading(grid, 26000, { ...slice, rms_vol_pts: 2, butterfly_ok: false }).lines.join(" ");
    expect(text).toContain("a loose fit: treat the Greeks with care");
    expect(text).toContain("A no-arbitrage check fails (butterfly)");
    expect(smileReading(grid, null, slice).headline).toBe("no smile could be fitted for this expiry");
  });
});
