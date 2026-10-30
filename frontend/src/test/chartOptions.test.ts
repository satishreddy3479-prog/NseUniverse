import { describe, expect, it } from "vitest";
import {
  sentimentHistoryOption,
  decayOption, oiChangeBarOption, oiSeriesOption, oiExplorerOption, oiHeatmapOption, premiumOption, spotOption, straddleOption,
  strikeBarOption, totalsBarOption,
} from "../lib/chartOptions";
import { computeTotals } from "../lib/analytics";
import { bigChain } from "./fixtures";
import type { Observation, OiChange, OiHeatmap, OiRow, OiSeries, PremiumDecay } from "../lib/types";

const colors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
const rows = bigChain().snapshot.rows;
type Series = { name: string; data: unknown[]; markLine?: { data: { xAxis?: string; name: string }[] } }[];
const series = (o: unknown) => (o as { series: Series }).series;

function obs(i: number, over: Partial<Observation> = {}): Observation {
  return {
    snapshot_id: `s${i}`, retrieved_at: `2026-10-28T0${i}:00:00Z`, session_id: "x", underlying_ltp: 22700 + i,
    underlying_prev_close: 22750, atm_strike: 22700, atm_call_ltp: 100, atm_put_ltp: 110, straddle: 210,
    total_ce_premium: 1000 - i * 10, total_pe_premium: 2000 - i * 20, total_ce_oi: 1, total_pe_oi: 1,
    total_ce_volume: 1, total_pe_volume: 1, strikes_in_universe: 21, missing_ltp: 0, same_as_previous: false, ...over,
  };
}

describe("strikeBarOption", () => {
  const base = { rows, metric: "oi" as const, atmStrike: 24050, selectedStrike: null, showCalls: true, showPuts: true, colors };

  it("plots one bar per strike for calls and puts, in strike order", () => {
    const o = strikeBarOption(base) as { xAxis: { data: string[] } };
    expect(o.xAxis.data).toEqual(rows.map((r) => String(r.strike)));
    const s = series(o);
    expect(s.map((x) => x.name)).toEqual(["Calls (CE)", "Puts (PE)"]);
    expect(s[0]!.data).toEqual(rows.map((r) => r.call!.oi));
  });

  it("uses OI change or volume for the other metrics", () => {
    expect(series(strikeBarOption({ ...base, metric: "oiChange" }))[0]!.data[0]).toBe(100);
    expect(series(strikeBarOption({ ...base, metric: "volume" }))[0]!.data[0]).toBe(10);
  });

  it("marks ATM and the selected strike", () => {
    const o = series(strikeBarOption({ ...base, selectedStrike: 24150 }));
    const names = o[0]!.markLine!.data.map((d) => `${d.name}:${d.xAxis}`);
    expect(names).toEqual(["ATM:24050", "Selected:24150"]);
  });

  it("keeps the marker lines when calls are hidden", () => {
    const s = series(strikeBarOption({ ...base, showCalls: false }));
    expect(s.map((x) => x.name)).toEqual(["Puts (PE)"]);
    expect(s[0]!.markLine!.data[0]!.name).toBe("ATM");
  });

  it("drops a series when its toggle is off, and shows nothing when both are off", () => {
    expect(series(strikeBarOption({ ...base, showPuts: false })).map((x) => x.name)).toEqual(["Calls (CE)"]);
    expect(series(strikeBarOption({ ...base, showCalls: false, showPuts: false }))).toEqual([]);
  });

  it("leaves a gap (null) for a missing value instead of drawing zero", () => {
    const withGap = rows.map((r, i) => (i === 1 ? { ...r, call: { ...r.call!, oi: null } } : r));
    expect(series(strikeBarOption({ ...base, rows: withGap }))[0]!.data[1]).toBeNull();
  });

  it("ignores an ATM strike that is not in view", () => {
    const s = series(strikeBarOption({ ...base, atmStrike: 99999 }));
    expect(s[0]!.markLine).toBeUndefined();
  });
});

describe("totalsBarOption", () => {
  it("plots CE and PE totals from the same rows as the table footer", () => {
    const t = computeTotals(rows);
    const s = series(totalsBarOption({ totals: t, metric: "oi", showCalls: true, showPuts: true, colors }));
    const data = s[0]!.data as { name: string; value: number }[];
    expect(data).toEqual([expect.objectContaining({ name: "CE", value: 7000 }), expect.objectContaining({ name: "PE", value: 7000 })]);
  });
  it("respects the toggles", () => {
    const t = computeTotals(rows);
    const s = series(totalsBarOption({ totals: t, metric: "oiChange", showCalls: false, showPuts: true, colors }));
    expect((s[0]!.data as { name: string }[]).map((d) => d.name)).toEqual(["PE"]);
  });
});

describe("time series from stored snapshots", () => {
  const list = [obs(1), obs(2), obs(3)];

  it("plots premium per observation, CE and PE separately", () => {
    const s = series(premiumOption(list, colors));
    expect(s.map((x) => x.name)).toEqual(["CE total premium", "PE total premium"]);
    expect((s[0]!.data[1] as [number, number])[1]).toBe(980);
    expect((s[1]!.data[2] as [number, number])[1]).toBe(1940);
  });

  it("plots a missing premium as a gap", () => {
    const s = series(premiumOption([obs(1), obs(2, { total_ce_premium: null })], colors));
    expect((s[0]!.data[1] as [number, number | null])[1]).toBeNull();
  });

  it("a sample that sums fewer contracts than the best one is a gap, not a jump; no dots are drawn", () => {
    const s = series(premiumOption([obs(1, { missing_ltp: 0 }), obs(2, { missing_ltp: 3 }), obs(3, { missing_ltp: 0 })], colors));
    expect(s[0]!.data.map((d) => (d as [number, number | null])[1] === null)).toEqual([false, true, false]);
    expect((s[0] as unknown as { showSymbol: boolean }).showSymbol).toBe(false);
  });

  it("decay plots the server's fixed-strike sums against their sample times and leaves gaps as gaps", () => {
    const res = { times: ["2026-10-28T02:00:00Z", "2026-10-28T02:30:00Z", "2026-10-28T03:00:00Z"], ce: [0, 2.5, null], pe: [0, -2, -3] } as unknown as PremiumDecay;
    const s = series(decayOption(res, colors));
    expect(s.map((x) => x.name)).toEqual(["CE premium change", "PE premium change"]);
    expect(s[0]!.data).toEqual([[Date.parse("2026-10-28T02:00:00Z"), 0], [Date.parse("2026-10-28T02:30:00Z"), 2.5], [Date.parse("2026-10-28T03:00:00Z"), null]]);
    expect((s[1]!.data[2] as [number, number])[1]).toBe(-3);
  });

  it("decay and premium honour the CE/PE toggles", () => {
    const none = { times: [], ce: [], pe: [] } as unknown as PremiumDecay;
    expect(series(decayOption(none, colors, true, false)).map((x) => x.name)).toEqual(["CE premium change"]);
    expect(series(premiumOption(list, colors, false, true)).map((x) => x.name)).toEqual(["PE total premium"]);
  });

  it("spot chart marks the previous close; straddle carries its ATM strike", () => {
    const sp = series(spotOption(list, colors));
    expect(sp[0]!.markLine).toBeTruthy();
    const y = (spotOption(list, colors) as { yAxis: { min: number; max: number } }).yAxis;
    expect(y.min).toBeLessThanOrEqual(22700);
    expect(y.max).toBeGreaterThanOrEqual(22750);
    expect(y.max - y.min).toBeLessThan(500); // a tight fit, not 10,000-35,000
    const st = series(straddleOption(list, colors));
    expect((st[0]!.data[0] as { atm: number }).atm).toBe(22700);
  });
});

function oiRow(strike: number, side: "CE" | "PE", change: number | null): OiRow {
  return { strike, side, oi: 100, baseline_oi: change == null ? null : 100 - change, change, change_pct: null,
    label: "x", ltp: 1, baseline_ltp: 1, price_change: 0, price_change_pct: 0, relation: null };
}
const oiRes = (rows: OiRow[], atm: number | null = 110): OiChange => ({
  underlying: "NIFTY", expiry: "2026-11-03", baseline: { kind: "session_open", label: "Session open", at: null, note: "" },
  current_at: null, spot: 110, baseline_spot: 109, underlying_change: 1, atm_strike: atm, strikes_each_side: 1, rows,
  totals: { ce_oi: 1, pe_oi: 1, ce_change: 1, pe_change: 1 }, concentration: [], observations_available: 3, warnings: [],
  definitions: {},
});

describe("OI intelligence charts", () => {
  const res = oiRes([oiRow(100, "CE", -5), oiRow(110, "CE", 20), oiRow(100, "PE", null), oiRow(110, "PE", 7)]);

  it("plots OI change per strike with a gap where there is no baseline", () => {
    const s = series(oiChangeBarOption(res, true, true, null, colors));
    expect(s.map((x) => x.name)).toEqual(["Calls (CE)", "Puts (PE)"]);
    expect(s[0]!.data).toEqual([-5, 20]);
    expect(s[1]!.data).toEqual([null, 7]); // missing baseline is a gap, never 0
  });

  it("uses neutral colours, marks ATM and the selected strike, and survives hiding calls", () => {
    const o = oiChangeBarOption(res, false, true, 100, colors) as { series: { itemStyle: { color: string }; markLine?: { data: { name: string }[] } }[] };
    expect(o.series).toHaveLength(1);
    expect(o.series[0]!.itemStyle.color).not.toBe(colors.up);
    expect(o.series[0]!.itemStyle.color).not.toBe(colors.down);
    expect(o.series[0]!.markLine!.data.map((d) => d.name)).toEqual(["ATM", "Selected"]);
  });

  const hm: OiHeatmap = {
    underlying: "NIFTY", expiry: "2026-11-03", side: "CE", baseline: { kind: "session_open", label: "Session open", at: null, note: "" },
    strikes: [100, 110], times: ["2026-10-28T03:45:00Z", "2026-10-28T04:15:00Z", "2026-10-28T04:45:00Z"],
    change: [[0, null, -5], [0, 4, 20]], stride: 1, atm_strike: 110, missing_cells: 1, warnings: [],
  };
  it("heatmap leaves missing cells out and scales symmetrically around zero", () => {
    const o = oiHeatmapOption(hm, colors) as { series: { data: [number, number, number][] }[]; visualMap: { min: number; max: number } };
    expect(o.series[0]!.data).toHaveLength(5); // 6 cells, one missing
    expect(o.series[0]!.data).not.toContainEqual([1, 0, 0]);
    expect(o.visualMap.min).toBe(-20);
    expect(o.visualMap.max).toBe(20);
    expect(o.series[0]!.data).toContainEqual([2, 1, 20]); // [time index, strike index, change]
  });
});

describe("sentimentHistoryOption", () => {
  it("keeps missing scores as gaps and puts spot on the right axis", () => {
    const c = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
    const o = sentimentHistoryOption([
      { sample_utc: "2026-10-29T03:50:00+00:00", spot: 22700, score: 0.1, label: "x", coverage: 0.7, regime: null },
      { sample_utc: "2026-10-29T03:51:00+00:00", spot: null, score: null, label: "Insufficient data", coverage: 0.3, regime: null },
    ], c) as { series: { data: (number | null)[]; yAxisIndex?: number }[]; yAxis: { min?: number; max?: number }[] };
    expect(o.series[0]!.data).toEqual([0.1, null]);
    expect(o.series[1]!.data).toEqual([22700, null]);
    expect(o.series[1]!.yAxisIndex).toBe(1);
    expect(o.yAxis[0]).toMatchObject({ min: -1, max: 1 });
  });
});


describe("OI explorer option", () => {
  const rows = (strike: number, side: "CE" | "PE", oi: number, base: number | null) => ({ strike, side, oi, baseline_oi: base, change: base == null ? null : oi - base });
  const res = {
    atm_strike: 24050,
    rows: [rows(24050, "CE", 160, 100), rows(24050, "PE", 90, 120), rows(24100, "CE", 50, null)],
  } as unknown as OiChange;
  type S = { name: string; data: (number | null)[]; stack?: string };
  const get = (mode: "both" | "change" | "total", calls = true, puts = true) => (oiExplorerOption(res, mode, calls, puts, null, colors) as { series: S[] }).series;

  it("splits each bar into what was there, the increase and the decrease (hand calculated)", () => {
    const s = get("both");
    expect(s.map((x) => x.name)).toEqual(["Call OI", "Call OI increase", "Call OI decrease", "Put OI", "Put OI increase", "Put OI decrease"]);
    // strikes 24050, 24100. Call 24050: 160 now, 100 before -> 100 stays + 60 added. Call 24100 has no baseline -> plain total 50.
    expect(s[0]!.data).toEqual([100, 50]);
    expect(s[1]!.data).toEqual([60, null]);
    expect(s[2]!.data).toEqual([null, null]);
    // Put 24050: 90 now, 120 before -> 90 stays and 30 was removed; no put contract at 24100
    expect(s[3]!.data).toEqual([90, null]);
    expect(s[4]!.data).toEqual([null, null]);
    expect(s[5]!.data).toEqual([30, null]);
    expect(s[0]!.stack).toBe("CE");
    expect(s[3]!.stack).toBe("PE");
  });

  it("shows only the change, or only the total, and leaves a missing baseline as a gap", () => {
    expect(get("change").map((x) => x.data)).toEqual([[60, null], [-30, null]]);
    expect(get("total").map((x) => x.data)).toEqual([[160, 50], [90, null]]);
    expect(get("total", false, true).map((x) => x.name)).toEqual(["Put OI"]);
  });
});

describe("oiSeriesOption", () => {
  const res = { times: ["2026-10-28T02:00:00Z", "2026-10-28T02:30:00Z"], spot: [24000, 24020], ce_oi: [100, null], pe_oi: [150, 160],
    ce_change: [10, 20], pe_change: [-5, 5], pcr: [1.5, null] } as unknown as OiSeries;
  const sr = (k: "pcr" | "change" | "total", calls = true, puts = true) => (oiSeriesOption(res, k, colors, calls, puts) as unknown as { series: { name: string; yAxisIndex: number; data: [number, number | null][] }[] }).series;
  it("plots NIFTY on the left axis and the metric on the right, gaps as gaps", () => {
    const p = sr("pcr");
    expect(p.map((x) => [x.name, x.yAxisIndex])).toEqual([["NIFTY", 0], ["Put-call ratio", 1]]);
    expect(p[1]!.data.map((d) => d[1])).toEqual([1.5, null]);
    expect(sr("total")[1]!.data.map((d) => d[1])).toEqual([100, null]);
  });
  it("change and total honour the call and put toggles", () => {
    expect(sr("change", true, false).map((x) => x.name)).toEqual(["NIFTY", "Call OI change"]);
    expect(sr("change")[2]!.data.map((d) => d[1])).toEqual([-5, 5]);
    expect(sr("total", false, true).map((x) => x.name)).toEqual(["NIFTY", "Put OI"]);
  });
});

describe("payoffOption", () => {
  it("draws the exact expiry payoff with markers for the spot and each breakeven", async () => {
    const { payoffOption } = await import("../lib/chartOptions");
    const o = payoffOption({ expiry: [{ s: 23900, pnl: -100 }, { s: 24100, pnl: 100 }], spot: 24000, breakevens: [24000], target: null, targetLabel: "", bands: null, oi: null }, colors) as unknown as { series: { name: string; data: [number, number][]; markLine: { data: { name?: string }[] } }[] };
    expect(o.series.map((x) => x.name)).toEqual(["Profit", "Loss", "Markers"]);
    expect(o.series[0]!.data).toEqual([[23900, null], [24000, 0], [24100, 100]]); // breakevens are inserted at P&L 0
    expect(o.series[1]!.data).toEqual([[23900, -100], [24000, 0], [24100, null]]);
    expect(o.series[2]!.markLine.data.map((d) => d.name).filter(Boolean)).toEqual(["Spot", "BE"]);
  });

  it("open interest bars come from the chain strike by strike and the right axis shares the zero line with P&L", async () => {
    const { payoffOption } = await import("../lib/chartOptions");
    const oi = [{ strike: 23900, call: 100, put: 300 }, { strike: 24000, call: 500, put: null }];
    const o = payoffOption({ expiry: [{ s: 23800, pnl: -4000 }, { s: 24200, pnl: 1000 }], spot: 24000, breakevens: [24160], target: null, targetLabel: "", bands: null, oi, oiMode: "oi" }, colors) as unknown as {
      yAxis: { min: number; max: number }[]; series: { name: string; data: [number, number | null][] }[] };
    expect(o.series.find((x) => x.name === "Call OI")!.data).toEqual([[23900, 100], [24000, 500]]);
    expect(o.series.find((x) => x.name === "Put OI")!.data).toEqual([[23900, 300], [24000, null]]); // missing stays missing
    const [pl, oiAxis] = o.yAxis as { min: number; max: number }[];
    expect(-pl!.min / pl!.max).toBeCloseTo(-oiAxis!.min / oiAxis!.max, 9); // zero sits at the same height on both axes
  });
});


describe("sessionize", () => {
  const ist = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m) - 5.5 * 3600_000;
  it("drops overnight points, breaks the line between days and fixes the axis to the session", async () => {
    const { sessionize } = await import("../lib/chartOptions");
    const opt = { xAxis: { type: "time" }, series: [{ data: [[ist(29, 15, 40), 10], [ist(29, 21, 0), 10], [ist(30, 2, 37), 10], [ist(30, 9, 15), 12], [ist(30, 9, 16), 13]] }, { data: [1, 2, 3] }] };
    const b = { min: ist(30, 9, 15), max: ist(30, 15, 40) };
    const out = sessionize(opt as never, b) as unknown as { xAxis: { min: number; max: number }; series: { data: unknown[] }[] };
    expect(out.series[0]!.data).toEqual([[ist(29, 15, 40), 10], [ist(30, 9, 15) - 1, null], [ist(30, 9, 15), 12], [ist(30, 9, 16), 13]]);
    expect(out.series[1]!.data).toEqual([1, 2, 3]); // not a time series: untouched
    expect(out.xAxis.min).toBe(b.min);
    // newest sample 09:16: the axis ends just after it (10 min), not at the 15:40 close, while the session runs
    expect(out.xAxis.max).toBe(ist(30, 9, 26));
  });

  it("marks the first sample of each later day with a labelled divider and keeps the series' own marks", async () => {
    const { sessionize } = await import("../lib/chartOptions");
    const own = { data: [{ yAxis: 0 }] };
    const opt = { xAxis: { type: "time" }, series: [{ markLine: own, data: [[ist(29, 10, 0), 1], [ist(29, 10, 1), 2], [ist(30, 9, 15), 3]] }] };
    const out = sessionize(opt as never, null) as unknown as { series: { markLine: { data: { xAxis?: number; yAxis?: number; label?: { formatter: string } }[] } }[] };
    const marks = out.series[0]!.markLine.data;
    expect(marks[0]).toEqual({ yAxis: 0 });
    expect(marks).toHaveLength(2); // one divider: 30 Oct is the only day after the first
    expect(marks[1]!.xAxis).toBe(ist(30, 9, 15));
    expect(marks[1]!.label!.formatter).toBe("30/10");
  });
});
