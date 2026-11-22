// Candles drawn from their centre: the wick is exactly in the middle of the body, at any body width, and the series is drawn at all.
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";
import "../components/EChart"; // registers the chart types
import { candleSeries } from "../lib/chartOptions";

echarts.use(SVGRenderer);
const colors = { up: "#0a0", down: "#a00", muted: "#888" };
type Item = { type: string; children?: Item[]; shape: Record<string, number>; style: Record<string, unknown> };

// a fake of the part of ECharts' custom-series api the renderer uses: category i is centred at x = 20 + 30 i, the band is `band` wide, price p is at y = 1000 - p
const api = (row: (number | null)[], band: number) => ({
  value: (d: number) => row[d] as number,
  coord: (v: [number, number]) => [20 + 30 * v[0], 1000 - v[1]],
  size: () => [band, 0],
});
const render = (row: (number | null)[], band: number, wick = true) => {
  const s = candleSeries("NIFTY", 0, 0, [], colors, wick) as unknown as { renderItem: (p: unknown, a: ReturnType<typeof api>) => Item | null };
  return s.renderItem({}, api(row, band));
};

describe("candleSeries", () => {
  it.each([3, 4.4, 5, 6.5, 7, 9.3, 12])("the wick is at the exact centre of the body for a band of %s px", (band) => {
    const g = render([2, 100, 110, 90, 120, 0], band)!;
    const wick = g.children!.find((c) => c.type === "line")!, body = g.children!.find((c) => c.type === "rect")!;
    expect(wick.shape.x1).toBe(wick.shape.x2);
    expect(body.shape.x! + body.shape.width! / 2).toBeCloseTo(wick.shape.x1!, 10); // centre of the body = the wick
    expect(wick.shape.x1).toBe(20 + 30 * 2); // and both on the centre of the category
  });
  it("the wick runs from the high to the low, the body from the open to the close, green when it closed higher and red when lower", () => {
    const up = render([0, 100, 110, 90, 120, 0], 8)!.children!;
    expect(up[0]!.shape).toMatchObject({ y1: 1000 - 120, y2: 1000 - 90 });
    expect(up[1]!.shape).toMatchObject({ y: 1000 - 110, height: 10 });
    expect(up[1]!.style.fill).toBe("#0a0");
    expect((render([0, 110, 100, 90, 120, 0], 8)!.children![1]!.style.fill)).toBe("#a00");
  });
  it("a doji keeps a visible body, a missing candle draws nothing, and the stand-in candle is an outline", () => {
    expect(render([0, 100, 100, 95, 105, 0], 8)!.children![1]!.shape.height).toBe(1);
    expect(render([0, null, null, null, null, 0], 8)).toBeNull();
    const out = render([0, 100, 110, 90, 120, 1], 8)!.children!;
    expect(out[1]!.style).toMatchObject({ fill: "rgba(0,0,0,0)", stroke: "#888" });
    expect(out[0]!.style.stroke).toBe("#888");
  });
  it("without a wick only the body is drawn (the Smart OI bar from zero)", () => {
    const g = render([0, 0, 50, 0, 50, 0], 8, false)!;
    expect(g.children).toHaveLength(1); expect(g.children![0]!.type).toBe("rect");
  });
  it("is drawn by ECharts: the custom series is registered", () => {
    const chart = echarts.init(null as unknown as HTMLElement, undefined, { renderer: "svg", ssr: true, width: 400, height: 300 });
    const s = candleSeries("NIFTY", 0, 0, [{ o: 100, c: 110, l: 95, h: 115 }, { o: 110, c: 100, l: 98, h: 112 }], colors);
    chart.setOption({ animation: false, xAxis: { type: "category", data: ["a", "b"] }, yAxis: { scale: true }, series: [s] });
    const svg = chart.renderToSVGString();
    chart.dispose();
    expect(svg).toContain("#0a0"); expect(svg).toContain("#a00"); // an up candle and a down candle
  });
});
