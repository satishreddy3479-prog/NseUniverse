import { describe, expect, it } from "vitest";
import { applyDwell, forwardCheck, labelFor, regimeForCandles, regimeSeries, regimeSummary, stepClass, trendScore, type RegimeMetrics, type RegimeSeries } from "../lib/trendRegime";
import type { RBar } from "../lib/trendStats";

const T0 = Date.UTC(2026, 10, 25, 3, 45); // 09:15 IST
const mk = (closes: number[]): RBar[] => closes.map((c, i) => ({ t: T0 + i * 60_000, o: c, h: c + 0.5, l: c - 0.5, c }));
const m = (o: Partial<RegimeMetrics>): RegimeMetrics => ({ er: null, adx: null, plusDi: null, minusDi: null, r2: null, slope: null, chop: null, ...o });

describe("trend regime (score based)", () => {
  it("each reading is a linear ramp between its no-trend and full-trend level, and the score is their mean", () => {
    // er 0.30 is halfway between 0.15 and 0.45; adx 25 halfway between 15 and 35; r2 0.5 halfway between 0.2 and 0.8; chop 50 halfway between 61.8 and 38.2
    const half = trendScore(m({ er: 0.3, adx: 25, r2: 0.5, chop: 50 }));
    expect(half.score).toBeCloseTo(0.5, 12);
    expect(half.scores.adx).toBe(0.5);
    expect(half.scores.er).toBeCloseTo(0.5, 12);
    expect(half.scores.chop).toBeCloseTo(0.5, 12);
    expect(trendScore(m({ er: 5, adx: 90, r2: 1, chop: 5 })).score).toBe(1); // clamped
    expect(trendScore(m({ er: 0, adx: 0, r2: 0, chop: 100 })).score).toBe(0);
    expect(trendScore(m({ er: 0.3, adx: 25, r2: 0.5 })).score).toBeCloseTo(0.5, 12); // a missing reading is left out, not zero
    expect(trendScore(m({ er: 0.3, adx: 25 })).score).toBeNull(); // two readings are too few
  });

  it("the 23 Nov closing readings that were called Unclear (ER 0.32, ADX 47.9, R2 0.89, choppiness 38.7, falling) now read Trending down", () => {
    // scores 0.5667, 1, 1, (38.7 - 61.8) / (38.2 - 61.8) = 0.9788 -> mean 0.8864
    const x = m({ er: 0.32, adx: 47.9, r2: 0.89, chop: 38.7, slope: -3, plusDi: 12.6, minusDi: 26.3 });
    const s = trendScore(x);
    expect(s.score).toBeCloseTo(0.8864, 3);
    expect(labelFor(stepClass(null, s.score!), x)).toBe("Trending down");
  });

  it("a class changes only when the score is 0.05 past the boundary, up or down", () => {
    expect(stepClass(null, 0.5)).toBe(2); // weak trend
    expect(stepClass(2, 0.66)).toBe(2); // above 0.65 but not 0.70
    expect(stepClass(2, 0.7)).toBe(3);
    expect(stepClass(3, 0.62)).toBe(3); // under 0.65 but not under 0.60
    expect(stepClass(3, 0.59)).toBe(2);
    expect(stepClass(2, 0.43)).toBe(2); // under 0.45 but not under 0.40
    expect(stepClass(2, 0.39)).toBe(1);
    expect(stepClass(0, 0.9)).toBe(3); // a big move crosses several classes
    expect(stepClass(3, 0.1)).toBe(0);
  });

  it("direction comes from the slope, and +DI / -DI contradicting it makes the bar Mixed", () => {
    expect(labelFor(3, m({ slope: 1, plusDi: 30, minusDi: 10 }))).toBe("Trending up");
    expect(labelFor(3, m({ slope: -1, plusDi: 10, minusDi: 30 }))).toBe("Trending down");
    expect(labelFor(3, m({ slope: 1, plusDi: 10, minusDi: 30 }))).toBe("Mixed");
    expect(labelFor(2, m({ slope: -1 }))).toBe("Weak downtrend");
    expect(labelFor(2, m({ slope: 1 }))).toBe("Weak uptrend");
    expect(labelFor(2, m({ slope: null }))).toBe("Mixed");
    expect(labelFor(0, m({}))).toBe("Range-bound");
  });

  it("a label changes only after the new one has held for the dwell count", () => {
    expect(applyDwell(["A", "A", "B", "B", "A", "B", "B", "B"], 3)).toEqual(["A", "A", "A", "A", "A", "A", "A", "B"]);
    expect(applyDwell(["A", "B", "B", "B"], 1)).toEqual(["A", "B", "B", "B"]);
  });

  it("a straight rise is Trending up with every reading in agreement, and the first label comes after the minimum window, not a full one", () => {
    // 1 point a minute, high = close + 0.5, low = close - 0.5: ER 1, +DM 1 every bar so ADX 100, R2 1, choppiness well under 38.2
    const r = regimeSeries(mk(Array.from({ length: 60 }, (_, i) => 100 + i)), { tf: 1 });
    const last = r.points[59]!;
    expect(last.label).toBe("Trending up");
    expect(last.score).toBeCloseTo(1, 9);
    expect(last.agreement).toEqual({ agree: 4, of: 4 });
    expect(last.metrics.er).toBe(1);
    // window 30 at 1-minute bars: sum TR = 30 x 1.5 = 45, range = 29 + 1 = 30 -> 100 x log10(1.5) / log10(30) = 11.92
    expect(last.metrics.chop).toBeCloseTo(11.92, 1);
    expect(last.window).toBe(30);
    // bars 0-5 have fewer than 6 bars of look-back; bar 6 is the first with a reading (window 6) and the dwell needs 3 in a row
    expect(r.points[5]!.label).toBe("Warming up");
    expect(r.points[6]!.score).not.toBeNull();
    expect(r.points[7]!.label).toBe("Warming up");
    expect(r.points[8]!.label).toBe("Trending up");
    expect(r.points[6]!.window).toBe(6);
  });

  it("a fall is Trending down, and a back-and-forth is Range-bound", () => {
    const down = regimeSeries(mk(Array.from({ length: 60 }, (_, i) => 200 - i)), { tf: 1 });
    expect(down.points[59]!.label).toBe("Trending down");
    const flat = regimeSeries(mk(Array.from({ length: 80 }, (_, i) => (i % 2 ? 101 : 100))), { tf: 1 });
    const last = flat.points[79]!;
    expect(last.label).toBe("Range-bound");
    expect(last.score).toBeLessThan(0.3);
    expect(last.agreement!.agree).toBe(last.agreement!.of);
  });

  it("with too few bars every bar is Warming up, with no score", () => {
    const r = regimeSeries(mk([100, 101, 102, 103]), { tf: 1 });
    expect(r.points.every((p) => p.label === "Warming up" && p.score === null && p.agreement === null)).toBe(true);
  });

  it("the look-back follows the bar length", () => {
    const bars = mk(Array.from({ length: 200 }, (_, i) => 100 + i));
    expect(regimeSeries(bars, { tf: 1 }).params.window).toBe(30);
    expect(regimeSeries(bars, { tf: 3 }).params.window).toBe(20);
    expect(regimeSeries(bars, { tf: 5 }).params.window).toBe(12);
    expect(regimeSeries(bars, { tf: 15 }).params.window).toBe(8);
  });

  it("summary counts the time in each label and the changes", () => {
    const pts = ["Warming up", "Range-bound", "Range-bound", "Trending up"].map((label, i) => ({ t: i, label, raw: label, score: 0.5, scores: {}, agreement: null, metrics: {} as never, window: 6 }));
    const s = regimeSummary(pts as never);
    expect(s.counts).toEqual({ "Warming up": 1, "Range-bound": 2, "Trending up": 1 });
    expect(s.changes).toBe(1); // leaving the warm-up is not a change
  });

  it("the stored-session check averages the next bars' efficiency ratio by label class", () => {
    // closes 1,2,3,4,3,4, horizon 2. bar 0: 1,2,3 -> ER 1; bar 1: 2,3,4 -> 1; bar 2: 3,4,3 -> 0; bar 3: 4,3,4 -> 0; bars 4 and 5 have no full window
    const bars = mk([1, 2, 3, 4, 3, 4]);
    const pt = (t: number, label: string) => ({ t, label, raw: label, score: 0.5, scores: {}, agreement: null, metrics: {} as never, window: 6 });
    const series = { bars, params: {} as never, points: [pt(0, "Trending up"), pt(1, "Weak uptrend"), pt(2, "Range-bound"), pt(3, "Mixed"), pt(4, "Warming up"), pt(5, "Range-bound")] } as unknown as RegimeSeries;
    const r = forwardCheck(series, 2);
    expect(r.trending).toEqual({ n: 1, meanForwardEr: 1 });
    expect(r.weak).toEqual({ n: 1, meanForwardEr: 1 });
    expect(r.range).toEqual({ n: 1, meanForwardEr: 0 });
    expect(r.mixed).toEqual({ n: 1, meanForwardEr: 0 });
  });

  it("a chart candle takes the label of the regime bar that starts in its slot", () => {
    // 3-minute slots from 09:15 on a 90-bar rise: the first bars are warm-up, the 30th bar (10:42) is Trending up
    const r = regimeSeries(mk(Array.from({ length: 90 }, (_, i) => 100 + i)), { tf: 3 });
    const labels = regimeForCandles(r, ["09:15", "09:18", "13:00", "99:99"], 3);
    expect(labels[0]).toBe("Warming up");
    expect(labels[1]).toBe("Warming up");
    expect(labels[2]).toBeNull(); // the session has no bar at 13:00
    expect(labels[3]).toBeNull();
    expect(regimeForCandles(r, ["10:42"], 3)[0]).toBe("Trending up"); // 09:15 + 29 x 3 = 10:42
  });
});
