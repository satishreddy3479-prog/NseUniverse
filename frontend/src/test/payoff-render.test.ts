// Renders the real payoff option with the real ECharts (server-side SVG, no DOM), because a mocked chart cannot
// show an option that makes ECharts throw. This once blanked the whole page.
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";
import { analyzeExpiry, payoffCurve, type Leg } from "../lib/strategy";
import { payoffOption } from "../lib/chartOptions";

echarts.use([LineChart, DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);
const colors = { up: "#2ad", down: "#f55", brass: "#cb4", info: "#49f", muted: "#889", rule: "#334", paper: "#eee", slate: "#112" };
const leg = (action: "BUY" | "SELL", type: "CE" | "PE", strike: number, premium: number, lots = 1): Leg => ({ id: `${action}${type}${strike}`, expiry: "2026-11-03", strike, type, action, lots, premium, premiumSource: "manual" });

function render(legs: Leg[], spot = 22937) {
  const a = analyzeExpiry(legs, 65);
  const ks = legs.map((l) => l.strike);
  const lo = Math.min(spot * 0.92, ...ks.map((k) => k * 0.97)), hi = Math.max(spot * 1.08, ...ks.map((k) => k * 1.03));
  const step = Math.max(1, Math.round((hi - lo) / 240));
  const curve = payoffCurve(legs, 65, Math.floor(lo / step) * step, hi, step);
  const chart = echarts.init(null as unknown as HTMLElement, undefined, { renderer: "svg", ssr: true, width: 800, height: 360 });
  chart.setOption(payoffOption({ expiry: curve, spot, breakevens: a.breakevens }, colors));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}

describe("the payoff chart renders with the real ECharts for every kind of payoff", () => {
  const cases: [string, Leg[]][] = [
    ["long call", [leg("BUY", "CE", 22950, 150)]],
    ["short call (all profit below the strike, unlimited loss above)", [leg("SELL", "CE", 22450, 500)]],
    ["short put", [leg("SELL", "PE", 22950, 140)]],
    ["long straddle", [leg("BUY", "CE", 22950, 150), leg("BUY", "PE", 22950, 140)]],
    ["iron condor", [leg("SELL", "PE", 22800, 90), leg("BUY", "PE", 22600, 40), leg("SELL", "CE", 23100, 90), leg("BUY", "CE", 23300, 40)]],
    ["a position that is a loss everywhere", [leg("BUY", "CE", 22950, 150), leg("SELL", "CE", 22950, 150, 2)]],
  ];
  for (const [name, legs] of cases) it(name, () => expect(render(legs)).toContain("<svg"));
});
