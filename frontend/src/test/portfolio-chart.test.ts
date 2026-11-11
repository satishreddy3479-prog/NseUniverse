// Portfolio equity chart: the option is built from the stats with hand-checked numbers, and it really renders (real ECharts, server-side).
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";
import "../components/EChart"; // registers the chart parts the option uses
import { money, portfolioEquityOption, shortDay } from "../lib/portfolioCharts";
import { portfolioStats } from "../lib/portfolioStats";

echarts.use(SVGRenderer);
const C = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
const c = (id: string, closedAt: string, pnl: number) => ({ id, name: `Strategy ${id}`, closedAt, pnl });
// in time order: +1000, +500, -2000, -300, +4000  => cumulative 1000, 1500, -500, -800, 3200 ; peak 1500 then 3200 ; drawdown 0, 0, 2000, 2300, 0
const SET = [c("a", "2026-11-03T05:00:00Z", 1000), c("b", "2026-11-03T06:00:00Z", 500), c("d", "2026-11-04T05:00:00Z", -2000), c("e", "2026-11-05T05:00:00Z", -300), c("g", "2026-11-06T05:00:00Z", 4000)];
type Opt = { series: { data: unknown[]; name: string }[]; xAxis: { data: string[] }[]; tooltip: { formatter: (p: unknown) => string }; grid: { top: number; height: number }[] };

describe("portfolio equity option", () => {
  const stats = portfolioStats(SET);
  const o = portfolioEquityOption(stats, C) as unknown as Opt;
  it("one position per close after the start, shared by the three panels", () => {
    expect(o.xAxis).toHaveLength(3);
    for (const x of o.xAxis) expect(x.data).toEqual(["Start", "#1", "#2", "#3", "#4", "#5"]);
  });
  it("cumulative P&L, per-close results and drawdown are the booked figures (drawdown is negative, start is zero)", () => {
    const eq = o.series[0]!.data as { value: number; itemStyle: { color: string } }[];
    expect(eq.map((d) => d.value)).toEqual([0, 1000, 1500, -500, -800, 3200]);
    expect(eq.map((d) => d.itemStyle.color)).toEqual([C.muted, C.up, C.up, C.down, C.down, C.up]); // a dot is green above zero, red below it, grey at zero
    expect((o.series[1]!.data as ({ value: number } | null)[]).map((d) => (d == null ? null : d.value))).toEqual([null, 1000, 500, -2000, -300, 4000]);
    expect(o.series[2]!.data).toEqual([0, -0, -0, -2000, -2300, -0]);
  });
  it("the cumulative P&L and the drawdown are plain lines between the closes, not steps", () => {
    for (const i of [0, 2]) expect((o.series[i] as unknown as { type: string; step?: unknown }).step).toBeUndefined();
    expect(o.series[0]!.name).toBe("Cumulative closed P&L");
  });
  it("per-close bars are green for a win and red for a loss", () => {
    const bars = o.series[1]!.data as ({ value: number; itemStyle: { color: string } } | null)[];
    expect(bars.slice(1).map((b) => b!.itemStyle.color)).toEqual([C.up, C.up, C.down, C.down, C.up]);
  });
  it("the tooltip names the strategy, its time, result, cumulative and drawdown", () => {
    const t = o.tooltip.formatter([{ dataIndex: 3 }]);
    expect(t).toContain("#3 · Strategy d");
    expect(t).toContain("−₹2,000"); // the result
    expect(t).toContain("−₹500"); // cumulative after it: 1500 - 2000
    expect(t).toContain("−₹2,000"); // drawdown from the 1500 peak: 1500 - (-500)
    expect(o.tooltip.formatter([{ dataIndex: 5 }])).toContain("at a new high");
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain("Start");
  });
  it("the panels do not overlap and the drawdown axis has room for its labels", () => {
    const [eq, bars, dd] = o.grid as { top: number; height: number }[] as [typeof o.grid[0], typeof o.grid[0], typeof o.grid[0]];
    expect(eq.top + eq.height).toBeLessThan(bars.top);
    expect(bars.top + bars.height).toBeLessThan(dd.top);
    expect(dd.height).toBeGreaterThanOrEqual(50);
  });
  it("a strategy list with no drawdown marks no worst point", () => {
    const up = portfolioEquityOption(portfolioStats([c("a", "2026-11-03T05:00:00Z", 100), c("b", "2026-11-04T05:00:00Z", 50)]), C) as unknown as { series: { markPoint?: { data: unknown[] } }[] };
    expect(up.series[2]!.markPoint!.data).toEqual([]);
  });
  it("renders with real ECharts: titles, the bars and the drawdown are drawn", () => {
    const chart = echarts.init(null as unknown as HTMLElement, undefined, { renderer: "svg", ssr: true, width: 700, height: 470 });
    chart.setOption(portfolioEquityOption(stats, C));
    const svg = chart.renderToSVGString();
    chart.dispose();
    for (const text of ["Cumulative closed P&amp;L", "Result of each closed strategy", "Drawdown from peak"]) expect(svg).toContain(text);
  });
});

describe("formatting helpers", () => {
  it("rupees with sign and the day in IST", () => {
    expect(money(1453)).toBe("+₹1,453");
    expect(money(-936)).toBe("−₹936");
    expect(money(-936, false)).toBe("−₹936");
    expect(money(0)).toBe("₹0");
    expect(money(null)).toBe("—");
    expect(shortDay(Date.parse("2026-11-03T20:00:00Z"))).toBe("4 Nov"); // 01:30 IST the next day
    expect(shortDay(Date.parse("2026-11-03T05:00:00Z"))).toBe("3 Nov");
  });
});
