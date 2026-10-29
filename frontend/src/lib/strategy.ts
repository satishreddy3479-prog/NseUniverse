/**
 * Options strategy engine: legs, expiry payoff, breakevens, maximum profit and loss, templates and validation.
 * Pure functions, no UI and no network. Everything here is exact arithmetic on the legs; no price is modelled.
 */

export type OptionType = "CE" | "PE";
export type Action = "BUY" | "SELL";

export interface Leg {
  id: string;
  expiry: string; // ISO date, the contract's expiry
  strike: number;
  type: OptionType;
  action: Action;
  lots: number; // whole lots
  premium: number | null; // entry premium per unit; null = not entered
  premiumSource: "market" | "manual" | null;
  /** false = kept in the table but left out of the payoff (the checkbox); default true */
  enabled?: boolean;
  /** manual implied volatility override for the model estimates, 0.15 = 15 % */
  iv?: number | null;
  /** premium level at which you plan to take profit / cut the loss, per unit (null = none) */
  target?: number | null;
  stop?: number | null;
}

export const sign = (a: Action) => (a === "BUY" ? 1 : -1);

// ---------------------------------------------------------------- expiry payoff
export const intrinsic = (l: Pick<Leg, "type" | "strike">, s: number) => Math.max(l.type === "CE" ? s - l.strike : l.strike - s, 0);

/** P&L of one leg at expiry, before costs. Null while the premium is missing. */
export function legExpiryPnl(l: Leg, s: number, lotSize: number): number | null {
  if (l.premium == null) return null;
  return sign(l.action) * (intrinsic(l, s) - l.premium) * l.lots * lotSize;
}

/** Strategy P&L at expiry (all legs share the expiry), before costs. Null if any premium is missing. */
export function expiryPnl(legs: Leg[], s: number, lotSize: number): number | null {
  let total = 0;
  for (const l of legs) {
    const p = legExpiryPnl(l, s, lotSize);
    if (p == null) return null;
    total += p;
  }
  return total;
}

export interface ExpiryAnalysis {
  /** false for multi-expiry strategies: an expiry payoff is only defined when every leg expires together */
  defined: boolean;
  reason?: string;
  breakevens: number[];
  /** finite best/worst P&L over S >= 0; null when unbounded */
  maxProfit: number | null;
  maxLoss: number | null;
  profitUnlimited: boolean;
  lossUnlimited: boolean;
  kinks: number[];
}

/**
 * Exact analysis: the payoff is piecewise linear with kinks at the strikes, so the extremes are at S = 0 or a strike
 * (or unbounded if the slope beyond the last strike is not zero), and every breakeven lies on one linear piece.
 */
export function analyzeExpiry(legs: Leg[], lotSize: number): ExpiryAnalysis {
  const none = { breakevens: [], maxProfit: null, maxLoss: null, profitUnlimited: false, lossUnlimited: false, kinks: [] as number[] };
  if (legs.length === 0) return { defined: false, reason: "Add at least one leg.", ...none };
  if (new Set(legs.map((l) => l.expiry)).size > 1) return { defined: false, reason: "The legs expire on different dates: there is no single expiry payoff. See the theoretical curve.", ...none };
  if (legs.some((l) => l.premium == null)) return { defined: false, reason: "Enter the entry premium of every leg.", ...none };
  const kinks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const pts = [0, ...kinks];
  const f = (s: number) => expiryPnl(legs, s, lotSize) as number;
  // slope above the last strike: calls only (puts are worthless there); below the first strike: puts only
  const upSlope = legs.reduce((a, l) => a + (l.type === "CE" ? sign(l.action) * l.lots * lotSize : 0), 0);
  const values = pts.map(f);
  const maxFinite = Math.max(...values), minFinite = Math.min(...values);
  const profitUnlimited = upSlope > 0, lossUnlimited = upSlope < 0;
  const be: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!, fa = values[i]!, fb = values[i + 1]!;
    if (fa === 0 && i === 0 && a > 0) be.push(a);
    if (fa * fb < 0) be.push(a + ((0 - fa) * (b - a)) / (fb - fa));
    else if (fb === 0 && b !== pts[pts.length - 1]) be.push(b);
  }
  const last = pts[pts.length - 1]!, flast = values[values.length - 1]!;
  if (upSlope !== 0) {
    const root = last - flast / upSlope; // linear beyond the last strike
    if (root > last) be.push(root);
  } else if (flast === 0 && !be.includes(last)) be.push(last);
  const uniq = [...new Set(be.map((x) => Math.round(x * 1e6) / 1e6))].filter((x) => x >= 0).sort((x, y) => x - y);
  return {
    defined: true, breakevens: uniq, kinks,
    maxProfit: profitUnlimited ? null : maxFinite, maxLoss: lossUnlimited ? null : minFinite,
    profitUnlimited, lossUnlimited,
  };
}

export function payoffCurve(legs: Leg[], lotSize: number, lo: number, hi: number, step: number): { s: number; pnl: number }[] {
  const out: { s: number; pnl: number }[] = [];
  if (!(step > 0) || hi < lo) return out;
  for (let s = lo; s <= hi + 1e-9; s += step) {
    const p = expiryPnl(legs, s, lotSize);
    if (p == null) return [];
    out.push({ s, pnl: p });
  }
  return out;
}

// ---------------------------------------------------------------- validation
export interface Issue { legId: string | null; field: string; message: string; level: "error" | "warning" }

export interface ValidationContext {
  expiries: string[]; // contracts the instrument master lists
  strikesByExpiry: Record<string, number[]>; // listed strikes per expiry, where known
  today: string; // ISO date
}

export function validateStrategy(legs: Leg[], ctx: ValidationContext): Issue[] {
  const out: Issue[] = [];
  for (const l of legs) {
    const err = (field: string, message: string) => out.push({ legId: l.id, field, message, level: "error" });
    if (!Number.isInteger(l.lots) || l.lots < 1) err("lots", "Lots must be a whole number of at least 1.");
    if (!Number.isFinite(l.strike) || l.strike <= 0) err("strike", "Strike must be a positive number.");
    if (!ctx.expiries.includes(l.expiry)) err("expiry", `${l.expiry} is not a listed expiry for this instrument.`);
    else if (l.expiry < ctx.today) err("expiry", "This expiry has passed.");
    const listed = ctx.strikesByExpiry[l.expiry];
    if (listed && listed.length && !listed.includes(l.strike)) err("strike", `${l.strike} is not a listed strike for ${l.expiry}.`);
    if (l.premium == null) out.push({ legId: l.id, field: "premium", message: "Entry premium is missing: enter it or use the market quote.", level: "warning" });
    else if (!Number.isFinite(l.premium) || l.premium < 0) err("premium", "Premium cannot be negative.");
  }
  const seen = new Set<string>();
  for (const l of legs) {
    const key = `${l.expiry}|${l.strike}|${l.type}|${l.action}`;
    if (seen.has(key)) out.push({ legId: l.id, field: "leg", message: "Duplicate of another leg: combine them with a larger lot count.", level: "warning" });
    seen.add(key);
  }
  return out;
}

// ---------------------------------------------------------------- templates
export interface TemplateContext {
  strikes: number[]; // listed strikes of the main expiry, any order
  atm: number; // the listed strike nearest the spot
  expiry: string;
  premium: (expiry: string, strike: number, type: OptionType) => number | null;
}
type Draft = Omit<Leg, "id">;
export interface Template { id: string; label: string; group: "Directional" | "Neutral" | "Spreads"; view: string; build: (c: TemplateContext) => Draft[] | { error: string } }

function strikeAt(c: TemplateContext, steps: number): number | null {
  const ks = [...c.strikes].sort((a, b) => a - b);
  const i = ks.indexOf(c.atm);
  const j = i + steps;
  return i < 0 || j < 0 || j >= ks.length ? null : ks[j]!;
}

function mk(c: TemplateContext, rows: [Action, OptionType, number, number?][]): Draft[] | { error: string } {
  const out: Draft[] = [];
  for (const [action, type, steps, lots = 1] of rows) {
    const strike = strikeAt(c, steps);
    if (strike == null) return { error: `The chain has no listed strike ${Math.abs(steps)} steps ${steps < 0 ? "below" : "above"} the ATM strike.` };
    const expiry = c.expiry;
    const premium = c.premium(expiry, strike, type);
    out.push({ expiry, strike, type, action, lots, premium, premiumSource: premium == null ? null : "market" });
  }
  return out;
}

export const TEMPLATES: Template[] = [
  { id: "long_call", label: "Long call", group: "Directional", view: "Bullish, limited risk", build: (c) => mk(c, [["BUY", "CE", 0]]) },
  { id: "long_put", label: "Long put", group: "Directional", view: "Bearish, limited risk", build: (c) => mk(c, [["BUY", "PE", 0]]) },
  { id: "short_call", label: "Short call", group: "Directional", view: "Bearish or flat, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 0]]) },
  { id: "short_put", label: "Short put", group: "Directional", view: "Bullish or flat, large risk", build: (c) => mk(c, [["SELL", "PE", 0]]) },
  { id: "long_straddle", label: "Long straddle", group: "Neutral", view: "Big move either way", build: (c) => mk(c, [["BUY", "CE", 0], ["BUY", "PE", 0]]) },
  { id: "short_straddle", label: "Short straddle", group: "Neutral", view: "Range-bound, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 0], ["SELL", "PE", 0]]) },
  { id: "long_strangle", label: "Long strangle", group: "Neutral", view: "Big move either way", build: (c) => mk(c, [["BUY", "CE", 2], ["BUY", "PE", -2]]) },
  { id: "short_strangle", label: "Short strangle", group: "Neutral", view: "Range-bound, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 2], ["SELL", "PE", -2]]) },
  { id: "bull_call_spread", label: "Bull call spread", group: "Spreads", view: "Moderately bullish", build: (c) => mk(c, [["BUY", "CE", 0], ["SELL", "CE", 2]]) },
  { id: "bear_put_spread", label: "Bear put spread", group: "Spreads", view: "Moderately bearish", build: (c) => mk(c, [["BUY", "PE", 0], ["SELL", "PE", -2]]) },
  { id: "bull_put_spread", label: "Bull put spread", group: "Spreads", view: "Moderately bullish, credit", build: (c) => mk(c, [["SELL", "PE", 0], ["BUY", "PE", -2]]) },
  { id: "bear_call_spread", label: "Bear call spread", group: "Spreads", view: "Moderately bearish, credit", build: (c) => mk(c, [["SELL", "CE", 0], ["BUY", "CE", 2]]) },
  { id: "iron_condor", label: "Iron condor", group: "Neutral", view: "Range-bound, limited risk", build: (c) => mk(c, [["SELL", "PE", -2], ["BUY", "PE", -4], ["SELL", "CE", 2], ["BUY", "CE", 4]]) },
  { id: "iron_butterfly", label: "Iron butterfly", group: "Neutral", view: "Pinned near ATM, limited risk", build: (c) => mk(c, [["SELL", "CE", 0], ["SELL", "PE", 0], ["BUY", "CE", 2], ["BUY", "PE", -2]]) },
  { id: "butterfly", label: "Butterfly spread (calls)", group: "Neutral", view: "Pinned near ATM, limited risk", build: (c) => mk(c, [["BUY", "CE", -2], ["SELL", "CE", 0, 2], ["BUY", "CE", 2]]) },
  { id: "ratio_spread", label: "Call ratio spread (1:2)", group: "Spreads", view: "Mild rise, risk above", build: (c) => mk(c, [["BUY", "CE", 0], ["SELL", "CE", 2, 2]]) },
];

let counter = 0;
export const newLegId = () => `leg-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const withIds = (drafts: Draft[]): Leg[] => drafts.map((d) => ({ ...d, id: newLegId() }));

export type Bias = "Bullish" | "Bearish" | "Neutral" | "Other";
/** Which tab of the ready-made gallery each template sits under. */
export const TEMPLATE_BIAS: Record<string, Bias> = {
  long_call: "Bullish", short_put: "Bullish", bull_call_spread: "Bullish", bull_put_spread: "Bullish",
  long_put: "Bearish", short_call: "Bearish", bear_put_spread: "Bearish", bear_call_spread: "Bearish",
  short_straddle: "Neutral", short_strangle: "Neutral", iron_condor: "Neutral", iron_butterfly: "Neutral", butterfly: "Neutral",
  long_straddle: "Other", long_strangle: "Other", ratio_spread: "Other",
};
