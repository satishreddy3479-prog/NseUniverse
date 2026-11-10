/**
 * The metric-definition registry: one entry per metric, holding the formula, inputs, sign convention, assumptions and reading rules
 * that the "Calculation Methodology & Formulas" panels display. It lives beside the calculations it describes (`skew.ts`, the
 * backend's `skew_metrics` in app/intraday/volatility.py) and every entry names the function that computes it. The worked
 * examples in the panels are produced by calling that same function on the data on screen, never typed in, and
 * `metric-registry.test.ts` checks that each registered formula's example reproduces the displayed number.
 * Bump `version` whenever a formula, convention or threshold changes.
 */
export interface MetricInput { name: string; source: string; unit: string; kind: "raw" | "derived"; note?: string }
export interface MetricDef {
  id: string; version: string; title: string;
  /** what it measures, in plain words */
  measures: string;
  /** the exact formulas, one per line, in plain text */
  formula: string[];
  /** where it is computed: frontend function and backend function (they are kept equal by shared hand-calculated tests) */
  computedBy: { frontend?: string; backend?: string };
  unit: string; sign: string;
  inputs: MetricInput[];
  steps: string[];
  reading: { positive: string; negative: string; rising: string; falling: string; nearZero: string };
  assumptions: string[];
}

const IV_ROWS: MetricInput = { name: "Solved contracts", source: "stored chain (Kotak option chain) or the live stream, solved with Black-76 on the forward from put-call parity", unit: "IV in % per year, delta as a fraction", kind: "derived", note: "only out-of-the-money options, one expiry" };
const ATM: MetricInput = { name: "ATM IV", source: "average of the call and put IV at the strike nearest the forward", unit: "% per year", kind: "derived" };
const DELTA_STEPS = [
  "Take the out-of-the-money calls (strike at or above ATM) and puts (at or below ATM) of the chosen expiry that have a solved IV and delta.",
  "For each side sort the contracts by absolute delta, find the two neighbours whose deltas bracket the target (0.25 or 0.10).",
  "Interpolate the IV linearly in delta between them: IV = IV_lo + (target − Δ_lo) / (Δ_hi − Δ_lo) × (IV_hi − IV_lo). A contract exactly on the target is used as it is.",
  "If the target lies outside the listed deltas on a side, that measure is missing. It is never extrapolated and never filled with zero.",
];

export const METRICS: Record<string, MetricDef> = {
  iv_skew: {
    id: "iv_skew", version: "2", title: "IV skew (25Δ and 10Δ)",
    measures: "How much more (or less) the market charges, in implied volatility, for out-of-the-money puts than for out-of-the-money calls of the same absolute delta and the same expiry.",
    formula: ["Skew 25Δ = IV_put(|Δ| = 0.25) − IV_call(|Δ| = 0.25)", "Skew 10Δ = IV_put(|Δ| = 0.10) − IV_call(|Δ| = 0.10)", "Call − put skew = −Skew   (the same number with the opposite sign)"],
    computedBy: { frontend: "skewMeasures / ivAtDelta (lib/skew.ts)", backend: "skew_metrics / iv_at_delta (app/intraday/volatility.py)" },
    unit: "implied-volatility points", sign: "Put minus call. Positive: puts richer. Negative: calls richer. The call-minus-put figure shown beside it has the opposite sign; no other platform's sign is assumed.",
    inputs: [IV_ROWS],
    steps: [...DELTA_STEPS, "Subtract the call IV from the put IV."],
    reading: {
      positive: "Downside (put) volatility is priced above upside (call) volatility at that delta: downside protection is relatively more expensive (the usual shape).",
      negative: "Calls are priced above puts at that delta: upside is relatively richer than downside (unusual).",
      rising: "Relative demand for downside protection, or supply of upside volatility, is increasing. It does not say who is buying.",
      falling: "The put premium over calls is shrinking, or calls are getting relatively richer.",
      nearZero: "Put and call wings are priced about equally.",
    },
    assumptions: ["Delta is Black-76 delta from the IV solved for that contract, so a wing's delta moves with its own IV.", "Rate is an assumed constant and the forward comes from put-call parity; both are model inputs.", "A skew value is a price relationship, not a trade direction."],
  },
  iv_butterfly: {
    id: "iv_butterfly", version: "2", title: "IV butterfly (25Δ and 10Δ)",
    measures: "How expensive the two out-of-the-money wings are, in volatility, compared with at-the-money.",
    formula: ["Butterfly 25Δ = (IV_call(0.25) + IV_put(0.25)) / 2 − ATM IV", "Butterfly 10Δ = (IV_call(0.10) + IV_put(0.10)) / 2 − ATM IV"],
    computedBy: { frontend: "skewMeasures (lib/skew.ts)", backend: "skew_metrics (app/intraday/volatility.py)" },
    unit: "implied-volatility points", sign: "Wing average minus ATM. Positive: wings richer than ATM.",
    inputs: [IV_ROWS, ATM],
    steps: [...DELTA_STEPS, "Average the call and put wing IVs and subtract the ATM IV."],
    reading: { positive: "Out-of-the-money wings cost more than ATM: the smile is curved upward (tail protection or speculation is priced).", negative: "ATM is relatively expensive compared with the wings.", rising: "Relative wing premium is increasing.", falling: "Relative wing premium is declining.", nearZero: "A flat smile between ATM and that delta." },
    assumptions: ["Needs both wings and ATM IV at the same snapshot; if any is missing the butterfly is missing.", "Within one expiry only."],
  },
  iv_slope: {
    id: "iv_slope", version: "1", title: "Skew slope",
    measures: "How quickly IV changes as the strike moves away from the forward, across the whole out-of-the-money smile.",
    formula: ["x_i = (K_i / F − 1) × 100   (moneyness, % of the forward)", "slope = Σ (x_i − x̄)(IV_i − IV̄) / Σ (x_i − x̄)²   (least squares)"],
    computedBy: { frontend: "skewMeasures (lib/skew.ts)", backend: "skew_metrics (app/intraday/volatility.py)" },
    unit: "IV points per 1 % of moneyness", sign: "Positive: IV rises as strikes go above the forward; negative: IV is higher below the forward (the usual downward-sloping skew).",
    inputs: [{ name: "K_i, IV_i", source: "every out-of-the-money contract with a solved IV (at least 4)", unit: "strike in index points, IV in %", kind: "derived" }, { name: "F", source: "forward from put-call parity", unit: "index points", kind: "derived" }],
    steps: ["Convert each strike to moneyness x_i.", "Fit a straight line of IV on x by least squares.", "Report its slope. Fewer than four points, or no spread in x, gives a missing value."],
    reading: { positive: "Call-side IV above put-side IV across the smile.", negative: "Put-side IV above call-side IV across the smile (a downward-sloping smile).", rising: "The smile is tilting towards the upside.", falling: "The smile is tilting towards the downside.", nearZero: "A flat smile." },
    assumptions: ["The platform-defined slope is this regression; the raw 25Δ and 10Δ skews are shown separately and are not normalised by distance.", "All contracts count equally, whatever their liquidity."],
  },
  term_slope: {
    id: "term_slope", version: "1", title: "Term slope",
    measures: "How ATM implied volatility differs between a far and a near expiry, scaled to 30 days.",
    formula: ["Term slope = (IV_far − IV_near) / (DTE_far − DTE_near) × 30"],
    computedBy: { backend: "iv_skew (app/intraday/service.py)" },
    unit: "IV points per 30 days", sign: "Far minus near. Positive: contango (far IV higher). Negative: backwardation (near IV higher).",
    inputs: [{ name: "IV_near, IV_far", source: "ATM IV of the nearest and farthest stored expiry at the same moment", unit: "% per year", kind: "derived" }, { name: "DTE", source: "calendar days from now to each expiry's close", unit: "days", kind: "derived" }],
    steps: ["Take the nearest and the farthest expiry with a chain stored within 5 minutes of the chosen one.", "Divide the IV difference by the difference in days, and multiply by 30."],
    reading: { positive: "Contango: longer-dated volatility is higher than near-dated.", negative: "Backwardation: near-dated volatility is higher (event or stress premium near term).", rising: "Far-dated volatility is rising relative to near-dated.", falling: "The curve is flattening or inverting.", nearZero: "A flat term structure." },
    assumptions: ["Near expiries carry event and expiry-day effects; a slope over a few days is dominated by them.", "Uses only the two end expiries; the other expiries are shown on the term chart."],
  },
};
