// Chart plumbing: every ECharts part the app's options use is registered, and a user's legend choice survives a live refresh.
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";
import { keepLegend, safeTooltips, withInactiveLegend } from "../components/EChart";
import { timeLinesOption } from "../lib/priceCharts"; // importing it registers the parts under test

echarts.use(SVGRenderer); // server-side rendering for the test only

describe("ECharts registration", () => {
  const svg = (option: Record<string, unknown>) => {
    const chart = echarts.init(null as unknown as HTMLElement, undefined, { renderer: "svg", ssr: true, width: 400, height: 300 });
    chart.setOption({ animation: false, xAxis: { type: "time" }, yAxis: {}, ...option });
    const out = chart.renderToSVGString();
    chart.dispose();
    return out;
  };
  const line = (extra: Record<string, unknown> = {}) => ({ type: "line", name: "Line", data: [[1000, 1], [2000, 2]], ...extra });

  it("a scatter series is drawn (the roll markers of the rolling straddle never appeared)", () => {
    const without = svg({ series: [line()] });
    const withScatter = svg({ series: [line(), { type: "scatter", name: "Rolls", symbolSize: 9, data: [[1500, 1.5]] }] });
    expect(withScatter.length).toBeGreaterThan(without.length + 20);
  });

  it("a graphic text corner is drawn", () => {
    expect(svg({ graphic: [{ type: "text", left: 10, top: 10, style: { text: "corner-text" } }], series: [line()] })).toContain("corner-text");
  });

  it("a mark point is drawn (the delta diamonds of the skew chart)", () => {
    const without = svg({ series: [line()] });
    const withMark = svg({ series: [line({ markPoint: { symbol: "diamond", symbolSize: 11, data: [{ coord: [1500, 1.5] }] } })] });
    expect(withMark.length).toBeGreaterThan(without.length + 20);
  });
});

describe("legend choices survive a refresh", () => {
  const opt = (nifty: boolean) => ({ legend: { selected: { Straddle: true, "NIFTY 50": nifty } }, series: [] });
  const sel = (o: unknown) => ((o as { legend: { selected: Record<string, boolean> } }).legend.selected);

  it("a series the user switched on stays on while the page keeps its default off", () => {
    const user: Record<string, boolean> = {};
    const defs: Record<string, boolean> = {};
    expect(sel(keepLegend(opt(false), user, defs))["NIFTY 50"]).toBe(false); // first draw: hidden by default
    user["NIFTY 50"] = true; // the user clicks it in the legend
    expect(sel(keepLegend(opt(false), user, defs))["NIFTY 50"]).toBe(true); // the next live refresh sends the default again: the click is kept
    user.Straddle = false; // and a series the user switched off stays off
    expect(sel(keepLegend(opt(false), user, defs))).toEqual({ Straddle: false, "NIFTY 50": true });
  });

  it("when the page itself changes a default (an external control), its intent wins", () => {
    const user: Record<string, boolean> = { "NIFTY 50": false };
    const defs: Record<string, boolean> = { "NIFTY 50": true };
    expect(sel(keepLegend(opt(false), user, defs))["NIFTY 50"]).toBe(false); // default changed true -> false by the page
    expect(user["NIFTY 50"]).toBeUndefined(); // the old user choice was dropped
  });

  it("options without a legend or without selected pass through unchanged, and arrays of legends are handled", () => {
    const plain = { series: [] };
    expect(keepLegend(plain, {}, {})).toBe(plain);
    const noSel = { legend: { top: 0 } };
    expect(keepLegend(noSel, {}, {})).toEqual(noSel);
    const arr = keepLegend({ legend: [{ selected: { A: false } }, { top: 1 }] }, { A: true }, { A: false }) as { legend: { selected?: Record<string, boolean> }[] };
    expect(arr.legend[0]!.selected).toEqual({ A: true });
    expect(arr.legend[1]!.selected).toBeUndefined();
  });
});

describe("legend choices with a real ECharts instance (the live-refresh scenario)", () => {
  type Chart = { setOption(o: unknown, opts?: unknown): void; dispatchAction(a: unknown): void; on(e: string, f: (p: { selected: Record<string, boolean> }) => void): void; getOption(): { legend: { selected: Record<string, boolean> }[] }; dispose(): void };
  const make = (): Chart => echarts.init(null as unknown as HTMLElement, undefined, { renderer: "svg", ssr: true, width: 400, height: 300 }) as unknown as Chart;
  const option = (niftyDefault: boolean) => ({
    animation: false, xAxis: { type: "time" }, yAxis: {}, legend: { selected: { Straddle: true, "NIFTY 50": niftyDefault } },
    series: [{ type: "line", name: "Straddle", data: [[1000, 1], [2000, 2]] }, { type: "line", name: "NIFTY 50", data: [[1000, 10], [2000, 20]] }],
  });

  it("without the memory a live refresh undoes the click (the reported bug)", () => {
    const c = make();
    c.setOption(option(false), { replaceMerge: ["series"] });
    c.dispatchAction({ type: "legendSelect", name: "NIFTY 50" });
    expect(c.getOption().legend[0]!.selected["NIFTY 50"]).toBe(true); // the click worked
    c.setOption(option(false), { replaceMerge: ["series"] }); // the next data refresh sends the default again
    expect(c.getOption().legend[0]!.selected["NIFTY 50"]).toBe(false); // ... and the click is gone
    c.dispose();
  });

  it("with the memory the click survives refreshes, and unselecting survives too", () => {
    const c = make();
    const user: Record<string, boolean> = {};
    const defs: Record<string, boolean> = {};
    c.on("legendselectchanged", (e) => Object.assign(user, e.selected));
    const draw = () => c.setOption(keepLegend(option(false) as never, user, defs), { replaceMerge: ["series"] });
    draw();
    c.dispatchAction({ type: "legendToggleSelect", name: "NIFTY 50" });
    draw();
    draw();
    expect(c.getOption().legend[0]!.selected["NIFTY 50"]).toBe(true);
    c.dispatchAction({ type: "legendToggleSelect", name: "Straddle" });
    draw();
    expect(c.getOption().legend[0]!.selected).toEqual({ Straddle: false, "NIFTY 50": true });
    c.dispose();
  });
});

describe("tooltips cannot freeze a chart", () => {
  const C = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
  it("an axis tooltip that meets a series that is not one of its lines (the roll markers) does not throw and names the roll", () => {
    const o = timeLinesOption([1000, 2000], [{ name: "Straddle", color: C.up, data: [1, 2], fmt: (v) => v.toFixed(1) }], C, null) as unknown as { tooltip: { formatter: (p: unknown) => string } };
    const html = o.tooltip.formatter([
      { axisValue: 1000, seriesName: "Straddle", value: [1000, 1], marker: "" },
      { axisValue: 1000, seriesName: "Rolls", value: [1000, 1], marker: "", data: { from: 25150, to: 25200 } },
      { axisValue: 1000, seriesName: "Mystery", value: [1000, 1], marker: "" },
    ]);
    expect(html).toContain("Straddle: 1.0");
    expect(html).toContain("Roll 25,150 → 25,200");
    expect(html).not.toContain("Mystery");
  });
  it("safeTooltips turns a throwing formatter (chart level or series level) into an empty tooltip", () => {
    const boom = () => { throw new Error("bad series"); };
    const o = safeTooltips({ tooltip: { trigger: "axis", formatter: boom }, series: [{ type: "line", tooltip: { formatter: boom } }, { type: "line" }] } as never) as unknown as {
      tooltip: { formatter: () => string }; series: { tooltip?: { formatter: () => string } }[] };
    expect(o.tooltip.formatter()).toBe("");
    expect(o.series[0]!.tooltip!.formatter()).toBe("");
    expect(o.series[1]!.tooltip).toBeUndefined();
    expect(safeTooltips({ series: [] } as never)).toEqual({ series: [] }); // an option without a tooltip passes through
  });
});

describe("switched-off legend entries stay readable", () => {
  it("every legend gets the theme's off colour unless it sets its own", () => {
    const o = withInactiveLegend({ legend: { top: 0 } } as never, "#73809a") as unknown as { legend: { inactiveColor: string; inactiveBorderColor: string } };
    expect(o.legend.inactiveColor).toBe("#73809a");
    expect(o.legend.inactiveBorderColor).toBe("#73809a");
    const own = withInactiveLegend({ legend: { inactiveColor: "#123456" } } as never, "#73809a") as unknown as { legend: { inactiveColor: string } };
    expect(own.legend.inactiveColor).toBe("#123456");
    const arr = withInactiveLegend({ legend: [{ top: 0 }, { top: 5 }] } as never, "#73809a") as unknown as { legend: { inactiveColor: string }[] };
    expect(arr.legend.map((l) => l.inactiveColor)).toEqual(["#73809a", "#73809a"]);
    const none = { series: [] };
    expect(withInactiveLegend(none as never, "#73809a")).toBe(none);
  });
});
