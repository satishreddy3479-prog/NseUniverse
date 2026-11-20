// Greeks and What-If: the small helpers and the chart builders, checked against real engine output (fixtures captured from the risk API on exact synthetic chains) and by hand.
import { describe, expect, it } from "vitest";
import type { ChartColors } from "../lib/chartOptions";
import { legsFromBuilder, num, rupees, stampText, versionLabel, volPct } from "../lib/risk";
import type { GridResult, RiskSurface } from "../lib/risk";
import { breakevens, colLabel, payoffOption, residualOption, riskMatrixOption, smileOption } from "../lib/riskCharts";
import type { Leg } from "../lib/strategy";
import gridIv from "./fixtures/risk/grid_spot_iv.json";
import payoffFx from "./fixtures/risk/grid_payoff.json";
import surfaceFx from "./fixtures/risk/surface.json";

const C: ChartColors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
const grid = gridIv.grid as unknown as GridResult;
const surface = surfaceFx as unknown as RiskSurface;
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("formatting", () => {
  it("rupees, numbers and volatilities: a missing value is a dash, never zero, and the minus is a true minus", () => {
    expect(rupees(null)).toBe("—");
    expect(rupees(1234.5)).toBe("+₹1,235");
    expect(rupees(-99.5)).toBe("−₹99.50");
    expect(rupees(-1234567)).toBe("−₹12,34,567"); // Indian grouping
    expect(rupees(0)).toBe("₹0.00");
    expect(rupees(250000, false)).toBe("₹2,50,000");
    expect(num(null)).toBe("—");
    expect(num(-0.1234, 3, true)).toBe("−0.123");
    expect(num(2.5, 1, true)).toBe("+2.5");
    expect(volPct(0.15234)).toBe("15.23%");
    expect(volPct(null)).toBe("—");
  });

  it("the stamp reads 'Greeks as of HH:MM:SS IST, surface vN' and the full id stays in the title", () => {
    const s = { as_of_ist: "2026-10-28T11:00:00+05:30", surface_version_id: "v12-ab34cd56ef78" };
    expect(stampText(s)).toBe("Greeks as of 11:00:00 IST, surface v12");
    expect(versionLabel("v12-ab34cd56ef78")).toBe("v12");
    expect(versionLabel(null)).toBe("—");
    expect(stampText(null)).toBe("No surface yet");
    expect(stampText({ as_of_ist: "2026-10-28T05:30:00Z", surface_version_id: "v1-x" })).toBe("Greeks as of 11:00:00 IST, surface v1"); // a UTC time is shown in IST
  });

  it("the Strategy Builder's legs become API legs: disabled and zero-lot legs are left out, the premium is the entry price", () => {
    const l = (o: Partial<Leg>): Leg => ({ id: "x", expiry: "2026-11-03", strike: 25500, type: "CE", action: "SELL", lots: 2, premium: 140, premiumSource: "manual", ...o });
    const out = legsFromBuilder([l({}), l({ id: "b", enabled: false }), l({ id: "c", lots: 0 }), l({ id: "d", type: "PE", action: "BUY", premium: null, lots: 1.4 })]);
    expect(out).toEqual([
      { expiry: "2026-11-03", strike: 25500, type: "CE", action: "SELL", lots: 2, entry_price: 140 },
      { expiry: "2026-11-03", strike: 25500, type: "PE", action: "BUY", lots: 1, entry_price: null },
    ]);
    expect(legsFromBuilder(null)).toEqual([]);
  });
});

describe("risk matrix", () => {
  it("one cell for every value, red and green symmetrical about zero, the labels with the forward, and the centre cell zero", () => {
    const o = riskMatrixOption(grid, 25500, C) as Obj;
    const data = o.series[0].data as [number, number, number][];
    expect(data).toHaveLength(grid.row_axis.length * grid.col_axis.length); // 5 x 3
    const big = Math.max(...grid.pnl.flat().map((v) => Math.abs(v as number)));
    expect(o.visualMap.max).toBeCloseTo(big, 9);
    expect(o.visualMap.min).toBeCloseTo(-big, 9);
    expect(o.visualMap.inRange.color).toEqual([C.down, C.slate, C.up]);
    expect(o.xAxis.data).toEqual(["−5", "0", "+5"]);
    expect(o.yAxis.data[2]).toBe("25,500 (0)");
    expect(o.yAxis.data[0]).toBe("25,200 (−300)");
    expect(data.find(([x, y]) => x === 1 && y === 2)![2]).toBe(0); // no spot move, no volatility move: no change
    expect(o.series[0].label.show).toBe(true); // a small grid shows its numbers
    expect(o.tooltip.formatter({ value: [2, 3, 1234.5] })).toContain("+₹1,235");
  });

  it("a cell that could not be valued is a gap, not a zero", () => {
    const g = { ...grid, pnl: grid.pnl.map((r, i) => (i === 1 ? r.map(() => null) : r)) } as GridResult;
    const data = (riskMatrixOption(g, null, C) as Obj).series[0].data as unknown[];
    expect(data).toHaveLength(12);
    expect((riskMatrixOption({ ...g, pnl: g.pnl.map((r) => r.map(() => null)) } as GridResult, null, C) as Obj).visualMap.max).toBe(1); // nothing to scale: a harmless default
  });

  it("column labels: volatility points with signs, elapsed time in hours then days", () => {
    expect(colLabel("iv_points", 5)).toBe("+5");
    expect(colLabel("iv_points", -2.5)).toBe("−2.5");
    expect(colLabel("iv_points", 0)).toBe("0");
    expect(colLabel("hours", 0)).toBe("now");
    expect(colLabel("hours", 12)).toBe("+12h");
    expect(colLabel("hours", 36.5)).toBe("+36.5h");
    expect(colLabel("hours", 72)).toBe("+3.0d");
  });
});

describe("payoff", () => {
  it("breakevens by interpolation: by hand, an exact zero, and gaps", () => {
    expect(breakevens([0, 1, 2], [-2, 2, 6])).toEqual([0.5]); // zero a quarter of the way... a / (a - b) = -2 / -4 = 0.5
    expect(breakevens([100, 200, 300], [-10, 30, -10])).toEqual([125, 275]);
    expect(breakevens([0, 1, 2], [0, 5, 6])).toEqual([0]); // starts on zero
    expect(breakevens([0, 1, 2], [-1, null, 3])).toEqual([]); // a gap in the middle: no crossing is invented
    expect(breakevens([0, 1], [1, 2])).toEqual([]);
  });

  it("levels are forward plus shock, today's line is dashed, the standard deviation bands and breakeven diamonds are marked", () => {
    const at = payoffFx.grid as unknown as GridResult;
    const now = { shocks: grid.row_axis, pnl: grid.pnl.map((r) => r[1] ?? null) };
    const o = payoffOption({ atExpiry: at, now, forward: 25500, sd1: 300, sd2: 600, colors: C }) as Obj;
    expect(o.series).toHaveLength(2);
    expect(o.series[0].data.map((p: number[]) => p[0])).toEqual(at.row_axis.map((v) => 25500 + v));
    expect(o.series[1].lineStyle.type).toBe("dashed");
    expect(o.series[0].markArea.data).toHaveLength(3); // the two outer bands and the inner one
    expect(o.series[0].markArea.data[2][0].xAxis).toBe(25200); // 25,500 - 300
    expect(o.series[0].markArea.data[2][1].xAxis).toBe(25800);
    expect(o.series[0].markLine.data[0]).toEqual({ yAxis: 0 });
    const ys = at.pnl.map((r) => r[0] ?? null);
    expect(o.series[0].markPoint.data).toHaveLength(breakevens(at.row_axis.map((v) => 25500 + v), ys).length);
    const bare = payoffOption({ atExpiry: at, now: null, forward: null, sd1: null, sd2: null, colors: C }) as Obj;
    expect(bare.series).toHaveLength(1);
    expect(bare.series[0].markArea.data).toHaveLength(0); // no bands without a standard deviation
  });
});

describe("volatility surface charts", () => {
  const rows = surface.strikes.filter((x) => x.expiry === "2026-11-03");

  it("the smile: fitted line from the used and flagged strikes, the used quotes as dots, volatilities in percent, the forward as a line", () => {
    const o = smileOption(rows, 25500, C) as Obj;
    const used = rows.filter((x) => x.status === "used");
    expect(used.length).toBeGreaterThan(5);
    expect(o.series[1].data).toHaveLength(used.length);
    expect(o.series[1].data[0][1]).toBeCloseTo(used.sort((a, b) => a.strike - b.strike)[0]!.iv! * 100, 9);
    expect(o.series[0].data).toHaveLength(used.length); // nothing flagged in this surface
    expect(o.series[0].markLine.data[0].xAxis).toBe(25500);
    expect(o.series[2].name).toBe("Flagged (arbitrage)");
    expect(o.series[2].data).toHaveLength(0);
    const sorted = o.series[0].data.map((p: number[]) => p[0]);
    expect(sorted).toEqual([...sorted].sort((a: number, b: number) => a - b)); // the curve runs left to right
    expect((smileOption(rows, null, C) as Obj).series[0].markLine).toBeUndefined();
  });

  it("flagged and unused points are drawn apart, a missing volatility is left out", () => {
    const base = rows.find((x) => x.status === "used")!;
    const flagged = { ...base, strike: 99999, status: "flagged" as const, reason: "butterfly: negative convexity" };
    const rejected = { ...base, strike: 88888, status: "rejected" as const, iv: null, fit_iv: null, residual_vol_pts: null };
    const o = smileOption([...rows, flagged, rejected], 25500, C) as Obj;
    expect(o.series[2].data).toEqual([[99999, flagged.iv! * 100]]);
    expect(o.series[0].data.some((p: number[]) => p[0] === 88888)).toBe(false);
    expect(JSON.stringify(o.series[1].data)).not.toContain("88888");
  });

  it("residuals: bars in volatility points, flagged strikes red, large ones brass, the degradation limit as lines", () => {
    const base = rows.find((x) => x.status === "used")!;
    const big = { ...base, strike: 25001, residual_vol_pts: 0.9 };
    const flagged = { ...base, strike: 25002, status: "flagged" as const, residual_vol_pts: 0.2 };
    const o = residualOption([...rows, big, flagged], 0.5, C) as Obj;
    const bars = o.series[0].data as { value: number; itemStyle: { color: string } }[];
    expect(o.xAxis.data).toEqual([...o.xAxis.data].sort((a: string, b: string) => Number(a) - Number(b)));
    expect(bars[o.xAxis.data.indexOf("25001")]!.itemStyle.color).toBe(C.brass);
    expect(bars[o.xAxis.data.indexOf("25002")]!.itemStyle.color).toBe(C.down);
    expect(bars[o.xAxis.data.indexOf(String(base.strike))]!.itemStyle.color).toBe(C.info);
    expect(o.series[0].markLine.data).toEqual([{ yAxis: 0.5 }, { yAxis: -0.5 }]);
    expect(o.tooltip.valueFormatter(-0.1234)).toBe("−0.123 vol pts");
  });
});
