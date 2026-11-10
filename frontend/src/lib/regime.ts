/**
 * Rule-based market regime from metrics other sections have already computed (it recalculates none of them). Every condition is a
 * stated threshold on one input; an input that is missing makes its conditions "not evaluable", never false. The scores are counts
 * of conditions met out of conditions evaluable, scaled to 0-100: they are indices, not probabilities. Confidence is the product of
 * how complete the evidence is and how strongly the directional evidence agrees, shown as its two parts. Registry id: regime_classifier.
 */
export interface RegimeInputs {
  /** NIFTY change over the comparison window, percent */
  spotPct: number | null;
  /** ATM IV change over the same window, IV points (mean of the call and put change) */
  atmIvChange: number | null;
  /** 25-delta call-over-put IV momentum over the window, IV points (positive: call IV strengthened relative to put IV) */
  momentum25: number | null;
  /** 25-delta skew, put minus call, IV points; 25-delta butterfly, IV points */
  skew25: number | null; butterfly25: number | null;
  /** IV (India VIX) minus HV 1M, points */
  ivMinusHv: number | null;
  /** demand labels of the four OTM groups from the positioning section: "CE:otm" -> label */
  demand: Partial<Record<"CE:otm" | "CE:deep" | "PE:otm" | "PE:deep", string>> | null;
  /** aggregate net GEX of the chosen universe (₹ crore per 1 %) and the gamma flip */
  netGex: number | null; flip: number | null; spot: number | null;
  /** the GEX-price relationship over the same window, from the same GEX universe as `netGex` (see lib/gexIntel.ts gexPriceDivergence) */
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
};

export type RegimeName =
  | "Bullish volatility expansion" | "Bullish volatility contraction" | "Bearish volatility expansion" | "Bearish volatility contraction"
  | "Range-bound / positive gamma" | "Negative gamma / momentum amplification" | "Uncertainty expansion" | "Mixed / conflicting signals" | "Insufficient data";

export interface Evidence { id: string; text: string; side: "bull" | "bear" | "vol" | "gamma"; met: boolean | null }
export interface RegimeResult {
  regime: RegimeName; direction: "bullish" | "bearish" | "neutral" | "conflicting"; volatility: "expanding" | "contracting" | "stable" | "unknown";
  gamma: "positive" | "negative" | "near flip" | "unknown";
  upsideScore: number | null; downsideScore: number | null; stabilityScore: number | null;
  confidence: { level: "High" | "Medium" | "Low"; completeness: number; agreement: number | null };
  /** the GEX-side readings shown beside the regime, all from one universe */
  gexView: { universe: string | null; spotPct: number | null; netChange: number | null; netPct: number | null; gammaRegime: "positive" | "negative" | "near flip" | "unknown"; relationship: string | null; flipDistancePct: number | null; nearAtmNet: number | null };
  supporting: string[]; contradicting: string[]; unavailable: string[]; evidence: Evidence[];
}

/** thresholds, all ours and uncalibrated (listed in the methodology panel) */
export const T = { spot: 0.1, ivMove: 0.3, momentum: 0.2, nearFlip: 0.2, minEvaluable: 5, directionGap: 2, skewBear: 3, butterfly: 1 } as const;

const gt = (v: number | null, lim: number): boolean | null => (v == null ? null : v > lim);
const lt = (v: number | null, lim: number): boolean | null => (v == null ? null : v < -lim);
const is = (v: string | undefined | null, ...labels: string[]): boolean | null => (v == null ? null : labels.includes(v));

export function classifyRegime(i: RegimeInputs): RegimeResult {
  const d = i.demand;
  const dist = i.flip != null && i.spot ? Math.abs(i.spot - i.flip) / i.spot * 100 : null;
  const ev: Evidence[] = [
    { id: "spot_up", text: `NIFTY up more than ${T.spot}%`, side: "bull", met: gt(i.spotPct, T.spot) },
    { id: "mom_up", text: `call IV strengthened relative to put IV (25Δ momentum above +${T.momentum})`, side: "bull", met: gt(i.momentum25, T.momentum) },
    { id: "ce_spec", text: "OTM calls read as upside speculation", side: "bull", met: d ? is(d["CE:otm"], "Upside speculation") : null },
    { id: "pe_write", text: "OTM puts read as put writing", side: "bull", met: d ? is(d["PE:otm"], "Put writing") : null },
    { id: "skew_call", text: "calls priced at or above puts at 25Δ (skew ≤ 0)", side: "bull", met: i.skew25 == null ? null : i.skew25 <= 0 },
    { id: "spot_dn", text: `NIFTY down more than ${T.spot}%`, side: "bear", met: lt(i.spotPct, T.spot) },
    { id: "mom_dn", text: `put IV strengthened relative to call IV (25Δ momentum below −${T.momentum})`, side: "bear", met: lt(i.momentum25, T.momentum) },
    { id: "pe_spec", text: "OTM puts read as downside speculation", side: "bear", met: d ? is(d["PE:otm"], "Downside speculation") : null },
    { id: "ce_write", text: "OTM calls read as call writing", side: "bear", met: d ? is(d["CE:otm"], "Call writing") : null },
    { id: "skew_put", text: `puts priced ${T.skewBear}+ points above calls at 25Δ`, side: "bear", met: i.skew25 == null ? null : i.skew25 >= T.skewBear },
    { id: "iv_up", text: `ATM IV rose more than ${T.ivMove} points`, side: "vol", met: gt(i.atmIvChange, T.ivMove) },
    { id: "iv_dn", text: `ATM IV fell more than ${T.ivMove} points`, side: "vol", met: lt(i.atmIvChange, T.ivMove) },
    { id: "wings", text: `25Δ wings priced more than ${T.butterfly} point above ATM (butterfly)`, side: "vol", met: gt(i.butterfly25, T.butterfly) },
    { id: "iv_rich", text: "IV above one-month realised volatility (IV − HV > 0)", side: "vol", met: gt(i.ivMinusHv, 0) },
    { id: "tail", text: "deep OTM options read as tail hedging or speculation", side: "vol", met: d ? ["CE:deep", "PE:deep"].some((k) => is(d[k as "CE:deep"], "Upside tail hedging", "Downside tail hedging", "Upside speculation", "Downside speculation")) : null },
    { id: "gex_pos", text: "net GEX positive (model sign) and spot not within 0.2% of the flip", side: "gamma", met: i.netGex == null ? null : i.netGex >= 0 && !(dist != null && dist <= T.nearFlip) },
    { id: "gex_neg", text: "net GEX negative (model sign)", side: "gamma", met: i.netGex == null ? null : i.netGex < 0 },
    { id: "gex_amp", text: "NIFTY and net GEX move so that hedging could amplify (potentially, not guaranteed)", side: "gamma", met: i.divergence == null || i.divergence === "unavailable" ? null : i.divergence === "amplifying" },
    { id: "gex_stab", text: "NIFTY and net GEX move so that hedging could stabilise (potentially, not guaranteed)", side: "gamma", met: i.divergence == null || i.divergence === "unavailable" ? null : i.divergence === "stabilising" },
    { id: "near_neg", text: "near-ATM net GEX negative", side: "gamma", met: i.nearAtmNet == null ? null : i.nearAtmNet < 0 },
    { id: "near_pos", text: "near-ATM net GEX positive", side: "gamma", met: i.nearAtmNet == null ? null : i.nearAtmNet >= 0 },
  ];
  const by = (side: Evidence["side"]) => ev.filter((e) => e.side === side);
  const w = (e: Evidence) => WEIGHTS[e.id] ?? 1;
  const count = (es: Evidence[]) => es.filter((e) => e.met === true).reduce((a, e) => a + w(e), 0);
  const possible = (es: Evidence[]) => es.filter((e) => e.met !== null).reduce((a, e) => a + w(e), 0);
  const bull = count(by("bull")), bear = count(by("bear"));
  const evaluable = ev.filter((e) => e.met !== null).length;
  const direction: RegimeResult["direction"] = bull - bear >= T.directionGap ? "bullish" : bear - bull >= T.directionGap ? "bearish" : bull >= 2 && bear >= 2 ? "conflicting" : "neutral";
  const vol: RegimeResult["volatility"] = i.atmIvChange == null ? "unknown" : i.atmIvChange >= T.ivMove ? "expanding" : i.atmIvChange <= -T.ivMove ? "contracting" : "stable";
  const gamma: RegimeResult["gamma"] = i.netGex == null ? "unknown" : dist != null && dist <= T.nearFlip ? "near flip" : i.netGex >= 0 ? "positive" : "negative";
  const moved = i.spotPct != null && Math.abs(i.spotPct) >= T.spot;

  let regime: RegimeName;
  if (evaluable < T.minEvaluable) regime = "Insufficient data";
  else if (moved && (gamma === "negative" || i.divergence === "amplifying")) regime = "Negative gamma / momentum amplification";
  else if (direction === "bullish" && vol === "expanding") regime = "Bullish volatility expansion";
  else if (direction === "bullish" && vol === "contracting") regime = "Bullish volatility contraction";
  else if (direction === "bearish" && vol === "expanding") regime = "Bearish volatility expansion";
  else if (direction === "bearish" && vol === "contracting") regime = "Bearish volatility contraction";
  else if (vol === "expanding" && (direction === "neutral" || direction === "conflicting")) regime = "Uncertainty expansion";
  else if (direction === "neutral" && gamma === "positive" && vol !== "expanding") regime = "Range-bound / positive gamma";
  else regime = "Mixed / conflicting signals";

  const ratio = (es: Evidence[]) => { const n = possible(es); return n ? Math.round((count(es) / n) * 100) : null; };
  const stableConds: Evidence[] = [ev.find((e) => e.id === "gex_pos")!, ev.find((e) => e.id === "gex_stab")!, ev.find((e) => e.id === "near_pos")!, { id: "iv_calm", text: "ATM IV not expanding", side: "vol", met: i.atmIvChange == null ? null : i.atmIvChange < T.ivMove }, { id: "flat", text: "NIFTY flat", side: "vol", met: i.spotPct == null ? null : Math.abs(i.spotPct) < T.spot }];
  const dirEvaluable = by("bull").concat(by("bear")).filter((e) => e.met !== null).length;
  const completeness = Math.round((evaluable / ev.length) * 100) / 100;
  const agreement = bull + bear === 0 ? null : Math.round((Math.max(bull, bear) / (bull + bear)) * 100) / 100;
  const level: RegimeResult["confidence"]["level"] = completeness >= 0.8 && (agreement ?? 0) >= 0.75 && dirEvaluable >= 3 ? "High" : completeness >= 0.6 && (agreement ?? 0) >= 0.6 ? "Medium" : "Low";
  const chosenSide = direction === "bullish" ? "bull" : direction === "bearish" ? "bear" : null;
  return {
    regime, direction, volatility: vol, gamma,
    upsideScore: ratio(by("bull")), downsideScore: ratio(by("bear")), stabilityScore: ratio(stableConds),
    confidence: { level: regime === "Insufficient data" ? "Low" : level, completeness, agreement },
    supporting: ev.filter((e) => e.met === true && (chosenSide ? e.side === chosenSide || e.side !== (chosenSide === "bull" ? "bear" : "bull") : true)).map((e) => e.text),
    contradicting: ev.filter((e) => e.met === true && chosenSide != null && e.side === (chosenSide === "bull" ? "bear" : "bull")).map((e) => e.text),
    unavailable: ev.filter((e) => e.met === null).map((e) => e.text), evidence: ev,
    gexView: { universe: i.universe ?? null, spotPct: i.spotPct, netChange: i.gexNetChange ?? null, netPct: i.gexNetPct ?? null, gammaRegime: gamma, relationship: i.divergenceLabel ?? null, flipDistancePct: i.flip != null && i.spot ? ((i.flip - i.spot) / i.spot) * 100 : null, nearAtmNet: i.nearAtmNet ?? null },
  };
}
