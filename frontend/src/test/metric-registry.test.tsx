import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MethodologyPanel } from "../components/MethodologyPanel";
import { METRICS } from "../lib/metricRegistry";
import { skewMeasures, skewWorkedExample, type SmileRow } from "../lib/skew";

const r = (strike: number, side: "CE" | "PE", iv: number, delta: number): SmileRow => ({ strike, side, iv, delta, otm: true });
const rows = [r(23900, "PE", 17, -0.4), r(23800, "PE", 18, -0.26), r(23600, "PE", 20, -0.1), r(24100, "CE", 15, 0.4), r(24200, "CE", 14, 0.24), r(24400, "CE", 13.5, 0.09)];

describe("metric registry", () => {
  it("every entry states formula, inputs, steps, sign, all five readings, assumptions and the function that computes it", () => {
    for (const m of Object.values(METRICS)) {
      expect(m.formula.length, m.id).toBeGreaterThan(0);
      expect(m.inputs.length, m.id).toBeGreaterThan(0);
      expect(m.steps.length, m.id).toBeGreaterThan(0);
      expect(m.sign, m.id).not.toBe("");
      expect(Object.values(m.reading).every((t) => t.length > 0), m.id).toBe(true);
      expect(m.assumptions.length, m.id).toBeGreaterThan(0);
      expect(m.computedBy.frontend ?? m.computedBy.backend, m.id).toBeTruthy();
    }
  });
  it("the worked example is computed from the same data and reproduces the displayed skew and butterfly", () => {
    const m = skewMeasures(rows, 24000, 16);
    const ex = skewWorkedExample(rows, 16);
    expect(ex.join("\n")).toContain(`= ${(m.skew_25d as number).toFixed(3)} points`.replace("4.063", "4.063"));
    expect(ex[2]).toContain("4.063");
    expect(ex[3]).toContain("0.094");
  });
  it("the panel is closed by default and shows the formula, example and freshness inside the section", () => {
    render(<MethodologyPanel metrics={[METRICS.iv_skew!]} example={skewWorkedExample(rows, 16)} freshness={{ updatedAt: "2026-11-09T09:30:00Z", session: "2026-11-09", expiry: "2026-11-17", used: 6, missing: 0 }} />);
    const d = screen.getByTestId("methodology") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(screen.getByText(/Calculation Methodology & Formulas/)).toBeTruthy();
    expect(d.textContent).toContain("Skew 25Δ = IV_put(|Δ| = 0.25) − IV_call(|Δ| = 0.25)");
    expect(screen.getByTestId("methodology-freshness").textContent).toContain("Observations used: 6; missing or excluded: 0");
  });
});
