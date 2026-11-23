// The divergence signals in the lower panel of the Smart OI chart, in place of the volume bars.
import { describe, expect, it } from "vitest";
import { smartOiOption } from "../lib/chartOptions";
import type { SmartOiCandle, SmartOiResult } from "../lib/optionTools";

const colors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
const closes = [100, 101, 102, 101, null, null];
const res = (tf: number): SmartOiResult => ({
  day: "2026-11-23", timeframe: tf, baselineAt: null, gapCandles: 0, skippedSamples: 0, strikeChangeCandles: 0, stalls: [], thinBars: 0, unconfirmedBars: [], proxyMinutes: 0, indicativeMinutes: 0, jumps: [],
  candles: closes.map((c, i) => ({
    slot: i, label: `09:${String(15 + i * tf).padStart(2, "0")}`, spot: c == null ? null : { open: c, high: c + 0.5, low: c - 0.5, close: c }, spotFromBars: true, spotProxy: false,
    ceOi: 10, peOi: 10, dPe: 1, dCe: 1, p: 0, bullish: null, span: 1, peDay: 0, ceDay: 0, diffDay: 0, pcr: 1, volPcr: 1, ceVol: null, peVol: null, ceVolDelta: 5, peVolDelta: 6, fromPrevClose: false, strikesChanged: false,
  }) as SmartOiCandle),
}) as SmartOiResult;
const burst = (id: string, i: number, direction: "bullish" | "bearish" | "neutral", extra: object = {}) => ({ id, i, direction, at: `09:${15 + i}`, lastAt: `09:${15 + i}`, count: 1, lastI: i, state: "confirmed", text: `${id} text`, title: id, strength: 0.5, evidence: {}, ...extra }) as never;
type Opt = { series: { name: string; type: string; data: unknown[]; xAxisIndex?: number }[]; grid: { height: string }[]; xAxis: unknown[]; legend: { data: unknown[] }; title: { text: string }[]; tooltip: { formatter: (p: unknown) => string } };

describe("Smart OI chart: lower panel", () => {
  it("with no signals panel the volume bars are the third panel, as before", () => {
    const o = smartOiOption(res(3), colors) as unknown as Opt;
    expect(o.series.map((s) => s.name)).toEqual(["NIFTY", "Smart OI", "Put volume", "Call volume"]);
    expect(o.grid[2]!.height).toBe("15%");
    expect(o.title[2]!.text).toContain("Volume per candle");
  });
  it("with the panel the third panel is the NIFTY close with one marker per signal candle, on the same candle axis as the two above, and no volume bars", () => {
    const bursts = [burst("zone", 1, "bullish"), burst("pcr", 2, "bearish"), burst("momentum", 2, "bullish"), burst("flow", 3, "bearish", { state: "failed" }), burst("future", 5, "bearish"), burst("conviction", 0, "neutral")];
    const o = smartOiOption(res(1), colors, { bursts, signals: [] }) as unknown as Opt;
    const by = Object.fromEntries(o.series.map((s) => [s.name, s]));
    expect(o.series.some((s) => s.name === "Put volume")).toBe(false);
    expect(by["NIFTY close"]!.data).toEqual([[0, 100], [1, 101], [2, 102], [3, 101], [4, null], [5, null]]);
    expect(by["NIFTY close"]!.xAxisIndex).toBe(2);
    expect(o.xAxis).toHaveLength(3); // one candle axis for the three panels: the crosshair and the zoom run through all of them
    expect(by["bullish"]!.data).toEqual([{ value: [1, 101], itemStyle: undefined }]); // zone alone at candle 1
    expect(by["neutral"]!.data.map((d) => (d as { value: number[] }).value).sort((a, b) => a[0]! - b[0]!)).toEqual([[0, 100], [2, 102]]); // conviction alone has no direction; pcr bearish and momentum bullish on candle 2 disagree
    const bear = by["bearish"]!.data as { value: number[]; itemStyle?: { color: string } }[];
    expect(bear.map((d) => d.value)).toEqual([[3, 101]]); // the signal on candle 5 has no index price (after the cash close): nowhere to sit
    expect(bear[0]!.itemStyle?.color).toBe("transparent"); // a failed flow divergence is hollow
    expect(o.legend.data).toEqual(["NIFTY close", "bullish", "bearish", "neutral"]);
    expect(o.grid[2]!.height).toBe("20%");
    expect(o.title[2]!.text).toContain("Divergence signals");
  });
  it("the tooltip of a candle lists the signals that started on it, and only that candle", () => {
    const o = smartOiOption(res(3), colors, { bursts: [burst("pcr", 2, "bearish"), burst("momentum", 2, "bullish", { count: 3 })], signals: [] }) as unknown as Opt;
    const at2 = o.tooltip.formatter([{ dataIndex: 2 }]);
    expect(at2).toContain("Signals started here");
    expect(at2).toContain("pcr text");
    expect(at2).toContain("×3");
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).not.toContain("Signals started here");
  });
  it("the two swings of a flow divergence are joined by a dashed line on the price panel", () => {
    const sig = [{ id: "flow", i: 3, direction: "bearish", link: { a: 0, b: 2, price: "high" } }] as never;
    const o = smartOiOption(res(3), colors, { bursts: [], signals: sig }) as unknown as Opt;
    const link = o.series.find((s) => s.name === "link")!;
    expect(link.data).toEqual([[0, 100.5], [2, 102.5]]);
    expect(link.xAxisIndex).toBe(2);
  });
});

describe("Smart OI chart: trend regime shading", () => {
  const areas = (o: Opt) => (o.series.find((x) => x.name === "Regime") as unknown as { markArea: { data: { xAxis: string; name?: string }[][] } } | undefined)?.markArea.data;
  it("shades each run of the same label from its first to its last candle, leaves the warm-up unshaded, and offers a legend entry", () => {
    const o = smartOiOption(res(3), colors, null, ["Warming up", "Range-bound", "Range-bound", "Trending up", "Trending up", null]) as unknown as Opt;
    expect(areas(o)!.map(([a, b]) => [a!.name, a!.xAxis, b!.xAxis])).toEqual([["Range-bound", "09:18", "09:21"], ["Trending up", "09:24", "09:27"]]);
    expect(o.legend.data).toContainEqual({ name: "Regime", itemStyle: { color: colors.info } });
  });
  it("with no regime (no index bars) there is nothing to shade and no legend entry", () => {
    const o = smartOiOption(res(3), colors) as unknown as Opt;
    expect(areas(o)).toBeUndefined();
    expect(o.legend.data).not.toContainEqual(expect.objectContaining({ name: "Regime" }));
  });
});

