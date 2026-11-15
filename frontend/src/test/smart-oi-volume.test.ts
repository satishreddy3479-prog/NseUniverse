import { describe, expect, it } from "vitest";
import { smartOiOption } from "../lib/chartOptions";
import { smartOiCandles } from "../lib/optionTools";

const colors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" };
const T0 = Date.parse("2026-11-13T03:45:00Z"); // 09:15 IST
// one-minute samples; cumulative call volume 1000 per minute, put volume 2000 per minute (hand-made numbers)
const n = 30;
const series = {
  times: Array.from({ length: n }, (_, i) => new Date(T0 + i * 60_000).toISOString()),
  spot: Array.from({ length: n }, (_, i) => 25100 + i),
  ce_oi: Array.from({ length: n }, (_, i) => 5_000_000 + 100 * i), pe_oi: Array.from({ length: n }, (_, i) => 6_000_000 + 300 * i),
  ce_volume: Array.from({ length: n }, (_, i) => 1000 * (i + 1)), pe_volume: Array.from({ length: n }, (_, i) => 2000 * (i + 1)),
};

describe("Smart OI chart: the volume panel", () => {
  const res = smartOiCandles(series, 3, { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 40 });
  const opt = smartOiOption(res, colors) as unknown as {
    tooltip: { formatter: (p: unknown) => string }; legend: { data: { name: string }[] }; title: { text: string }[]; grid: unknown[]; series: { name: string }[];
  };
  const tip = (i: number) => opt.tooltip.formatter([{ dataIndex: i }]);

  it("the tooltip gives the put and call volume of the hovered candle, their total and share, the difference, and the day so far", () => {
    // candle 2 ends at the sample of minute 8 (index 8): calls 9000, puts 18000 cumulative; candle 1 ended at index 5: 6000 and 12000
    // so in candle 2: calls 3000, puts 6000, total 9000, puts 67%, put minus call +3000
    const s = tip(2).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(s).toContain("Volume traded in this candle");
    expect(s).toMatch(/Put 6\.0 K/);
    expect(s).toMatch(/Call 3\.0 K/);
    expect(s).toMatch(/total 9\.0 K/);
    expect(s).toContain("puts 67% of it");
    expect(s).toMatch(/Put − Call \+3\.0 K/);
    expect(s).toMatch(/Day so far: Put 18\.0 K · Call 9\.0 K/);
  });
  it("the first candle's volume is everything traded since the open", () => {
    const s = tip(0).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(s).toMatch(/Put 6\.0 K · Call 3\.0 K/); // index 2: 3 minutes of trading
  });
  it("shows a dash, not zero, when a candle has no volume figure", () => {
    const noVol = smartOiCandles({ ...series, ce_volume: undefined, pe_volume: undefined }, 3, { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 40 });
    const o = smartOiOption(noVol, colors) as unknown as { tooltip: { formatter: (p: unknown) => string } };
    const s = o.tooltip.formatter([{ dataIndex: 1 }]).replace(/<[^>]+>/g, " ");
    expect(s).toContain("Put —");
    expect(s).not.toMatch(/total/);
  });
  it("the volume panel is named in words, has its own legend and more height than before", () => {
    expect(opt.title.map((x) => x.text).join(" ")).toContain("Volume per candle: put (green) + call (red)");
    expect(opt.legend.data.map((d) => d.name)).toEqual(["Put volume", "Call volume"]);
    expect(opt.series.map((x) => x.name)).toEqual(["NIFTY", "Smart OI", "Put volume", "Call volume"]);
    expect(opt.grid).toHaveLength(3);
  });
  it("the legend sits on its own line under the title, so the two never overlap on a narrow chart", () => {
    const o = opt as unknown as { title: { text: string; top: string }[]; legend: { top: string; left: number; right?: number }; grid: { top: string; height: string }[] };
    const pct = (v: string) => Number(v.replace("%", ""));
    const title = o.title.find((x) => x.text.startsWith("Volume per candle"))!;
    expect(pct(o.legend.top)).toBeGreaterThan(pct(title.top)); // below the title, not beside it
    expect(o.legend.right).toBeUndefined(); // anchored at the left like the title, not at the right edge
    expect(pct(o.grid[2]!.top)).toBeGreaterThan(pct(o.legend.top)); // and above the bars
    expect(pct(o.grid[2]!.top) + pct(o.grid[2]!.height)).toBeLessThan(93); // the time labels still fit under the bars
  });
});
