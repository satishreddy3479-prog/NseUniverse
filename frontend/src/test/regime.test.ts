// The regime rules on hand-built inputs: each case lists which conditions hold, so the expected regime follows by reading the rules.
import { describe, expect, it } from "vitest";
import { classifyRegime, type RegimeInputs } from "../lib/regime";

const empty: RegimeInputs = { spotPct: null, atmIvChange: null, momentum25: null, skew25: null, butterfly25: null, ivMinusHv: null, demand: null, netGex: null, flip: null, spot: null, divergence: null };
const mk = (o: Partial<RegimeInputs>): RegimeInputs => ({ ...empty, ...o });

describe("regime classifier", () => {
  it("says Insufficient data rather than guessing when fewer than 5 conditions can be evaluated", () => {
    const r = classifyRegime(mk({ spotPct: 0.3, atmIvChange: 0.5 }));
    // evaluable: spot_up, spot_dn, iv_up, iv_dn = 4
    expect(r.regime).toBe("Insufficient data");
    expect(r.confidence.level).toBe("Low");
    expect(r.unavailable.length).toBeGreaterThan(5);
  });
  it("bullish volatility expansion: up move + call IV momentum + calls at/above puts, with IV rising and GEX positive", () => {
    const r = classifyRegime(mk({ spotPct: 0.3, momentum25: 0.5, skew25: -0.5, atmIvChange: 0.6, netGex: 40, flip: 23500, spot: 24000, demand: { "CE:otm": "Upside speculation" } }));
    // bull conditions met: spot_up, mom_up, skew_call, ce_spec = 4; bear = 0; gap 4 >= 2; IV +0.6 >= 0.3
    expect(r.direction).toBe("bullish");
    expect(r.regime).toBe("Bullish volatility expansion");
    expect(r.supporting).toContain("NIFTY up more than 0.1%");
    expect(r.upsideScore).toBeGreaterThan(r.downsideScore ?? 100);
  });
  it("bearish volatility contraction needs falling IV", () => {
    const r = classifyRegime(mk({ spotPct: -0.3, momentum25: -0.6, skew25: 4, atmIvChange: -0.5, netGex: 10, flip: 23000, spot: 24000, demand: { "PE:otm": "Downside speculation" } }));
    expect(r.regime).toBe("Bearish volatility contraction");
  });
  it("negative net GEX with a real move reads as negative gamma / momentum amplification, ahead of the directional labels", () => {
    const r = classifyRegime(mk({ spotPct: 0.4, momentum25: 0.5, atmIvChange: 0.5, skew25: -1, netGex: -25, flip: 23500, spot: 24000, divergence: "amplifying" }));
    expect(r.gamma).toBe("negative");
    expect(r.regime).toBe("Negative gamma / momentum amplification");
  });
  it("range-bound / positive gamma: flat NIFTY, calm IV, positive GEX away from the flip", () => {
    const r = classifyRegime(mk({ spotPct: 0.02, atmIvChange: 0.0, momentum25: 0.0, skew25: 1, netGex: 30, flip: 23000, spot: 24000, ivMinusHv: 1, butterfly25: 0.2 }));
    expect(r.direction).toBe("neutral");
    expect(r.regime).toBe("Range-bound / positive gamma");
    expect(r.stabilityScore).toBe(100);
  });
  it("near the flip is not called positive gamma", () => {
    const r = classifyRegime(mk({ spotPct: 0.02, atmIvChange: 0.0, momentum25: 0.0, skew25: 1, netGex: 30, flip: 23980, spot: 24000, ivMinusHv: 1, butterfly25: 0.2 }));
    expect(r.gamma).toBe("near flip");
    expect(r.regime).not.toBe("Range-bound / positive gamma");
  });
  it("conflicting directional evidence with rising IV is uncertainty expansion, and with flat IV mixed", () => {
    const base = { spotPct: 0.3, momentum25: -0.5, skew25: 4, atmIvChange: 0.6, netGex: 5, flip: 23000, spot: 24000, demand: { "CE:otm": "Upside speculation", "PE:otm": "Downside speculation" } } as const;
    // bull: spot_up, ce_spec = 2; bear: mom_dn, skew_put, pe_spec = 3: gap 1 -> conflicting
    expect(classifyRegime(mk(base)).direction).toBe("conflicting");
    expect(classifyRegime(mk(base)).regime).toBe("Uncertainty expansion");
    expect(classifyRegime(mk({ ...base, atmIvChange: 0.0 })).regime).toBe("Mixed / conflicting signals");
  });
  it("lists contradicting evidence and reports confidence as completeness and agreement, not a probability", () => {
    const r = classifyRegime(mk({ spotPct: 0.3, momentum25: 0.5, skew25: -1, atmIvChange: 0.6, netGex: 5, flip: 23000, spot: 24000, demand: { "PE:otm": "Downside speculation" } }));
    expect(r.contradicting).toContain("OTM puts read as downside speculation");
    expect(r.confidence.agreement).toBeCloseTo(0.75, 6); // 3 bull (spot_up, mom_up, skew_call) of 4 directional
    expect(r.confidence.completeness).toBeGreaterThan(0.5);
    expect(["High", "Medium", "Low"]).toContain(r.confidence.level);
  });
});

describe("regime with the GEX-price relationship", () => {
  const calm = { spotPct: 0.3, momentum25: 0.5, skew25: -0.5, atmIvChange: 0.0, netGex: 40, flip: 23500, spot: 24000, demand: { "CE:otm": "Upside speculation" } } as const;
  it("an amplifying relationship with a real NIFTY move is amplification even while net GEX is still positive", () => {
    const r = classifyRegime(mk({ ...calm, divergence: "amplifying", divergenceLabel: "NIFTY up while net GEX becomes more negative: potentially amplifying.", gexNetChange: -30, gexNetPct: -42.9, universe: "dynamic" }));
    expect(r.gamma).toBe("positive");
    expect(r.regime).toBe("Negative gamma / momentum amplification");
    expect(r.gexView).toMatchObject({ universe: "dynamic", netChange: -30, netPct: -42.9, relationship: expect.stringContaining("amplifying") });
    expect(r.supporting).toContain("NIFTY and net GEX move so that hedging could amplify (potentially, not guaranteed)");
  });
  it("without a real move the same relationship does not trigger amplification", () => {
    const r = classifyRegime(mk({ ...calm, spotPct: 0.02, momentum25: 0, skew25: 1, demand: null, divergence: "amplifying" }));
    expect(r.regime).not.toBe("Negative gamma / momentum amplification");
  });
  it("a stabilising relationship and positive near-ATM GEX raise the stability score and are listed as supporting evidence", () => {
    const flat = mk({ spotPct: 0.02, atmIvChange: 0, momentum25: 0, skew25: 1, netGex: 30, flip: 23000, spot: 24000, divergence: "stabilising", nearAtmNet: 12, ivMinusHv: 1, butterfly25: 0.2 });
    const r = classifyRegime(flat);
    expect(r.stabilityScore).toBe(100); // gex_pos, gex_stab, near_pos, iv_calm and flat all hold
    expect(r.regime).toBe("Range-bound / positive gamma");
    expect(r.supporting).toContain("near-ATM net GEX positive");
    const mixed = classifyRegime({ ...flat, nearAtmNet: -5 });
    expect(mixed.stabilityScore).toBeLessThan(100);
    expect(mixed.contradicting.length + mixed.supporting.length).toBeGreaterThan(0);
  });
  it("an unavailable relationship is not evaluable rather than false, and the flip distance is reported", () => {
    const r = classifyRegime(mk({ ...calm, divergence: "unavailable", flip: 23880 }));
    expect(r.unavailable).toContain("NIFTY and net GEX move so that hedging could amplify (potentially, not guaranteed)");
    expect(r.gexView.flipDistancePct).toBeCloseTo(((23880 - 24000) / 24000) * 100, 6);
  });
  it("every condition has an explicit weight of 1, and a weight change changes the scores", async () => {
    const { WEIGHTS, classifyRegime: c2 } = await import("../lib/regime");
    expect(Object.values(WEIGHTS).every((v) => v === 1)).toBe(true);
    const base = c2(mk({ spotPct: 0.3, momentum25: -0.5, skew25: 4, atmIvChange: 0.6, netGex: 5, flip: 23000, spot: 24000 }));
    const before = base.upsideScore;
    WEIGHTS.spot_up = 3;
    try { expect(c2(mk({ spotPct: 0.3, momentum25: -0.5, skew25: 4, atmIvChange: 0.6, netGex: 5, flip: 23000, spot: 24000 })).upsideScore).not.toBe(before); } finally { WEIGHTS.spot_up = 1; }
  });
});
