import { describe, expect, it } from "vitest";
import { drawdownOption, equityOption, robustnessOption, yearReturnsOption } from "../lib/swingCharts";
import {
  exitLabel, filterTrades, isStale, NO_FILTER, pct, plain, resultText, reportAgeDays, rupees, sortBy, tradesToCsv,
} from "../lib/swing";
import { sensitivity } from "../components/swing/SwingRobustness";
import { swingReport, trade } from "./swingFixture";

const colors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };

describe("formatting keeps missing values missing", () => {
  it("pct, rupees", () => {
    expect(pct(null)).toBe("—");
    expect(pct(95.44)).toBe("+95.4%");
    expect(pct(-2.82, 2)).toBe("−2.82%");
    expect(rupees(null)).toBe("—");
    expect(plain(-0.04)).toBe("−0.04");
    expect(rupees(954_376.9)).toBe("₹9.54 L");
  });
  it("labels known exits and passes unknown ones through", () => {
    expect(exitLabel("D1_FAIL_CLOSE")).toContain("below pivot");
    expect(exitLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("staleness", () => {
  const now = new Date("2026-11-04T12:00:00Z"); // 17:30 IST on a Wednesday
  it("counts IST calendar days", () => {
    expect(reportAgeDays("2026-11-04", now)).toBe(0);
    expect(reportAgeDays("2026-10-30", now)).toBe(5);
  });
  it("tolerates a weekend, flags more", () => {
    const monday = new Date("2026-11-02T12:00:00Z");
    expect(isStale("2026-10-30", monday)).toBe(false); // Friday's close seen on Monday
    expect(isStale("2026-10-29", monday)).toBe(true); // Thursday's close: a session was missed
  });
});

describe("sortBy", () => {
  it("puts missing values last in both directions and is stable", () => {
    const rows = [{ k: 2, id: "a" }, { k: null, id: "b" }, { k: 1, id: "c" }, { k: 2, id: "d" }];
    expect(sortBy(rows, (r) => r.k, "asc").map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
    expect(sortBy(rows, (r) => r.k, "desc").map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
  });
});

describe("trade filters and CSV", () => {
  const trades = swingReport().trades;
  it("filters by symbol text, year, exit and pattern", () => {
    expect(filterTrades(trades, { ...NO_FILTER, query: "ti" }).map((t) => t.symbol)).toEqual(["TITAN"]);
    expect(filterTrades(trades, { ...NO_FILTER, year: "2025" })).toHaveLength(2);
    expect(filterTrades(trades, { ...NO_FILTER, reason: "D1_STOP" })).toHaveLength(1);
    expect(filterTrades(trades, { ...NO_FILTER, archetype: "CLASSIC_PIVOT" })).toHaveLength(1);
    expect(filterTrades(trades, NO_FILTER)).toHaveLength(3);
  });
  it("writes a header, one line per trade, and escapes commas and quotes", () => {
    const csv = tradesToCsv([trade({ symbol: 'A"B,C', exit: null, exit_date: null, r_mult: null })]);
    const [head, line] = csv.trim().split("\n");
    expect(head!.startsWith("symbol,sector_index,archetype")).toBe(true);
    expect(line!.startsWith('"A""B,C",CNXFMCG,BLUE_SKY,70')).toBe(true);
    expect(line).toContain(",,"); // missing exit stays empty, not 0
    expect(csv.endsWith("\n")).toBe(true);
  });
});

describe("chart options plot what the report says", () => {
  const r = swingReport();
  it("equity: chosen basis against NIFTY on the same dates", () => {
    const o = equityOption(r, "net", colors) as { series: { name: string; data: number[] }[]; xAxis: { data: string[] } };
    expect(o.xAxis.data).toEqual(r.equity.dates);
    expect(o.series[0]!.name).toContain("after costs");
    expect(o.series[0]!.data).toEqual(r.equity.net);
    expect(o.series[1]!.data).toEqual(r.equity.nifty);
    const g = equityOption(r, "gross", colors) as { series: { name: string; data: number[] }[] };
    expect(g.series[0]!.data).toEqual(r.equity.gross);
  });
  it("drawdown uses the matching series; years and robustness use report rows", () => {
    const d = drawdownOption(r, "gross", colors) as { series: { data: number[] }[] };
    expect(d.series[0]!.data).toEqual(r.equity.gross_dd);
    const y = yearReturnsOption(r, "net", colors) as { series: { data: number[] }[] };
    expect(y.series[0]!.data).toEqual([26.5, 15.0]);
    expect(y.series[1]!.data).toEqual([20.0, 8.8]);
    const b = robustnessOption(r.robustness, colors) as { series: { data: number[] }[]; xAxis: { data: string[] } };
    expect(b.xAxis.data[1]).toContain("★");
    expect(b.series[1]!.data).toEqual([-9.4, 48.6]);
  });
});

describe("score sensitivity sentence", () => {
  it("reports the spread honestly in either direction", () => {
    const mk = (label: string, g: number) => ({ group: "Minimum score", label, trades: 1, gross_return_pct: g, net_return_pct: 0, gross_max_dd_pct: 1, gross_profit_factor: 1, net_profit_factor: 1 });
    expect(sensitivity([mk("score ≥ 64", 20), mk("score ≥ 65  (rule)", 95)])).toContain("75 points apart");
    expect(sensitivity([mk("score ≥ 64", 80), mk("score ≥ 65  (rule)", 90)])).toContain("similar results");
    expect(sensitivity([mk("only one", 5)])).toBe("");
  });
});

describe("scanner result in plain words", () => {
  it("translates known states and keeps the detail of failures", () => {
    expect(resultText("ok")).toContain("settled");
    expect(resultText("up_to_date")).toContain("up to date");
    expect(resultText("data_unavailable: only 600 of 791 stocks had usable bars; scan not trusted"))
      .toBe("Data not available yet (only 600 of 791 stocks had usable bars; scan not trusted); it will retry");
    expect(resultText("error: KeyError")).toBe("Error (KeyError); it will retry");
    expect(resultText("not run yet")).toBe("Not run yet");
    expect(resultText("something new")).toBe("something new"); // unknown values are shown, not hidden
  });
});

