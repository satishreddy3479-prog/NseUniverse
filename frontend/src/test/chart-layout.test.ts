import { describe, expect, it } from "vitest";
import { fitLayout, legendBox } from "../components/EChart";

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
