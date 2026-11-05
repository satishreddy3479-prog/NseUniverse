import { describe, expect, it } from "vitest";
import { sentimentOf } from "../components/FuturesBuildupTool";
import type { Buildup, BuildupRow } from "../lib/analytics";
import { toolById } from "../lib/tools";

const row = (state: Buildup) => ({ state }) as BuildupRow;

describe("buildup sentiment", () => {
  it("counts the four readings and the bullish share of the windows that have one", () => {
    // 3 long buildup + 2 short covering = 5 bullish; 2 short buildup + 1 long unwinding = 3 bearish; unchanged/missing are left out
    const rows = [...Array(3).fill("long buildup"), ...Array(2).fill("short covering"), ...Array(2).fill("short buildup"), "long unwinding", "unchanged", "missing"].map(row);
    const s = sentimentOf(rows);
    expect(s.counts["long buildup"]).toBe(3);
    expect(s.counts["long unwinding"]).toBe(1);
    expect(s.bullPct).toBeCloseTo(62.5, 6); // 5 of 8
    expect(s.label).toBe("Bullish");
  });
  it("says Bearish at 45% or less, Mixed in between, and nothing when no window has a reading", () => {
    expect(sentimentOf([row("short buildup"), row("short buildup"), row("long buildup")]).label).toBe("Bearish"); // 33%
    expect(sentimentOf([row("long buildup"), row("short buildup")]).label).toBe("Mixed"); // 50%
    expect(sentimentOf([row("unchanged"), row("missing")])).toMatchObject({ bullPct: null, label: null });
  });
  it("Heatmap and Sentiment Cycle are gone, Price vs OI stays", () => {
    expect(toolById("future-heatmap")).toBeUndefined();
    expect(toolById("sentiment-cycle")).toBeUndefined();
    expect(toolById("future-price-oi")?.status).toBe("ready");
  });
});
