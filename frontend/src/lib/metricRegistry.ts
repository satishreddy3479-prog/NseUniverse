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
    computedBy: { backend: "iv_term_structure (app/intraday/volatility.py)" },
    unit: "IV points per 30 days", sign: "Far minus near. Positive: contango (far IV higher). Negative: backwardation (near IV higher).",
    inputs: [{ name: "IV_near, IV_far", source: "ATM IV of the nearest and farthest stored expiry at the same moment", unit: "% per year", kind: "derived" }, { name: "DTE", source: "calendar days from now to each expiry's close", unit: "days", kind: "derived" }],
    steps: ["Take the expiries with a chain stored within 5 minutes of the chosen one and a solved ATM IV.", "Leave out an expiry with less than half a day left (its last session: expiry-day effects, and a tiny day gap makes the slope explode); it stays in the table and is listed as left out.", "Divide the IV difference between the farthest and the nearest remaining expiry by their day difference, and multiply by 30. The same formula between each neighbouring pair gives the pair slopes.", "Shape: contango above +0.5 IV points per 30 days, backwardation below −0.5, otherwise flat (our threshold, not a market standard)."],
    reading: { positive: "Contango: longer-dated volatility is higher than near-dated.", negative: "Backwardation: near-dated volatility is higher (event or stress premium near term).", rising: "Far-dated volatility is rising relative to near-dated.", falling: "The curve is flattening or inverting.", nearZero: "A flat term structure." },
    assumptions: ["Near expiries carry event and expiry-day effects; a slope over a few days is dominated by them.", "Uses only the two end expiries; the other expiries are shown on the term chart."],
  },
  iv_momentum: {
    id: "iv_momentum", version: "1", title: "Call vs put IV momentum",
    measures: "Whether call implied volatility moved up (or down) more than put implied volatility between two stored snapshots of the same expiry, at ATM, 25 delta and 10 delta.",
    formula: ["CE IV change = CE IV(now) − CE IV(then)", "PE IV change = PE IV(now) − PE IV(then)", "IV momentum = CE IV change − PE IV change"],
    computedBy: { backend: "momentum_table / compare (app/intraday/momentum.py)" },
    unit: "implied-volatility points", sign: "Call change minus put change. Positive: call IV strengthened relative to put IV.",
    inputs: [
      { name: "CE IV, PE IV at ATM", source: "the stored chain's ATM call and put IV", unit: "% per year", kind: "derived" },
      { name: "CE IV, PE IV at 25Δ / 10Δ", source: "interpolated in delta (see IV skew)", unit: "% per year", kind: "derived", note: "the strikes re-select themselves as NIFTY moves" },
      { name: "then", source: "the stored snapshot nearest before now − N minutes (tolerance 2 min for 1 and 5 min, 5 min otherwise); previous session close = last in-session sample of the earlier session", unit: "timestamp", kind: "raw" },
      { name: "NIFTY change", source: "spot stored with each snapshot", unit: "index points and %", kind: "raw" },
    ],
    steps: ["Solve each snapshot's surface (Black-76) and read CE and PE IV at ATM, 25Δ and 10Δ.", "Find the earlier snapshot for each window; if none is stored inside the tolerance the window shows no snapshot.", "Subtract to get each side's change, then subtract the put change from the call change."],
    reading: {
      positive: "Call IV strengthened relative to put IV (call IV rose more, or fell less). It is not, by itself, call buying.",
      negative: "Put IV strengthened relative to call IV.",
      rising: "The call-over-put relative move is building across the windows.", falling: "The relative move is fading or reversing.",
      nearZero: "Call and put IV moved by a similar amount (both may have moved a lot).",
    },
    assumptions: ["Compares one expiry only; a changing strike set can move a delta point without any trading.", "An IV change is not a premium change: the premium also moves with spot, time and delta.", "A missing IV at either end leaves the change missing, never zero."],
  },
  iv_rank: {
    id: "iv_rank", version: "1", title: "IV Rank",
    measures: "Where today's implied volatility sits between the lowest and highest level of the chosen range (3M, 6M or 1Y of trading days).",
    formula: ["IV Rank = (IV_now − IV_min) / (IV_max − IV_min) × 100", "IV_min, IV_max: lowest and highest daily IV in the last N trading days (63, 126 or 252)"],
    computedBy: { frontend: "rankAt (lib/ivChart.ts)" },
    unit: "0 to 100", sign: "No sign: 0 is the range low, 100 the range high.",
    inputs: [{ name: "IV", source: "India VIX daily close (the implied-volatility proxy; it is a 30-day measure of the index options, not the ATM IV of one expiry)", unit: "% per year", kind: "raw" }, { name: "N", source: "range selected on the page", unit: "trading days", kind: "raw" }],
    steps: ["Take the IV closes of the last N trading days, skipping days without one.", "If fewer than 80% of the N days have an IV, or fewer than N days exist, the figure is missing.", "Apply the formula; a flat range (max = min) gives no figure."],
    reading: { positive: "Not applicable (0 to 100).", negative: "Not applicable.", rising: "IV is moving towards the top of its range.", falling: "IV is moving towards the bottom.", nearZero: "IV is at or near the lowest level of the range." },
    assumptions: ["A single outlier day sets the min or max, so IV Rank can be dominated by one spike; read IV Percentile beside it.", "India VIX and the ATM IV of a given expiry are different measurements."],
  },
  iv_percentile: {
    id: "iv_percentile", version: "1", title: "IV Percentile",
    measures: "The share of days in the chosen range on which implied volatility was lower than today.",
    formula: ["IV Percentile = (number of days in the range with IV < IV_now) / (number of days with an IV in the range) × 100"],
    computedBy: { frontend: "rankAt (lib/ivChart.ts)" },
    unit: "0 to 100 (%)", sign: "No sign.",
    inputs: [{ name: "IV", source: "India VIX daily close", unit: "% per year", kind: "raw" }, { name: "N", source: "range selected", unit: "trading days", kind: "raw" }],
    steps: ["Take the same window as IV Rank.", "Count the days whose IV is strictly below today's.", "Divide by the days that have an IV."],
    reading: { positive: "Not applicable.", negative: "Not applicable.", rising: "Today's IV is higher than on a larger share of the range.", falling: "A smaller share.", nearZero: "IV is at or near the bottom of the range: almost every day in it had higher IV." },
    assumptions: ["Our reading bands (below 30 low, above 70 high) are our own thresholds.", "Observations are daily closes; intraday spikes are not in the history."],
  },
  hv_rv: {
    id: "hv_rv", version: "1", title: "HV and RV (10, 21 and 63 trading days)",
    measures: "Realised volatility of NIFTY's daily closes: HV with the mean return removed, RV (root mean square) without removing it.",
    formula: ["r_t = ln(C_t / C_(t−1))", "HV(n) = sqrt( (1/n) Σ (r_t − r̄)² × 252 ) × 100", "RV(n) = sqrt( (1/n) Σ r_t² × 252 ) × 100"],
    computedBy: { backend: "stdev_annual / hv (app/intraday/hv.py)" },
    unit: "% per year", sign: "Always positive.",
    inputs: [{ name: "C_t", source: "stored final daily NIFTY 50 closes", unit: "index points", kind: "raw" }, { name: "n", source: "window: 10, 21 (1M) or 63 (3M) returns", unit: "trading days", kind: "raw" }, { name: "252", source: "trading days per year convention", unit: "days", kind: "raw" }],
    steps: ["Compute daily log returns of consecutive closes.", "Take the last n returns; a return that spans more than 5 calendar days is counted and reported as a gap.", "Apply the formula; the population variance (divide by n) is used."],
    reading: { positive: "Always positive.", negative: "Not applicable.", rising: "Realised movement is increasing.", falling: "Realised movement is decreasing.", nearZero: "Very quiet closes." },
    assumptions: ["Close-to-close returns miss intraday range.", "Implied volatility is annualised on calendar time to expiry, realised on 252 trading days: comparable, not identical in basis."],
  },
  iv_minus_hv: {
    id: "iv_minus_hv", version: "1", title: "IV − HV and IV − RV",
    measures: "How far implied volatility is above (or below) the volatility NIFTY has actually realised over the window.",
    formula: ["IV − HV(n) = IV_now − HV(n)", "IV − RV(n) = IV_now − RV(n)"],
    computedBy: { frontend: "IvChartBody (components/IvChartPages.tsx)", backend: "hv_report (app/intraday/hv.py)" },
    unit: "implied-volatility points", sign: "Implied minus realised. Positive: options priced above recent realised movement.",
    inputs: [{ name: "IV", source: "India VIX close", unit: "% per year", kind: "raw" }, { name: "HV(n), RV(n)", source: "see HV and RV", unit: "% per year", kind: "derived" }],
    steps: ["Take IV and HV or RV on the same newest day that has an India VIX.", "Subtract."],
    reading: { positive: "Implied volatility above realised: a volatility risk premium, or an event priced in.", negative: "Realised above implied: options cheap against recent movement.", rising: "The premium is widening.", falling: "The premium is narrowing.", nearZero: "Implied and realised agree." },
    assumptions: ["India VIX is a 30-day index measure, not the IV of one expiry.", "A positive spread is not by itself a trade signal."],
  },
  oi_premium_class: {
    id: "oi_premium_class", version: "1", title: "Premium and OI classification (per strike)",
    measures: "How each option's premium and open interest moved between two stored snapshots, and the indicative reading of that pair of moves.",
    formula: ["Premium % = (premium_now / premium_then − 1) × 100", "OI % = (OI_now / OI_then − 1) × 100", "OI change since previous session = OI_now − OI_previous_day (stored by the broker feed)", "Premium ↑ and OI ↑ → potential long buildup; premium ↓ and OI ↑ → potential short buildup (or time/volatility compression); premium ↑ and OI ↓ → potential short covering; premium ↓ and OI ↓ → potential long unwinding. A move smaller than 0.5 % on either measure reads no clear change."],
    computedBy: { backend: "strike_table / classify (app/intraday/strike_positioning.py)" },
    unit: "% for premium and OI moves; contracts (units, lot size 65 not applied) for OI changes", sign: "Positive: increase since the comparison snapshot.",
    inputs: [
      { name: "premium, OI, volume", source: "stored option-chain snapshots (last traded price, OI, volume per contract)", unit: "₹, units, units", kind: "raw" },
      { name: "IV, delta", source: "Black-76 solve of each contract's price on the forward from put-call parity", unit: "% per year, fraction", kind: "derived" },
      { name: "comparison snapshot", source: "5/15/30/60 minutes earlier (nearest before, within 2 or 5 minutes), session open, or previous session's last sample", unit: "timestamp", kind: "raw" },
    ],
    steps: ["Read both snapshots of the expiry.", "Compute each side's premium %, OI % and IV change per strike; a contract missing at either time has its change left missing.", "Apply the 0.5 % threshold, then the label table."],
    reading: {
      positive: "OI or premium rose since the comparison snapshot.", negative: "OI or premium fell.", rising: "More contracts are open, or the option is richer.", falling: "Contracts are closing, or the option is cheaper.",
      nearZero: "Little change: no clear reading.",
    },
    assumptions: ["OI rising means contracts were opened; it does not say whether buyers or sellers initiated them. Every label starts with 'potential'.", "An option's premium also moves with NIFTY, time and IV: a premium fall with OI rising can be time-value decay, not writing.", "Kotak's own change field is a price change and is not used; OI change is computed locally."],
  },
  premium_asymmetry: {
    id: "premium_asymmetry", version: "1", title: "Aggregate premium, baskets and premium asymmetry",
    measures: "How much the total premium of calls and of puts moved over a basket of strikes, and which side moved more.",
    formula: ["CE basket = Σ premium of the call at each strike in the basket (same for PE)", "Change = basket_now − basket_then;  % = (basket_now / basket_then − 1) × 100", "Premium asymmetry = |PE premium change| / |CE premium change|", "Fixed basket: strikes within n of the ATM at the comparison time. Dynamic basket: strikes within n of each snapshot's own ATM."],
    computedBy: { backend: "baskets / asymmetry (app/intraday/strike_positioning.py)" },
    unit: "₹ per unit for premium; ratio is unitless", sign: "Change: now minus then. The ratio is always positive and does not say which side rose.",
    inputs: [{ name: "premium", source: "stored last traded prices, both snapshots", unit: "₹ per unit", kind: "raw" }, { name: "n", source: "5, 10, 20 listed strikes or all", unit: "strikes", kind: "raw" }],
    steps: ["Choose the strikes of the basket.", "Keep only strikes priced at both times (a change is never between two different sets of strikes).", "Sum both sides, subtract, divide.", "The ratio is shown only when the call change is at least 0.2 % of the call basket; otherwise it is missing, never infinite."],
    reading: { positive: "A ratio above 1: puts changed by more than calls.", negative: "A ratio cannot be negative; read the signed changes beside it.", rising: "Puts are moving more relative to calls.", falling: "Calls are moving more relative to puts.", nearZero: "Puts barely moved against calls." },
    assumptions: ["Equal weighting: far-OTM strikes with small premiums count the same as ATM only in rupees, so large ATM premiums dominate.", "The fixed and dynamic baskets answer different questions and are never combined."],
  },
  demand_classifier: {
    id: "demand_classifier", version: "1", title: "Upside and downside demand reading",
    measures: "A rule-based reading of what the combined premium, IV, OI and volume moves of the out-of-the-money options are consistent with.",
    formula: ["Groups: OTM calls (strike above ATM) and OTM puts (strike below ATM), each split into near (|Δ| > 0.10) and deep (|Δ| ≤ 0.10)", "Each label has a list of conditions (e.g. premium rising, IV rising, OI rising, volume rising, NIFTY rising or falling)", "A label is shown only if at least 3 of its conditions hold and at least 75 % of its list; otherwise INSUFFICIENT EVIDENCE"],
    computedBy: { backend: "demand / group_summary (app/intraday/strike_positioning.py)" },
    unit: "conditions met out of conditions listed", sign: "Not applicable: labels, not signed values.",
    inputs: [{ name: "group premium %, OI %, mean IV change, volume change", source: "sums and means over the group's strikes that have the value at both times", unit: "%, %, IV points, units", kind: "derived" }, { name: "NIFTY change", source: "spot stored with each snapshot", unit: "%", kind: "raw" }],
    steps: ["Summarise each group over its strikes (missing contracts are counted and excluded).", "Test each label's conditions (thresholds: premium and OI beyond ±0.5 %, IV and volume beyond zero, NIFTY beyond ±0.05 %).", "Show the best label that meets the evidence bar, with the conditions that hold and those that do not."],
    reading: { positive: "Not applicable.", negative: "Not applicable.", rising: "More conditions supporting a label.", falling: "Fewer.", nearZero: "INSUFFICIENT EVIDENCE is the normal outcome when moves are small or mixed." },
    assumptions: ["Bid/ask trade direction is not stored, so who was the aggressor is unknown.", "Writing and buying can produce the same premium and OI pattern; labels are consistent-with readings, not facts.", "The thresholds and the 3-condition bar are our own and are not calibrated."],
  },
  gex_core: {
    id: "gex_core", version: "2", title: "Gamma exposure (GEX), walls, peak and gamma flip",
    measures: "How much the underlying a hedger would hold changes for a 1 % move in NIFTY, summed over the options at each strike, under a stated sign assumption.",
    formula: [
      "GEX_strike = Gamma × OI × Spot² × 0.01 / 10⁷    (₹ crore of underlying per 1 % move; OI in units)",
      "Call GEX = +GEX of the call;  Put GEX = −GEX of the put;  Net GEX = Call GEX + Put GEX;  Absolute GEX = Call GEX + |Put GEX|",
      "Gamma (Black-76) = e^((carry−rate)·t) · φ(d1) / (Spot · σ · √t), with σ the contract's own implied volatility",
      "Call wall = strike ≥ spot with the largest call GEX;  Put wall = strike ≤ spot with the largest |put GEX|;  Peak gamma = strike with the largest absolute GEX",
      "Gamma flip = spot level (within ±8 %) where aggregate net GEX changes sign, every contract re-priced there with its own IV; the crossing nearest spot if there are several; none if there is no crossing",
    ],
    computedBy: { frontend: "gexProfile / gexLevels / gammaFlip (lib/gammaAnalysis.ts)" },
    unit: "₹ crore per 1 % move", sign: "Calls positive and puts negative is a MODEL ASSUMPTION (customers long calls and short puts, dealers the opposite). It is not observed dealer inventory. Alternatives are shown in the sign scenarios.",
    inputs: [
      { name: "OI", source: "stored chain open interest, already in units (contracts × lot size 65): the lot size is therefore NOT multiplied in again", unit: "units", kind: "raw" },
      { name: "Spot", source: "NIFTY at the snapshot", unit: "index points", kind: "raw" },
      { name: "σ, t", source: "implied volatility solved from each contract's price (Black-76); time to the expiry close in calendar years", unit: "per year, years", kind: "derived" },
    ],
    steps: ["Solve each contract's implied volatility and gamma.", "Multiply by OI, Spot² and 0.01, divide by 10⁷.", "Apply the sign, sum by strike.", "A contract without a usable price, volatility or OI contributes nothing and is counted as excluded, never as zero."],
    reading: {
      positive: "Under the sign assumption hedging leans against moves (it sells strength, buys weakness): a stabilising, range-bound tendency.",
      negative: "Hedging would follow moves (buys strength, sells weakness): an amplifying tendency.",
      rising: "Net exposure is moving towards the stabilising side.", falling: "Net exposure is moving towards the amplifying side.",
      nearZero: "Call and put gamma roughly offset; near the flip a small move can change the regime.",
    },
    assumptions: ["Dealer positioning is not observed. If the real position were the reverse, every sign would invert.", "Gamma uses each contract's own IV; the profile is a snapshot and changes as spot, time and IV move.", "Walls use GEX, not OI alone. Expiry-day gamma is very large and unstable, so near the expiry close the figures are least reliable.", "Spot² uses the snapshot spot; the 0.01 turns gamma per point into per 1 % move."],
  },
  gex_universes: {
    id: "gex_universes", version: "1", title: "Fixed, dynamic and full-chain GEX universes",
    measures: "The same GEX calculation over three different sets of strikes, so a change in the strike set is never mistaken for a change in positioning.",
    formula: ["Fixed = the ATM ± 10 strikes chosen at the session open and kept all day", "Dynamic = the ATM ± 10 strikes around the current spot, re-chosen at every snapshot", "Full = every listed strike of the expiry", "All three use the same chain, expiry, OI units, rate, sign convention and missing-data rule"],
    computedBy: { frontend: "gexUniverses (lib/gexIntel.ts)" },
    unit: "₹ crore per 1 % move", sign: "As in GEX: calls positive, puts negative (model assumption).",
    inputs: [{ name: "Opening ATM", source: "the ATM strike of the session's first stored snapshot", unit: "strike", kind: "derived", note: "without it the fixed universe is not shown" }, { name: "Chain", source: "stored or live option chain of the chosen expiry", unit: "—", kind: "raw" }],
    steps: ["Choose the strikes of each universe.", "Run the GEX calculation on only those strikes.", "Report strikes listed, strikes with an exposure and strikes excluded."],
    reading: { positive: "Net GEX of that universe is on the stabilising side.", negative: "On the amplifying side.", rising: "More stabilising.", falling: "More amplifying.", nearZero: "Offsetting call and put exposure within that set of strikes." },
    assumptions: ["The three universes can disagree in sign: the fixed set lags a moving market, the dynamic set follows it, the full chain includes far strikes.", "Fixed and dynamic are never combined or averaged."],
  },
  gex_sign_scenarios: {
    id: "gex_sign_scenarios", version: "1", title: "Sign-convention sensitivity",
    measures: "How the aggregate net GEX would read under other assumptions about who holds each option.",
    formula: ["Net(scenario) = s_call × Σ Call GEX + s_put × Σ |Put GEX|", "Default: s_call = +1, s_put = −1;  Reversed: −1, +1;  Dealers long both: +1, +1;  Dealers short both: −1, −1"],
    computedBy: { frontend: "scenarioNet (lib/gexIntel.ts)" },
    unit: "₹ crore per 1 % move", sign: "Set by the scenario row.",
    inputs: [{ name: "Σ Call GEX, Σ |Put GEX|", source: "the profile of the chosen universe", unit: "₹ crore", kind: "derived" }],
    steps: ["Sum the call exposure and the put magnitude over strikes with both sides available.", "Apply each scenario's signs."],
    reading: { positive: "That scenario would be net stabilising.", negative: "Net amplifying.", rising: "Not applicable.", falling: "Not applicable.", nearZero: "Call and put exposure offset under that scenario." },
    assumptions: ["This is a sensitivity table, not a measurement: no scenario is verified.", "The gamma flip is shown for the default sign only."],
  },
  gamma_density: {
    id: "gamma_density", version: "1", title: "Gamma density",
    measures: "A smoothed picture of where call gamma (\"sell gamma\"), put gamma (\"buy gamma\") and their total concentrate across strikes.",
    formula: ["density(x) = Σ_strike GEX_strike × K(x − strike)", "K(u) = exp(−u² / 2h²) / smooth, h = 1.5 × median strike gap × smooth", "Sell = Σ Call GEX K; Buy = Σ |Put GEX| K; Total = Sell + Buy; the sell/buy intersection is where Sell − Buy changes sign"],
    computedBy: { frontend: "gammaDensity (lib/gammaAnalysis.ts)" },
    unit: "₹ crore per 1 % move (smoothed)", sign: "Sell is the call side, buy the put side, both plotted positive.",
    inputs: [{ name: "GEX per strike", source: "the GEX profile of the full chain", unit: "₹ crore", kind: "derived" }, { name: "smooth", source: "1 (normal) or 2 (extra wide), set on the page", unit: "factor", kind: "raw" }],
    steps: ["Take each strike's call and put exposure.", "Spread each over its neighbours with a Gaussian of the stated width.", "Sum, then find each peak and the sell/buy crossings. Raw bars are on the profile chart above."],
    reading: { positive: "Not applicable (densities are positive).", negative: "Not applicable.", rising: "Concentration is building at that price.", falling: "It is thinning.", nearZero: "Little gamma near that price." },
    assumptions: ["Smoothing moves peaks slightly; the strike-level bars are the exact values.", "The names sell/buy gamma follow the same unverified sign assumption as GEX."],
  },
  gex_dynamics: {
    id: "gex_dynamics", version: "1", title: "Intraday GEX dynamics",
    measures: "How net GEX, the flip and the walls moved through the session, on 1, 3, 5 or 15-minute candles, for the fixed and the dynamic universe separately.",
    formula: ["Net GEX change = Net(t) − Net(t−1);  % change = change / |Net(t−1)| × 100", "Rate of change = change / minutes between candles;  Acceleration = rate(t) − rate(t−1)", "Persistence = consecutive candles with the same direction of change, and the share of the last 10 changes that agree", "Migration = last − first value of the flip, wall or peak; time above/below flip = minutes the spot was above/below that candle's flip"],
    computedBy: { frontend: "gexDynamics / migration / flipTime (lib/gexIntel.ts)" },
    unit: "₹ crore per 1 % move (change), per minute (rate), index points (levels)", sign: "Positive change: net GEX rose (more stabilising).",
    inputs: [{ name: "Candles", source: "the last stored sample of each N-minute candle, from the stored strike series (21 strikes around the opening ATM; 41 around the current ATM for the dynamic set)", unit: "—", kind: "raw" }],
    steps: ["Build each candle's GEX profile and levels (same calculation as the snapshot).", "Compare consecutive candles.", "Missing flips or walls are skipped, not carried forward."],
    reading: { positive: "Net GEX rising.", negative: "Net GEX falling.", rising: "Exposure is shifting to the stabilising side.", falling: "Shifting to the amplifying side.", nearZero: "No change over the candle." },
    assumptions: ["Only the strikes in the stored series enter, so totals differ from the full-chain snapshot.", "Fixed and dynamic results are shown in separate tables and never merged."],
  },
  gex_divergence: {
    id: "gex_divergence", version: "1", title: "GEX-price divergence",
    measures: "Whether NIFTY and net GEX moved together or apart over 5, 15, 30, 60 minutes and the session, and what that combination is consistent with.",
    formula: ["Spot change = Spot(now) − Spot(then);  % = (Spot(now) / Spot(then) − 1) × 100", "Net change = Net(now) − Net(then);  % = change / |Net(then)| × 100", "Flat NIFTY: |%| < 0.05;  unchanged GEX: |change| < 5 % of the larger of |Net(now)|, |Net(then)|", "Spot ↑ & net more negative: potentially amplifying;  Spot ↑ & more positive: potentially stabilising;  Spot ↓ & more negative: potential downside amplification;  Spot ↓ & more positive: potential stabilisation"],
    computedBy: { frontend: "gexPriceDivergence (lib/gexIntel.ts)" },
    unit: "index points and %, ₹ crore and %", sign: "Changes are now minus then.",
    inputs: [{ name: "Spot, Net GEX", source: "the 5-minute candle series of the chosen universe", unit: "points, ₹ crore", kind: "derived" }, { name: "then", source: "the candle nearest before now − N minutes (within a quarter of N, at least 2 minutes); the first candle for the session", unit: "timestamp", kind: "raw" }],
    steps: ["Pick the two candles.", "Compute both changes.", "Apply the thresholds and the table of readings."],
    reading: { positive: "Not applicable (labels).", negative: "Not applicable.", rising: "A growing negative net GEX with a trending NIFTY is the amplifying pattern.", falling: "A growing positive net GEX with a trending NIFTY is the stabilising pattern.", nearZero: "Flat NIFTY or unchanged GEX gives no reading." },
    assumptions: ["The readings rest on the unverified dealer sign assumption.", "Thresholds are ours and uncalibrated.", "A divergence is a description of two series, not a forecast."],
  },
};
