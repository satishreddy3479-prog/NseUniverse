// Plain-language reading of a strategy, built only from numbers the page already has. Every sentence is a rule over
// those numbers (exact payoff, stored OI and quotes, and the labelled Black-76 model values); nothing is invented
// and nothing here is a forecast or advice.
import type { Leg } from "./strategy";

export interface Insight { level: "good" | "info" | "warn"; text: string }

export interface InsightInput {
  legs: Leg[]; // enabled legs
  spot: number;
  maxProfit: number | null; maxLoss: number | null; profitUnlimited: boolean; lossUnlimited: boolean;
  breakevens: number[];
  pop: number | null; // 0..1, model
  delta: number | null; thetaDay: number | null; // model, rupees
  bands: { m2: number; m1: number; p1: number; p2: number } | null;
  oi: { strike: number; call: number | null; put: number | null }[];
  stale: boolean;
  missingQuote: number; // legs without a stored LTP
}

const inr = (v: number) => `₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const k = (v: number) => Math.round(v).toLocaleString("en-IN");

export function strategyInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];
  if (i.legs.length === 0) return out;
  const shorts = i.legs.filter((l) => l.action === "SELL"), longs = i.legs.filter((l) => l.action === "BUY");

  // shape of the risk (exact)
  if (i.lossUnlimited) {
    out.push({ level: "warn", text: `Loss is unlimited ${shorts.some((l) => l.type === "CE") && shorts.some((l) => l.type === "PE") ? "on both sides" : shorts.some((l) => l.type === "CE") ? "if NIFTY rises" : "if NIFTY falls"}: there is no long option covering the short. A hedge or a stop on the short leg is what limits it.` });
  } else if (i.maxLoss != null) {
    out.push({ level: "good", text: `Risk is defined: the worst case at expiry is ${inr(i.maxLoss)}.` });
  }
  if (i.maxProfit != null && i.maxLoss != null && i.maxLoss < 0 && !i.lossUnlimited && !i.profitUnlimited) {
    const rr = i.maxProfit / -i.maxLoss;
    out.push({ level: rr >= 1 ? "good" : "info", text: `Reward to risk is ${rr.toFixed(2)} : 1 (${inr(i.maxProfit)} for ${inr(i.maxLoss)}).` });
  } else if (i.profitUnlimited && !i.lossUnlimited) {
    out.push({ level: "good", text: "Profit is unlimited on one side while the loss is capped." });
  }

  // chance of profit vs how it is earned (model)
  if (i.pop != null) {
    const p = Math.round(i.pop * 100);
    const lopsided = i.maxProfit != null && i.maxLoss != null && i.maxLoss < 0 && i.maxProfit / -i.maxLoss < 0.5 && i.pop > 0.6;
    out.push({ level: lopsided ? "warn" : "info", text: `Model chance of finishing in profit is about ${p}% (lognormal at the ATM implied volatility).${lopsided ? " A high chance with a small reward against a large loss means the occasional loss can erase many wins." : ""}` });
  }

  // where the breakevens sit against the expected move (model)
  if (i.bands && i.breakevens.length) {
    const inside1 = i.breakevens.filter((b) => b >= i.bands!.m1 && b <= i.bands!.p1).length;
    const outside2 = i.breakevens.filter((b) => b < i.bands!.m2 || b > i.bands!.p2).length;
    if (inside1 === i.breakevens.length && i.breakevens.length > 0 && shorts.length > longs.length) out.push({ level: "warn", text: `Both breakevens are inside the ±1σ expected move (${k(i.bands.m1)} to ${k(i.bands.p1)}): an ordinary move of that size reaches them.` });
    else if (outside2 > 0) out.push({ level: "info", text: `A breakeven lies outside the ±2σ range (${k(i.bands.m2)} to ${k(i.bands.p2)}), so it needs an unusually large move to be reached.` });
    else out.push({ level: "info", text: `Breakevens ${i.breakevens.map(k).join(" and ")} against a ±1σ expected move of ${k(i.bands.m1)} to ${k(i.bands.p1)} (model).` });
  }

  // direction and time decay (model)
  if (i.delta != null) {
    const band = Math.abs(i.delta) < 5 ? "close to direction-neutral" : i.delta > 0 ? "bullish" : "bearish";
    out.push({ level: "info", text: `Net delta is ${i.delta.toFixed(1)} (model): the position is ${band} right now.` });
  }
  if (i.thetaDay != null && Math.abs(i.thetaDay) >= 1) {
    out.push({ level: "info", text: i.thetaDay > 0 ? `Time decay works for you: about ${inr(i.thetaDay)} a day if nothing else changes (model).` : `Time decay works against you: about ${inr(i.thetaDay)} a day if nothing else changes (model).` });
  }

  // open-interest walls against the short strikes (stored data)
  const topCall = [...i.oi].filter((o) => o.call != null).sort((a, b) => (b.call ?? 0) - (a.call ?? 0))[0];
  const topPut = [...i.oi].filter((o) => o.put != null).sort((a, b) => (b.put ?? 0) - (a.put ?? 0))[0];
  if (topCall && topPut) {
    out.push({ level: "info", text: `Largest stored open interest: calls at ${k(topCall.strike)}, puts at ${k(topPut.strike)} (a common reference for resistance and support, not a guarantee).` });
    const sc = shorts.filter((l) => l.type === "CE" && l.strike < topCall.strike && l.strike > i.spot);
    const sp = shorts.filter((l) => l.type === "PE" && l.strike > topPut.strike && l.strike < i.spot);
    if (sc.length) out.push({ level: "info", text: `Your short call at ${k(sc[0]!.strike)} is nearer the money than the heaviest call OI at ${k(topCall.strike)}.` });
    if (sp.length) out.push({ level: "info", text: `Your short put at ${k(sp[0]!.strike)} is nearer the money than the heaviest put OI at ${k(topPut.strike)}.` });
  }

  // process warnings
  const unprotected = shorts.filter((l) => l.stop == null);
  if (shorts.length > 0 && unprotected.length === shorts.length && i.lossUnlimited) out.push({ level: "warn", text: "No stop-loss is set on any short leg." });
  if (i.missingQuote > 0) out.push({ level: "warn", text: `${i.missingQuote} leg${i.missingQuote > 1 ? "s have" : " has"} no stored quote, so P&L now and the model values for ${i.missingQuote > 1 ? "them are" : "it is"} unavailable.` });
  if (i.stale) out.push({ level: "warn", text: "The stored chain is stale: premiums and open interest are not current." });
  return out;
}
