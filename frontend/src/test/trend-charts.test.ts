import { describe, expect, it } from "vitest";
import { barSeries, line, multiPanelOption, regimeAreas } from "../lib/trendCharts";

const c = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
type Opt = { grid: { top: number; height: number }[]; xAxis: { axisLabel: { show: boolean } }[]; series: { name: string; markArea?: { data: unknown[][] }; markLine?: { data: unknown[] } }[]; legend: { data: string[] }; dataZoom: { type: string; xAxisIndex: number[] }[]; axisPointer: { link: unknown[] } };

describe("trend charts", () => {
  it("shades runs of the same label, leaves the warm-up unshaded and fades weak and mixed labels", () => {
    const x = ["09:15", "09:20", "09:25", "09:30", "09:35", "09:40"];
    const a = regimeAreas(["Warming up", "Trending down", "Trending down", "Weak downtrend", "Mixed", "Mixed"], x, c);
    expect(a.map(([s, e]) => [s.name, s.xAxis, e.xAxis, s.itemStyle.color, s.itemStyle.opacity])).toEqual([
      ["Trending down", "09:20", "09:25", c.down, 0.2], ["Weak downtrend", "09:30", "09:30", c.down, 0.1], ["Mixed", "09:35", "09:40", c.muted, 0.07],
    ]);
  });

  it("stacks panels on one time axis with linked crosshair and zoom, labels only on the bottom axis, and keeps helper series out of the legend", () => {
    const x = ["a", "b", "c"];
    const areas = regimeAreas(["Range-bound", "Range-bound", "Mixed"], x, c);
    const { option, height } = multiPanelOption(c, x, [
      { title: "one", height: 200, series: [line("Price", [1, 2, 3], c.paper)], guides: [{ y: 2, label: "mid" }] },
      { title: "two", height: 100, series: [barSeries("Delta", [1, -1, null], (v) => (v >= 0 ? c.up : c.down))], zones: [{ from: 0, to: 1, color: c.info, label: "zone" }] },
    ], areas);
    const o = option as unknown as Opt;
    expect(o.grid).toHaveLength(2);
    expect(o.grid[1]!.top).toBeGreaterThan(o.grid[0]!.top + o.grid[0]!.height); // the panels do not overlap
    expect(o.xAxis.map((a) => a.axisLabel.show)).toEqual([false, true]);
    expect(o.legend.data).toEqual(["Price", "Delta"]);
    expect(o.axisPointer.link).toEqual([{ xAxisIndex: "all" }]);
    expect(o.dataZoom.map((d) => d.type)).toEqual(["inside", "slider"]);
    expect(o.dataZoom[0]!.xAxisIndex).toEqual([0, 1]);
    const panels = o.series.filter((s) => s.name.startsWith("__panel"));
    expect(panels).toHaveLength(2);
    expect(panels[0]!.markArea!.data).toHaveLength(2); // two runs of regime
    expect(panels[1]!.markArea!.data).toHaveLength(3); // the same two plus the value zone
    expect(panels[0]!.markLine!.data).toEqual([{ yAxis: 2, name: "mid" }]);
    expect(height).toBeGreaterThan(300);
  });

  it("a missing bar value stays a gap, not a zero", () => {
    const s = barSeries("d", [1, null], c.up)(0, 0) as unknown as { data: unknown[] };
    expect(s.data[1]).toBeNull();
  });
});
