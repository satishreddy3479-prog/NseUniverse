import { describe, expect, it } from "vitest";
import { hideHover, positionAt, syncHover, syncLegend, syncZoom, type LinkChart } from "../lib/hoverSync";

type Act = Record<string, unknown>;
type Fake = LinkChart & { actions: Act[] };

/**
 * A chart whose x axis maps position p to pixel `left + (p - from) * scale`: categories are positions 0..n-1 (from 0), a time/number axis is any
 * value in [from, to]. The plot area is `gridTop`..`gridBottom` in pixels and spans the axis extent horizontally.
 */
function fake(o: { kind?: "category" | "value"; n?: number; from?: number; to?: number; left?: number; scale?: number; height?: number; gridTop?: number; gridBottom?: number }): Fake {
  const { kind = "category", n = 100, from = 0, to = n - 1, left = 50, scale = 4, height = 200, gridTop = 20, gridBottom = 180 } = o;
  const actions: Act[] = [];
  return {
    actions,
    convertFromPixel: (_f, x) => from + (x - left) / scale,
    convertToPixel: (_f, v) => left + (v - from) * scale,
    containPixel: (f, [x, y]) => f.gridIndex === 0 && x >= left && x <= left + (to - from) * scale && y >= gridTop && y <= gridBottom,
    getHeight: () => height,
    dispatchAction: (a) => { actions.push(a); },
    axisKind: () => kind,
    categoryCount: () => n,
  };
}

describe("linked hover by position on the shared x axis", () => {
  it("marks the same category index in every other chart, whatever each chart's pixel scale is", () => {
    const a = fake({ left: 50, scale: 4 }), b = fake({ left: 30, scale: 6 }), c = fake({ left: 60, scale: 2 });
    syncHover(a, 50 + 4 * 25, 100, [a, b, c]); // the pointer is over category 25 of chart a
    expect(b.actions).toEqual([{ type: "showTip", x: 30 + 6 * 25, y: 30 }]);
    expect(c.actions).toEqual([{ type: "showTip", x: 60 + 2 * 25, y: 30 }]);
    expect(a.actions).toEqual([]); // the chart being pointed at draws its own tooltip
  });
  it("links time or number axes by value, even when the charts show different ranges", () => {
    const t0 = 1_000_000, a = fake({ kind: "value", from: t0, to: t0 + 6000, left: 40, scale: 0.1 }), b = fake({ kind: "value", from: t0 + 1000, to: t0 + 5000, left: 40, scale: 0.2 });
    syncHover(a, 40 + 0.1 * 3000, 100, [a, b]); // value t0 + 3000
    const act = b.actions[0] as { type: string; x: number };
    expect(act.type).toBe("showTip");
    expect(act.x).toBeCloseTo(40 + 0.2 * 2000, 6); // the same value is 2000 into b's range
  });
  it("a value outside another chart's range hides its tooltip instead of showing a wrong one", () => {
    const a = fake({ kind: "value", from: 0, to: 1000, left: 0, scale: 1 }), b = fake({ kind: "value", from: 600, to: 900, left: 0, scale: 1 });
    syncHover(a, 100, 100, [a, b]); // value 100 is before b's first value
    expect(b.actions).toEqual([{ type: "hideTip" }]);
  });
  it("does not depend on the series or legend of any chart: only the position is used", () => {
    const a = fake({ n: 60, left: 40, scale: 5 }), b = fake({ n: 60, left: 40, scale: 5 });
    syncHover(a, 40 + 5 * 7, 100, [a, b]);
    expect(b.actions).toEqual([{ type: "showTip", x: 40 + 5 * 7, y: 30 }]);
  });
  it("hides the others when the pointer is outside the plot or the data, or the position cannot be mapped", () => {
    const a = fake({ n: 10, left: 50, scale: 10 }), b = fake({ n: 10, left: 50, scale: 10 });
    syncHover(a, 5, 100, [a, b]); // left of the first category
    syncHover(a, 50 + 10 * 25, 100, [a, b]); // beyond the last
    syncHover(a, 100, 5, [a, b]); // above the plot area (the title or legend)
    expect(b.actions).toEqual([{ type: "hideTip" }, { type: "hideTip" }, { type: "hideTip" }]);
    const bad = { ...fake({ n: 10, left: 50, scale: 10 }), convertFromPixel: () => { throw new Error("no axis"); } };
    expect(positionAt(bad, 60, 100)).toBeNull();
  });
  it("finds a y inside the first plot area for a chart whose plot area is not in the middle", () => {
    const a = fake({ n: 20, left: 0, scale: 10 }), top = fake({ n: 20, left: 0, scale: 10, height: 400, gridTop: 10, gridBottom: 90 });
    syncHover(a, 50, 100, [a, top]);
    const act = top.actions[0] as { type: string; y: number };
    expect(act.type).toBe("showTip");
    expect(act.y).toBeGreaterThanOrEqual(10);
    expect(act.y).toBeLessThanOrEqual(90);
  });
  it("a chart that cannot place the position hides its tooltip", () => {
    const a = fake({ n: 20, left: 0, scale: 10 }), none = { ...fake({ n: 20, left: 0, scale: 10 }), containPixel: () => false };
    syncHover(a, 50, 100, [a, none]);
    expect(none.actions).toEqual([{ type: "hideTip" }]);
  });
  it("leaving a chart hides the tooltips of the others", () => {
    const a = fake({}), b = fake({});
    hideHover(a, [a, b]);
    expect(b.actions).toEqual([{ type: "hideTip" }]);
    expect(a.actions).toEqual([]);
  });
});

describe("linked zoom and legend", () => {
  it("applies a zoom window to the other charts only", () => {
    const a = fake({}), b = fake({});
    syncZoom(a, { start: 20, end: 60 }, [a, b]);
    expect(b.actions).toEqual([{ type: "dataZoom", start: 20, end: 60 }]);
    expect(a.actions).toEqual([]);
    syncZoom(a, { start: 20 }, [a, b]); // a zoom without a window is ignored
    expect(b.actions).toHaveLength(1);
  });
  it("switches the legend item of the same name on or off in the other charts", () => {
    const a = fake({}), b = fake({});
    syncLegend(a, "Call", false, [a, b]);
    syncLegend(a, "Call", true, [a, b]);
    expect(b.actions).toEqual([{ type: "legendUnSelect", name: "Call" }, { type: "legendSelect", name: "Call" }]);
  });
  it("a chart that has no zoom or no such legend item does not stop the others", () => {
    const a = fake({}), broken = { ...fake({}), dispatchAction: () => { throw new Error("no such component"); } }, c = fake({});
    expect(() => syncZoom(a, { start: 0, end: 50 }, [a, broken, c])).not.toThrow();
    expect(c.actions).toEqual([{ type: "dataZoom", start: 0, end: 50 }]);
    expect(() => syncLegend(a, "x", false, [a, broken, c])).not.toThrow();
  });
});
