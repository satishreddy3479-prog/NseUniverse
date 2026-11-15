import { describe, expect, it } from "vitest";
import { fitLayout, fitNarrow, legendBox } from "../components/EChart";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// jsdom has no canvas, so text is measured as 0.58 em per character: a 20-character legend entry at 12 px is 139.2 px wide.
const name = (i: number) => `series number ${String(i).padStart(2, "0")}!!!!`; // 20 characters
const names = [1, 2, 3, 4, 5, 6].map(name);

describe("legend and plot do not collide", () => {
  it("counts the rows a wrapped legend takes, as ECharts packs them", () => {
    // one entry = 25 symbol + 5 gap + 139.2 text = 169.2, plus the 10 px item gap; two do not fit in 337 - 10 = 327 px, so six entries are six rows
    const b = legendBox({}, names, 337);
    expect(b.rows).toBe(6);
    expect(b.height).toBeCloseTo(6 * 14 + 5 * 10 + 10); // rows x item height + gaps between rows + padding
    expect(legendBox({}, names, 1200).rows).toBe(1); // wide: one row
  });

  it("moves a grid that starts inside the legend below it and keeps its bottom where it was", () => {
    const o = fitLayout({ legend: { top: 0 }, grid: { top: 40, height: 300, left: 40, right: 20 }, series: names.map((n) => ({ name: n })) } as never, 337, 400) as Obj;
    const need = 6 * 14 + 5 * 10 + 10 + 14; // legend bottom + room for the top axis label
    expect(o.grid.top).toBe(need);
    expect(o.grid.top + o.grid.height).toBe(40 + 300); // bottom unchanged
  });

  it("leaves a grid that already clears the legend alone", () => {
    const g = { top: 90, left: 40, right: 20 };
    const o = fitLayout({ legend: { top: 0 }, grid: g, series: [{ name: "a" }, { name: "b" }] } as never, 800, 400) as Obj;
    expect(o.grid).toEqual(g);
  });

  it("stacks a corner readout under the legend and pulls it inside the chart", () => {
    const o = fitLayout({
      legend: { top: 0 }, grid: { top: 34, left: 58, right: 62 }, series: [{ name: "a" }, { name: "b" }],
      graphic: [{ type: "text", left: 64, top: 8, style: { text: "Since previous session close (2026-11-11): +1.09 L", font: "600 11px sans-serif" } }],
    } as never, 337, 300) as Obj;
    const legendBottom = 14 + 10; // one row
    expect(o.graphic[0].top).toBe(legendBottom + 2);
    expect(o.graphic[0].left + 50 * 11 * 0.58).toBeLessThanOrEqual(337); // the readout ends inside the chart (about 50 characters at 11 px)
    expect(o.grid.top).toBeGreaterThanOrEqual(o.graphic[0].top + 15); // the plot starts below the readout
  });
});

describe("axes and tags", () => {
  it("drops overlapping axis labels and thins a narrow time axis", () => {
    const o = fitLayout({ grid: { left: 46, right: 14, top: 40 }, xAxis: { type: "time" }, yAxis: { type: "value" } } as never, 337, 300) as Obj;
    expect(o.xAxis.axisLabel.hideOverlap).toBe(true);
    expect(o.yAxis.axisLabel.hideOverlap).toBe(true);
    expect(o.xAxis.splitNumber).toBe(Math.floor((337 - 60) / 78));
  });

  it("raises a right margin that is too small for the end label", () => {
    const o = fitLayout({ grid: { left: 46, right: 14, top: 40 }, series: [{ endLabel: { show: true, formatter: "30 d 15.7", fontSize: 10 } }] } as never, 337, 300) as Obj;
    expect(o.grid.right).toBe(Math.ceil("30 d 15.7".length * 10 * 0.58 + 10)); // text width + 10 px
  });
});

describe("narrow charts use their width", () => {
  const tagged = (over: Obj = {}) => ({
    legend: { top: 0 },
    grid: { left: 58, right: 132, top: 34 },
    yAxis: [{ position: "left" }, { position: "right", axisLabel: { margin: 70 } }],
    series: [
      { name: "Rolling", data: [[1, 290], [2, 299.99], [3, null]], endLabel: { show: true, fontSize: 11, formatter: (p: { value: [number, number | null] }) => (p.value[1] ?? 0).toFixed(2) } },
      { name: "Fixed", data: [[1, 280], [2, 292.14]], endLabel: { show: true, fontSize: 11, formatter: (p: { value: [number, number | null] }) => (p.value[1] ?? 0).toFixed(2) } },
    ],
    ...over,
  });

  it("moves the latest-value tags into the legend text and gives their column to the plot", () => {
    const o = fitNarrow(tagged() as never, 375) as Obj;
    expect(o.series.every((x: Obj) => x.endLabel.show === false)).toBe(true);
    expect(o.legend.formatter("Rolling")).toBe("Rolling  299.99"); // the last real point, not the trailing gap
    expect(o.legend.formatter("Fixed")).toBe("Fixed  292.14");
    expect(o.legend.formatter("Other")).toBe("Other"); // an entry without a tag is untouched
    expect(o.grid.right).toBe(14); // nothing is left at the right of the plot, so the margin is only a small gutter
    expect(o.grid.left).toBe(46);
  });
  it("keeps the tags when there is no legend to carry them", () => {
    const o = fitNarrow(tagged({ legend: undefined }) as never, 375) as Obj;
    expect(o.series.every((x: Obj) => x.endLabel.show === true)).toBe(true);
    expect(o.grid.right).toBe(54);
  });
  it("keeps the room for a right axis whose numbers are shown", () => {
    const o = fitNarrow({ grid: { left: 58, right: 80 }, yAxis: [{ position: "left" }, { position: "right" }], series: [{ name: "a", data: [1] }] } as never, 375) as Obj;
    expect(o.grid.right).toBe(66);
  });
  it("a chart with nothing at its right edge takes the whole width", () => {
    const o = fitNarrow({ grid: { left: 62, right: 78 }, yAxis: { type: "value" }, series: [{ name: "a", data: [1] }] } as never, 375) as Obj;
    expect(o.grid).toMatchObject({ left: 46, right: 14 });
  });
  it("a tag drawn above its end point does not claim a column at the right", () => {
    const above = { grid: { left: 74, right: 24 }, series: [{ name: "a", data: [1], endLabel: { show: true, position: "top", formatter: "+₹13,300", fontSize: 11 } }] };
    expect((fitNarrow(above as never, 375) as Obj).grid.right).toBe(14);
    expect((fitLayout(above as never, 700, 300) as Obj).grid.right).toBe(24); // and the wide layout does not raise the margin for it either
  });
  it("leaves wide charts alone", () => {
    const opt = tagged();
    expect(fitNarrow(opt as never, 900)).toBe(opt);
  });
  it("counts the legend rows with the latest values it now carries, so a wrapped legend still gets its room", () => {
    // jsdom measures 0.58 em per character: two 12-character entries fit one row of 300 px; with "  299.99" added to each they need two
    const plain = { top: 0, textStyle: { fontSize: 12 }, itemWidth: 14, itemGap: 10, padding: 5 };
    const withValues = { ...plain, formatter: (n: string) => `${n}  299.99` };
    const nm = ["Rolling ATM!", "Fixed 25150!"];
    expect(legendBox(plain, nm, 300).rows).toBe(1);
    expect(legendBox(withValues, nm, 300).rows).toBe(2);
  });
});
