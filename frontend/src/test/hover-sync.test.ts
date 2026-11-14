import { describe, expect, it } from "vitest";
import { hideHover, syncHover, type HoverChart } from "../lib/hoverSync";

type Action = { type: "showTip"; x: number; y: number } | { type: "hideTip" };
/** a chart with `n` categories drawn `step` pixels apart from `left`; `gridTop`..`gridBottom` is its plot area in pixels */
function fake(n: number, left: number, step: number, height = 200, gridTop = 20, gridBottom = 180) {
  const actions: Action[] = [];
  const c: HoverChart & { actions: Action[] } = {
    actions,
    convertFromPixel: (_f, x) => (x - left) / step,
    convertToPixel: (_f, i) => left + i * step,
    containPixel: (_f, [x, y]) => x >= left && x <= left + (n - 1) * step && y >= gridTop && y <= gridBottom,
    getHeight: () => height,
    dispatchAction: (a) => { actions.push(a); },
    categoryCount: () => n,
  };
  return c;
}

describe("shared hover by position on the time axis", () => {
  it("marks the same category index in every other chart, whatever each chart's pixel scale is", () => {
    const a = fake(100, 50, 4), b = fake(100, 30, 6), c = fake(100, 60, 2);
    syncHover(a, 50 + 4 * 25, [a, b, c]); // the pointer is over category 25 of chart a
    expect(b.actions).toEqual([{ type: "showTip", x: 30 + 6 * 25, y: 30 }]);
    expect(c.actions).toEqual([{ type: "showTip", x: 60 + 2 * 25, y: 30 }]);
    expect(a.actions).toEqual([]); // the chart being pointed at draws its own tooltip
  });
  it("does not depend on the series of the hovered chart: only the position is used", () => {
    // charts have no series in this interface at all; the same index is found however the legends are set
    const a = fake(60, 40, 5), b = fake(60, 40, 5);
    syncHover(a, 40 + 5 * 7, [a, b]);
    expect(b.actions).toEqual([{ type: "showTip", x: 40 + 5 * 7, y: 30 }]);
  });
  it("hides the others when the pointer is outside the data (the axis margins) or the position cannot be mapped", () => {
    const a = fake(10, 50, 10), b = fake(10, 50, 10);
    syncHover(a, 5, [a, b]); // left of the first category
    syncHover(a, 50 + 10 * 25, [a, b]); // beyond the last
    expect(b.actions).toEqual([{ type: "hideTip" }, { type: "hideTip" }]);
    const bad = { ...fake(10, 50, 10), convertFromPixel: () => { throw new Error("no axis"); } };
    const d = fake(10, 50, 10);
    syncHover(bad, 60, [bad, d]);
    expect(d.actions).toEqual([{ type: "hideTip" }]);
  });
  it("finds a y inside the first plot area for a chart whose plot area is not in the middle", () => {
    const a = fake(20, 0, 10), top = fake(20, 0, 10, 400, 10, 90); // the plot area of `top` is the upper quarter of 400 px
    syncHover(a, 50, [a, top]);
    const act = top.actions[0] as { type: "showTip"; y: number };
    expect(act.type).toBe("showTip");
    expect(act.y).toBeGreaterThanOrEqual(10); expect(act.y).toBeLessThanOrEqual(90);
  });
  it("a chart that cannot place the position hides its tooltip instead of showing a wrong one", () => {
    const a = fake(20, 0, 10), none = { ...fake(20, 0, 10), containPixel: () => false };
    syncHover(a, 50, [a, none]);
    expect(none.actions).toEqual([{ type: "hideTip" }]);
  });
  it("leaving a chart hides the tooltips of the others", () => {
    const a = fake(5, 0, 10), b = fake(5, 0, 10);
    hideHover(a, [a, b]);
    expect(b.actions).toEqual([{ type: "hideTip" }]);
    expect(a.actions).toEqual([]);
  });
});
