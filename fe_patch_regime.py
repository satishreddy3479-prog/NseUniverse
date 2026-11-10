R = r"C:\Users\SATISH~1\AppData\Local\Temp\claude\S--Nseuniverse\fd06f634-3462-470d-ac50-67680b70a03e\scratchpad\repo_main\frontend\src"
p = R + r"\lib\regime.ts"
s = open(p, encoding="utf-8").read()

s = s.replace('''  /** reading of the GEX-price divergence, if computed */
  divergence: "amplifying" | "stabilising" | "none" | "unavailable" | null;
}''', '''  /** the GEX-price relationship over the same window, from the same GEX universe as `netGex` (see lib/gexIntel.ts gexPriceDivergence) */
  divergence: "amplifying" | "stabilising" | "none" | "unavailable" | null;
  /** its label, the net GEX change (₹ crore) and percentage over the window, and the universe they belong to (shown, never mixed) */
  divergenceLabel?: string | null; gexNetChange?: number | null; gexNetPct?: number | null; universe?: string | null;
  /** net GEX of the ATM ± 5 strikes of that universe */
  nearAtmNet?: number | null;
}

/** Weight of every condition in the direction gap and the scores. All are 1: no condition is trusted more than another, because none has been calibrated. */
export const WEIGHTS: Record<string, number> = {
  spot_up: 1, mom_up: 1, skew_call: 1, ce_spec: 1, pe_write: 1, spot_dn: 1, mom_dn: 1, skew_put: 1, pe_spec: 1, ce_write: 1,
  iv_up: 1, iv_dn: 1, wings: 1, iv_rich: 1, tail: 1, gex_pos: 1, gex_neg: 1, gex_amp: 1, gex_stab: 1, near_neg: 1, near_pos: 1,
};''', 1)

s = s.replace('''  confidence: { level: "High" | "Medium" | "Low"; completeness: number; agreement: number | null };''', '''  confidence: { level: "High" | "Medium" | "Low"; completeness: number; agreement: number | null };
  /** the GEX-side readings shown beside the regime, all from one universe */
  gexView: { universe: string | null; spotPct: number | null; netChange: number | null; netPct: number | null; gammaRegime: "positive" | "negative" | "near flip" | "unknown"; relationship: string | null; flipDistancePct: number | null; nearAtmNet: number | null };''', 1)

s = s.replace('''    { id: "gex_amp", text: "GEX-price divergence reads amplifying", side: "gamma", met: i.divergence == null || i.divergence === "unavailable" ? null : i.divergence === "amplifying" },''', '''    { id: "gex_amp", text: "NIFTY and net GEX move so that hedging could amplify (potentially, not guaranteed)", side: "gamma", met: i.divergence == null || i.divergence === "unavailable" ? null : i.divergence === "amplifying" },
    { id: "gex_stab", text: "NIFTY and net GEX move so that hedging could stabilise (potentially, not guaranteed)", side: "gamma", met: i.divergence == null || i.divergence === "unavailable" ? null : i.divergence === "stabilising" },
    { id: "near_neg", text: "near-ATM net GEX negative", side: "gamma", met: i.nearAtmNet == null ? null : i.nearAtmNet < 0 },
    { id: "near_pos", text: "near-ATM net GEX positive", side: "gamma", met: i.nearAtmNet == null ? null : i.nearAtmNet >= 0 },''', 1)

# weighted counts
s = s.replace("  const count = (es: Evidence[]) => es.filter((e) => e.met === true).length;", "  const w = (e: Evidence) => WEIGHTS[e.id] ?? 1;\n  const count = (es: Evidence[]) => es.filter((e) => e.met === true).reduce((a, e) => a + w(e), 0);\n  const possible = (es: Evidence[]) => es.filter((e) => e.met !== null).reduce((a, e) => a + w(e), 0);", 1)
s = s.replace("const ratio = (es: Evidence[]) => { const n = es.filter((e) => e.met !== null).length; return n ? Math.round((count(es) / n) * 100) : null; };", "const ratio = (es: Evidence[]) => { const n = possible(es); return n ? Math.round((count(es) / n) * 100) : null; };", 1)

# amplification also when the divergence reads amplifying with a real move
s = s.replace('else if (gamma === "negative" && moved) regime = "Negative gamma / momentum amplification";', 'else if (moved && (gamma === "negative" || i.divergence === "amplifying")) regime = "Negative gamma / momentum amplification";', 1)
# stability conditions include the stabilising relationship and near-ATM
s = s.replace('const stableConds: Evidence[] = [ev.find((e) => e.id === "gex_pos")!,', 'const stableConds: Evidence[] = [ev.find((e) => e.id === "gex_pos")!, ev.find((e) => e.id === "gex_stab")!, ev.find((e) => e.id === "near_pos")!,', 1)

# gexView in the result
s = s.replace('''    unavailable: ev.filter((e) => e.met === null).map((e) => e.text), evidence: ev,
  };''', '''    unavailable: ev.filter((e) => e.met === null).map((e) => e.text), evidence: ev,
    gexView: { universe: i.universe ?? null, spotPct: i.spotPct, netChange: i.gexNetChange ?? null, netPct: i.gexNetPct ?? null, gammaRegime: gamma, relationship: i.divergenceLabel ?? null, flipDistancePct: i.flip != null && i.spot ? ((i.flip - i.spot) / i.spot) * 100 : null, nearAtmNet: i.nearAtmNet ?? null },
  };''', 1)
open(p, "w", encoding="utf-8").write(s)

# registry text for the regime
p = R + r"\lib\metricRegistry.ts"
r = open(p, encoding="utf-8").read()
r = r.replace('"The GEX-price divergence is not included in this version\'s inputs."', '"The GEX inputs (net GEX, near-ATM GEX, flip, divergence) all come from one universe, shown on the page; mixing universes is never done."', 1)
r = r.replace('{ name: "Net GEX, gamma flip", source: "GEX dynamic ATM ±10 universe (model sign)", unit: "₹ crore per 1 %, index points", kind: "derived" },', '{ name: "Net GEX, near-ATM GEX, gamma flip, GEX change over 15 minutes", source: "the server-rebuilt GEX history of the dynamic ATM ±10 universe (model sign)", unit: "₹ crore per 1 %, index points", kind: "derived" },\n      { name: "GEX-price relationship", source: "NIFTY change and net GEX change over the same 15 minutes (spot ±0.05 %, GEX ±5 % of the larger |net|)", unit: "label", kind: "derived" },', 1)
r = r.replace('"Upside / downside demand score = conditions met ÷ conditions evaluable × 100 (an index, not a probability);', '"Every condition has weight 1 (listed in WEIGHTS in lib/regime.ts): the direction gap, the scores and the confidence use weighted counts, so changing a weight changes all of them. Gamma-side conditions: net GEX < 0 or ≥ 0 (model sign), near-ATM net GEX < 0 or ≥ 0, relationship amplifying or stabilising. NIFTY up and net GEX more negative: potentially amplifying; up and more positive: potentially stabilising; down and more negative: potential downside amplification; down and more positive: potential stabilisation — none is guaranteed dealer hedging",\n      "Upside / downside demand score = weight met ÷ weight evaluable × 100 (an index, not a probability);', 1)
r = r.replace("negative gamma and |NIFTY move| ≥ 0.1 % → Negative gamma / momentum amplification;", "|NIFTY move| ≥ 0.1 % with negative net GEX or an amplifying GEX-price relationship → Negative gamma / momentum amplification;", 1)
open(p, "w", encoding="utf-8").write(r)
print("ok")
