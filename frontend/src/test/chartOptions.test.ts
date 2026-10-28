import { describe, expect, it } from "vitest";
import {
  decayOption, decaySeries, oiChangeBarOption, oiHeatmapOption, premiumOption, spotOption, straddleOption,
  strikeBarOption, totalsBarOption,
} from "../lib/chartOptions";
import { computeTotals } from "../lib/analytics";
import { bigChain } from "./fixtures";
import type { Observation, OiChange, OiHeatmap, OiRow } from "../lib/types";

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

  it("decay is the change from the first complete observation", () => {
    const d = decaySeries(list);
    expect(d.ce).toEqual([0, -10, -20]);
    expect(d.pe).toEqual([0, -20, -40]);
    expect(d.baselineAt).toBe(list[0]!.retrieved_at);
  });

  it("decay baseline skips leading observations that lack premium", () => {
    const d = decaySeries([obs(1, { total_pe_premium: null }), obs(2), obs(3)]);
    expect(d.baselineAt).toBe("2026-10-28T02:00:00Z");
    expect(d.pe[0]).toBeNull(); // the leading point has no PE premium: a gap, not a zero
    expect(d.ce[0]).toBe(10); // its CE premium (990) is still measured against the baseline (980)
    expect(d.ce[2]).toBe(-10);
  });

  it("decay has no baseline when nothing is complete", () => {
    expect(decaySeries([obs(1, { total_ce_premium: null })]).baselineAt).toBeNull();
  });

  it("decay and premium honour the CE/PE toggles", () => {
    expect(series(decayOption(list, colors, true, false)).map((x) => x.name)).toEqual(["CE premium change"]);
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
