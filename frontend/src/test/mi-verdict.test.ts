// The plain-language reading at the top of Market Intelligence: written only from fields the summary carries. Fixtures are hand-built formula checks, not market data.
import { describe, expect, it } from "vitest";
import type { EngineView, Intelligence } from "../lib/intelligence";
import { plainName, verdict } from "../lib/miVerdict";

const eng = (key: string, name: string, score: number | null, o: Partial<EngineView> = {}): EngineView => ({
  key, name, score, class: "x", tilt: "neutral", link: "/x", weight: 20, contribution: score == null ? null : score * 0.2, terms: [], supporting: [], conflicting: [], unavailable: [],
  freshness: { fresh: true, age_s: 5, inputs: [], failed: [] }, ...o,
});

const make = (o: Partial<Record<string, unknown>> = {}): Intelligence => ({
  generated_at: "2026-11-12T10:00:00Z", expiry: "2026-11-17", session: "2026-11-12", enabled: true, status: {},
  sentiment: { score: 27, class: "Mild Bullish", coverage: 0.83, engines_available: 4, agreement: 0.7, freshness: 0.4, confidence: 28, reason: null, trend_strength: 56, signal_quality: "Low", data_completeness: 0.67, volatility_regime: "Normal" },
  regime: { name: "Weak bullish", evidence: [], volatility: "Normal", gamma: "positive", previous: "Sideways / Range", changed_at: null },
  engines: [eng("positioning", "A. Derivatives positioning", 40), eng("orderflow", "B. Order-flow proxies", 71, { freshness: { fresh: false, age_s: 9000, inputs: [], failed: [] } }), eng("volatility", "C. Volatility", -18), eng("structure", "D. Market structure", 14), eng("participation", "E. Participation and breadth", null)],
  alerts: [], turn_watch: { available: true, lean: "none", signals: [], changes: {} },
  scenarios: { available: true, label: "x", bullish: { score: 55, confirmation: "sustained trade above 25424", invalidation: "a hold below 25095" }, bearish: { score: 5, confirmation: "sustained trade below 25095", invalidation: "a hold above 25200" }, sideways: { score: 40, range: [25095, 25424] } },
  ...o,
} as unknown as Intelligence);

describe("verdict", () => {
  it("reads the direction from the score and says how far to trust it, from the quality figures", () => {
    const v = verdict(make());
    expect(v.tone).toBe("bullish");
    expect(v.label).toBe("Mild Bullish");
    expect(v.headline).toContain("score +27 out of 100");
    expect(v.headline).toContain("weak"); // Low signal quality
    expect(v.trust.level).toBe("Low");
    expect(v.trust.text).toContain("evidence quality 28/100");
    expect(v.trust.text).toContain("1 of 5 evidence groups are stale");
    expect(v.trust.text).toContain("1 group has no reading");
    expect(v.trust.text).toContain("70% of the groups agree");
  });

  it("names the groups pointing each way, the strongest first, and skips groups with no reading", () => {
    const v = verdict(make());
    expect(v.reasons.for).toEqual([{ name: "Order-flow proxies", score: 71 }, { name: "Derivatives positioning", score: 40 }]); // ordered by contribution; |score| >= 15 only
    expect(v.reasons.against).toEqual([{ name: "Volatility", score: -18 }]);
    const bearish = verdict(make({ sentiment: { ...make().sentiment, score: -40, class: "Bearish" } }));
    expect(bearish.tone).toBe("bearish");
    expect(bearish.reasons.for).toEqual([{ name: "Volatility", score: -18 }]); // for a bearish reading the 'for' side is the bearish groups
    expect(bearish.reasons.against.map((r) => r.name)).toEqual(["Order-flow proxies", "Derivatives positioning"]);
  });

  it("says what would change the view, by direction, from the scenarios", () => {
    expect(verdict(make()).watch).toEqual([{ label: "The bullish view weakens if", text: "a hold below 25095" }, { label: "It turns bearish if", text: "sustained trade below 25095" }]);
    const bear = verdict(make({ sentiment: { ...make().sentiment, score: -30, class: "Bearish" } }));
    expect(bear.watch.map((w) => w.label)).toEqual(["The bearish view weakens if", "It turns bullish if"]);
    const flat = verdict(make({ sentiment: { ...make().sentiment, score: 3, class: "Neutral" } }));
    expect(flat.watch[0]).toEqual({ label: "Expected range", text: "25095 to 25424" });
    expect(verdict(make({ scenarios: { available: false, label: "x" } })).watch).toEqual([]); // nothing is invented when there are no scenarios
  });

  it("reports the 20-minute change in words, and says when it is not available", () => {
    expect(verdict(make()).changed).toEqual({ lean: "none", text: "No sustained change in the last 20 minutes." });
    const ctxOnly = verdict(make({ turn_watch: { available: true, lean: "none", signals: [{ id: "breadth_up", direction: "bullish", title: "3 of 5 engines improving together", evidence: [], invalidation: "x" }], changes: {} } })).changed;
    expect(ctxOnly).toEqual({ lean: "none", text: "No sustained turn in the last 20 minutes. Context: 3 of 5 engines improving together." }); // context is mentioned, never called a turn
    const sig = { id: "flow_turn_down", direction: "bearish", title: "Traded flow is turning down", evidence: [], invalidation: "x", early: true };
    expect(verdict(make({ turn_watch: { available: true, lean: "bearish", signals: [{ id: "breadth_down", direction: "bearish", title: "3 of 5 engines deteriorating together", evidence: [], invalidation: "x" }, sig], changes: {} } })).changed)
      .toEqual({ lean: "bearish", text: "Traded flow is turning down (price has not confirmed yet)." }); // a breadth signal never leads
    expect(verdict(make({ turn_watch: { available: false, reason: "needs 26 stored minutes", signals: [], changes: {} } })).changed).toEqual({ lean: "unavailable", text: "needs 26 stored minutes" });
    expect(verdict(make({ turn_watch: undefined })).changed.lean).toBe("unavailable");
  });

  it("says so plainly when there is no reading, and never invents a direction", () => {
    const v = verdict(make({ sentiment: { ...make().sentiment, score: null, reason: "only 2 of 5 evidence groups have data", signal_quality: null, confidence: null } }));
    expect(v.tone).toBe("unknown");
    expect(v.label).toBe("No reading");
    expect(v.headline).toBe("There is too little data to read a direction right now.");
    expect(v.trust).toEqual({ level: "Unknown", text: "only 2 of 5 evidence groups have data" });
  });

  it("strips the letter from a group name", () => {
    expect(plainName("A. Derivatives positioning")).toBe("Derivatives positioning");
    expect(plainName("Volatility")).toBe("Volatility");
  });
});
