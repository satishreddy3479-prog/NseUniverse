import { describe, expect, it } from "vitest";
import { applyDwell, classify, forwardCheck, regimeForCandles, regimeSeries, regimeSummary, type RegimeSeries } from "../lib/trendRegime";
import type { RBar } from "../lib/trendStats";

const T0 = Date.UTC(2026, 10, 25, 3, 45); // 09:15 IST
const mk = (closes: number[]): RBar[] => closes.map((c, i) => ({ t: T0 + i * 60_000, o: c, h: c + 0.5, l: c - 0.5, c }));

describe("trend regime", () => {
  it("a label changes only after it has held for the dwell count", () => {
    // [A,A,B,B,A,B,B,B], dwell 3: the B pair is cut short by an A, the last three Bs switch it at the final bar
    expect(applyDwell(["A", "A", "B", "B", "A", "B", "B", "B"], 3)).toEqual(["A", "A", "A", "A", "A", "A", "A", "B"]);
    expect(applyDwell(["A", "B", "B", "B"], 1)).toEqual(["A", "B", "B", "B"]);
  });

  it("a straight rise is Trending up with every reading in agreement", () => {
    // closes rise 1 a bar, high = close + 0.5, low = close - 0.5: ER 1, +DM 1 every bar so ADX 100, R2 1, choppiness
    // 100 x log10(sum TR / range) / log10(n), hand-checked below
    const r = regimeSeries(mk(Array.from({ length: 40 }, (_, i) => 100 + i)), { tf: 1 });
    const last = r.points[r.points.length - 1];
    expect(last!.label).toBe("Trending up");
    expect(last!.metrics.er).toBe(1);
    expect(last!.metrics.adx).toBeCloseTo(100, 6);
    expect(last!.metrics.r2).toBeCloseTo(1, 9);
    expect(last!.metrics.chop).toBeCloseTo(16.317, 2); // window 12: sum TR = 12 x 1.5 = 18, range = 11 + 1 = 12 -> 100 x log10(1.5) / log10(12)
    expect(last!.votes).toEqual({ trend: 4, range: 0, evaluable: 4 });
    expect(last!.confidence).toBe(1);
  });

  it("a fall is Trending down, and a back-and-forth is Range-bound", () => {
    const down = regimeSeries(mk(Array.from({ length: 40 }, (_, i) => 200 - i)), { tf: 1 });
    expect(down.points[39]!.label).toBe("Trending down");
    const flat = regimeSeries(mk(Array.from({ length: 60 }, (_, i) => (i % 2 ? 101 : 100))), { tf: 1 });
    const last = flat.points[59];
    expect(last!.label).toBe("Range-bound");
    expect(last!.votes.range).toBeGreaterThanOrEqual(3);
  });

  it("the first bars are Warming up, and a missing reading is not a vote", () => {
    const r = regimeSeries(mk([100, 101, 102, 103]), { tf: 1 });
    expect(r.points.every((p) => p.label === "Warming up" && p.confidence === null)).toBe(true);
    // ER and R2 only: two evaluable readings is too few to label
    expect(classify({ er: 0.9, adx: null, plusDi: null, minusDi: null, r2: 0.9, slope: 1, chop: null }).raw).toBe("Warming up");
  });

  it("slope against +DI / -DI blocks a direction call, and in-between readings stay Unclear", () => {
    const disagree = classify({ er: 0.5, adx: 30, plusDi: 10, minusDi: 30, r2: 0.8, slope: 1, chop: 30 });
    expect(disagree.raw).toBe("Unclear");
    const mid = classify({ er: 0.27, adx: 22, plusDi: 20, minusDi: 18, r2: 0.45, slope: 0.5, chop: 50 });
    expect(mid.raw).toBe("Unclear");
    expect(mid.votes).toEqual({ trend: 0, range: 0, evaluable: 4 });
  });

  it("summary counts the time in each label and the changes", () => {
    const pts = ["Warming up", "Range-bound", "Range-bound", "Trending up"].map((label, i) => ({ t: i, label, raw: label, confidence: 1, votes: { trend: 0, range: 0, evaluable: 4 }, metrics: {} as never, reasons: [] }));
    const s = regimeSummary(pts as never);
    expect(s.counts).toEqual({ "Warming up": 1, "Range-bound": 2, "Trending up": 1 });
    expect(s.changes).toBe(1); // leaving the warm-up is not a change
  });

  it("the stored-session check averages the next bars' efficiency ratio by label class", () => {
    // closes 1..6 (bars of 1 minute), horizon 2: from bar 0 the next two changes are +1 +1 -> ER 1; labels given by hand
    const bars = mk([1, 2, 3, 4, 3, 4]);
    const pt = (t: number, label: string) => ({ t, label, raw: label, confidence: 1, votes: { trend: 0, range: 0, evaluable: 4 }, metrics: {} as never, reasons: [] });
    const series = { bars, params: {} as never, points: [pt(0, "Trending up"), pt(1, "Trending up"), pt(2, "Range-bound"), pt(3, "Unclear"), pt(4, "Warming up"), pt(5, "Range-bound")] } as unknown as RegimeSeries;
    const r = forwardCheck(series, 2);
    // bar 0: 1,2,3 -> ER 1; bar 1: 2,3,4 -> 1; bar 2: 3,4,3 -> net 0 / path 2 = 0; bar 3: 4,3,4 -> 0; bars 4, 5 have no full window
    expect(r.trending).toEqual({ n: 2, meanForwardEr: 1 });
    expect(r.range).toEqual({ n: 1, meanForwardEr: 0 });
    expect(r.unclear).toEqual({ n: 1, meanForwardEr: 0 });
  });

  it("a chart candle takes the label of the regime bar that starts in its slot", () => {
    // 3-minute slots from 09:15: 09:15, 09:18, 09:21; the regime of a 60-bar rise at 3 minutes has its first labels in the warm-up
    const r = regimeSeries(mk(Array.from({ length: 90 }, (_, i) => 100 + i)), { tf: 3 });
    const labels = regimeForCandles(r, ["09:15", "09:18", "13:00", "99:99"], 3);
    expect(labels[0]).toBe("Warming up");
    expect(labels[1]).toBe("Warming up");
    expect(labels[2]).toBeNull(); // the session has no bar at 13:00
    expect(labels[3]).toBeNull();
    expect(regimeForCandles(r, ["10:42"], 3)[0]).toBe("Trending up"); // the 30th three-minute bar: 09:15 + 29 x 3 = 10:42
  });
});

