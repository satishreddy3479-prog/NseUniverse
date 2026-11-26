// Premium Change: the split of a straddle's change into time decay, NIFTY moving and volatility.
// Hand checks use the closed form of Black-76 at zero rate (written here with its own normal CDF, not the app's); the real-data checks use the stored minutes of Wed 25 Nov 2026
// (weekly expiry 1 Dec, ATM +-5 strikes, taken read-only from the server) and read the expected totals straight from those prices.
import { describe, expect, it } from "vitest";
import { changeWindows, readout, runningTotals, splitStraddle } from "../lib/premiumChange";
import { expiryEnd } from "../lib/optionModel";
import type { StrikeSeries } from "../lib/types";
import real from "./premium-change-2026-11-25.json";

const erf = (x: number) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
/** Black-76 at zero rate, the textbook formula */
const black = (F: number, K: number, T: number, s: number, call: boolean) => {
  const v = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * v * v) / v, d2 = d1 - v;
  return call ? F * N(d1) - K * N(d2) : K * N(-d2) - F * N(-d1);
};
const YEAR = 365 * 86_400_000;
const EXPIRY = "2026-12-01";
const END = expiryEnd(EXPIRY);
const t0 = END - 0.25 * YEAR; // exactly a quarter of a year left at the start
const DAY = 86_400_000;
const T0 = 0.25, T1 = 0.25 - DAY / YEAR; // one calendar day later

function split(p: { F0?: number; S1?: number; sig1?: number }) {
  const F0 = p.F0 ?? 100, sig0 = 0.2, sig1 = p.sig1 ?? sig0;
  const S1 = p.S1 ?? F0;
  const ce0 = black(F0, 100, T0, sig0, true), pe0 = black(F0, 100, T0, sig0, false);
  const ce1 = black(S1, 100, T1, sig1, true), pe1 = black(S1, 100, T1, sig1, false);
  return { s: splitStraddle({ strike: 100, ce0, pe0, ce1, pe1, f0: F0, spot0: F0, spot1: S1, t0Ms: t0, t1Ms: t0 + DAY, expiry: EXPIRY, rate: 0 }), ce0, pe0, ce1, pe1 };
}

describe("splitStraddle: hand checks at zero rate", () => {
  it("at the money, F = 100, 20 % volatility, a quarter of a year: each leg is 100 (2 N(0.05) - 1) = 3.988", () => {
    const { ce0, pe0 } = split({});
    expect(ce0).toBeCloseTo(3.98776, 3);
    expect(pe0).toBeCloseTo(3.98776, 3);
  });

  it("only time passes (same spot, same volatility): everything is decay, and it is negative", () => {
    const { s, ce0, pe0, ce1, pe1 } = split({});
    // one day later sigma sqrt(T) falls from 0.1 to 0.2 sqrt(0.25 - 1/365) = 0.09945, so each leg is worth 100 (2 N(0.049725) - 1)
    expect(ce1).toBeCloseTo(100 * (2 * N(0.0497253) - 1), 3);
    expect(s).not.toBeNull();
    expect(s!.decay).toBeCloseTo(ce1 + pe1 - ce0 - pe0, 4);
    expect(s!.decay).toBeLessThan(0);
    expect(Math.abs(s!.spot)).toBeLessThan(1e-6);
    expect(Math.abs(s!.vol)).toBeLessThan(1e-6);
    expect(s!.total).toBeCloseTo(s!.decay, 6);
  });

  it("only the spot moves (+10 points, same volatility): the spot part carries it, volatility part is zero, and a straddle gains from the move", () => {
    const { s, ce1, pe1 } = split({ S1: 110 });
    expect(s!.spot).toBeGreaterThan(3.5); // a 10 point move on a 3.99 + 3.99 straddle: the gamma gain is large (about 3.98 by hand, below)
    expect(Math.abs(s!.vol)).toBeLessThan(1e-3); // the test's own normal CDF (7 digits) prices the end point, the app's solves the start: they agree to a thousandth of a rupee
    expect(s!.total).toBeCloseTo(ce1 + pe1 - 2 * black(100, 100, T0, 0.2, true), 6);
    // the call gains about 10 x delta (0.5) and the put loses about the same: what is left over is gamma, 0.5 x gamma x 10^2 x 2 legs, with gamma = phi(0.05) / (100 x 0.1) = 0.0399
    expect(s!.spot).toBeCloseTo(0.5 * 0.0399 * 100 * 2, 0); // within a rupee: the third derivative and the day's decay are small against it
  });

  it("only the volatility moves (20 % to 22 %, same spot): the volatility part carries it and is about vega x 2 points for both legs", () => {
    const { s } = split({ sig1: 0.22 });
    expect(Math.abs(s!.spot)).toBeLessThan(1e-6);
    // vega per vol point of one leg = F phi(d1) sqrt(T) / 100 = 100 x 0.3984 x 0.5 / 100 = 0.1992; two legs, two points
    expect(s!.vol).toBeCloseTo(0.1992 * 2 * 2, 1);
  });

  it("the three parts always add up to the change, whatever happens", () => {
    for (const [S1, sig1] of [[100, 0.2], [103, 0.19], [96, 0.25], [111, 0.3], [90, 0.15]] as const) {
      const { s } = split({ S1, sig1 });
      expect(s!.decay + s!.spot + s!.vol).toBeCloseTo(s!.total, 8);
    }
  });

  it("a missing or zero price, or time already up, gives null (never a made-up number)", () => {
    const base = { strike: 100, ce0: 4, pe0: 4, ce1: 4.1, pe1: 3.9, f0: 100, spot0: 100, spot1: 100, t0Ms: t0, t1Ms: t0 + 60_000, expiry: EXPIRY, rate: 0 };
    expect(splitStraddle(base)).not.toBeNull();
    expect(splitStraddle({ ...base, ce1: Number.NaN })).toBeNull();
    expect(splitStraddle({ ...base, pe0: 0 })).toBeNull();
    expect(splitStraddle({ ...base, ce0: 150 })).toBeNull(); // a call worth more than the forward itself: no volatility gives it
    expect(splitStraddle({ ...base, t1Ms: END + 1000 })).toBeNull();
  });
});

const series = real as unknown as StrikeSeries;
const hhmmOf = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(11, 16);
const idx = (hhmm: string) => series.times.findIndex((t) => hhmmOf(t) === hhmm);

describe("changeWindows on the real stored minutes of 25 Nov 2026", () => {
  const res = changeWindows(series, EXPIRY, 5);

  it("makes one window per 5 minutes of the session and each one's three parts add up to its own real change", () => {
    expect(res.windows.length).toBeGreaterThan(60);
    expect(res.windows.length).toBeLessThan(76);
    let checked = 0;
    for (const w of res.windows) for (const s of [w.atm, ...Object.values(w.strikes)]) {
      if (!s) continue;
      expect(s.decay + s.spot + s.vol).toBeCloseTo(s.total, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("the ATM straddle's change is exactly the difference of the two stored prices (read here straight from the data)", () => {
    const w = res.windows.find((x) => hhmmOf(new Date(x.t).toISOString()) === "11:40")!;
    expect(w).toBeDefined();
    const k = String(w.atmStrike);
    const at = (hhmm: string) => series.ce_price[k]![idx(hhmm)]! + series.pe_price[k]![idx(hhmm)]!;
    expect(w.atm!.total).toBeCloseTo(at("11:40") - at("11:35"), 6);
    expect(w.straddle).toBeCloseTo(at("11:40"), 6);
    expect(w.spot).toBe(series.spot[idx("11:40")]);
    expect(w.spot0).toBe(series.spot[idx("11:35")]);
  });

  it("time decay is small and negative in every 5-minute window (a day's decay spread over the hours), and volatility and the rest is the largest part on average", () => {
    const atm = res.windows.map((w) => w.atm).filter((x): x is NonNullable<typeof x> => x != null);
    expect(atm.length).toBeGreaterThan(60);
    expect(atm.every((s) => s.decay < 0 && s.decay > -0.5)).toBe(true);
    const mean = (f: (s: (typeof atm)[number]) => number) => atm.reduce((a, s) => a + Math.abs(f(s)), 0) / atm.length;
    expect(mean((s) => s.vol)).toBeGreaterThan(mean((s) => s.spot));
    expect(mean((s) => s.spot)).toBeGreaterThan(mean((s) => s.decay));
  });

  it("running totals add the windows up and end at the sum of the totals", () => {
    const run = runningTotals(res.windows);
    expect(run.length).toBe(res.windows.length);
    const sum = res.windows.reduce((a, w) => a + (w.atm?.total ?? 0), 0);
    expect(run[run.length - 1]!.total).toBeCloseTo(sum, 6);
    const last = run[run.length - 1]!;
    expect(last.decay! + last.spot! + last.vol!).toBeCloseTo(last.total!, 6);
  });

  it("a gap in the stored samples skips the window across it and counts it (nothing is filled in)", () => {
    const cut = (re: StrikeSeries, a: string, b: string): StrikeSeries => {
      const keep = re.times.map((t, i) => ({ i, m: hhmmOf(t) })).filter((x) => !(x.m > a && x.m < b)).map((x) => x.i);
      const pick = <T,>(arr: T[]) => keep.map((i) => arr[i]!);
      const per = (o: Record<string, (number | null)[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, pick(v)]));
      return { ...re, times: pick(re.times), spot: pick(re.spot), ce_price: per(re.ce_price), pe_price: per(re.pe_price), ce_oi: per(re.ce_oi), pe_oi: per(re.pe_oi), ce_change: per(re.ce_change), pe_change: per(re.pe_change) };
    };
    const gap = changeWindows(cut(series, "11:30", "11:46"), EXPIRY, 5);
    expect(gap.skippedWindows).toBeGreaterThanOrEqual(1);
    expect(gap.windows.length).toBeLessThan(res.windows.length);
    expect(gap.windows.some((w) => hhmmOf(new Date(w.t).toISOString()) === "11:45")).toBe(false); // the window that would run 11:30 to 11:45 is not made up
  });

  it("the sentence says what the straddle did and what drove it", () => {
    const w = res.windows.find((x) => hhmmOf(new Date(x.t).toISOString()) === "11:40")!;
    const text = readout(w, 5, "11:40")!;
    expect(text).toMatch(/^At 11:40 the \d{5} straddle \(₹\d+\.\d\) went (up|down) by ₹\d+\.\d in 5 minutes \(NIFTY [+−]\d+ points\): /);
    expect(text).toContain("from time decay");
    expect(text).toContain("from NIFTY moving");
    expect(text).toContain("from volatility and the rest");
    expect(readout({ ...w, atm: null }, 5, "11:40")).toBeNull();
  });

  it("other window lengths work: 15-minute windows are fewer and each is still exact", () => {
    const r15 = changeWindows(series, EXPIRY, 15);
    expect(r15.windows.length).toBeGreaterThan(20);
    expect(r15.windows.length).toBeLessThan(res.windows.length / 2);
    for (const w of r15.windows) if (w.atm) expect(w.atm.decay + w.atm.spot + w.atm.vol).toBeCloseTo(w.atm.total, 6);
  });
});
