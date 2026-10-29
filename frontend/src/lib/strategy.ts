/**
 * Options strategy engine: expiry payoff, breakevens, risk limits, theoretical (Black-76) valuation before expiry,
 * net Greeks, estimated costs, templates and validation. Pure functions, no UI and no network.
 *
 * Three different things are kept apart on purpose:
 *   1. expiry payoff           = exact arithmetic on the legs at expiry (intrinsic value minus premium)
 *   2. theoretical valuation   = a Black-76 model estimate for a chosen date, spot and volatility (an estimate, not a market price)
 *   3. market P&L              = current quotes minus entry premium (only where a quote exists)
 */
import { SESSION_CLOSE_MIN } from "./session";

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
  iv?: number | null; // manual implied volatility override, 0.15 = 15 %
}

export const sign = (a: Action) => (a === "BUY" ? 1 : -1);
const YEAR_MS = 365 * 86_400_000;

// ---------------------------------------------------------------- normal distribution and Black-76
/** Standard normal CDF (Hart's double-precision algorithm, as popularised by West 2005). */
export function cnd(x: number): number {
  const xa = Math.abs(x);
  let c: number;
  if (xa > 37) c = 0;
  else {
    const e = Math.exp((-xa * xa) / 2);
    if (xa < 7.07106781186547) {
      let b = 0.0352624965998911 * xa + 0.700383064443688;
      b = b * xa + 6.37396220353165; b = b * xa + 33.912866078383; b = b * xa + 112.079291497871;
      b = b * xa + 221.213596169931; b = b * xa + 220.206867912376;
      c = e * b;
      b = 0.0883883476483184 * xa + 1.75566716318264;
      b = b * xa + 16.064177579207; b = b * xa + 86.7807322029461; b = b * xa + 296.564248779674;
      b = b * xa + 637.333633378831; b = b * xa + 793.826512519948; b = b * xa + 440.413735824752;
      c /= b;
    } else {
      let b = xa + 0.65;
      b = xa + 4 / b; b = xa + 3 / b; b = xa + 2 / b; b = xa + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}
const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Black-76 price of a European option on forward f (same model as backend/app/intraday/volatility.py). */
export function black76(type: OptionType, f: number, k: number, t: number, sigma: number, r: number): number {
  const df = Math.exp(-r * t);
  if (sigma <= 0 || t <= 0) return df * Math.max(type === "CE" ? f - k : k - f, 0);
  const v = sigma * Math.sqrt(t);
  const d1 = (Math.log(f / k) + 0.5 * v * v) / v;
  const d2 = d1 - v;
  return type === "CE" ? df * (f * cnd(d1) - k * cnd(d2)) : df * (k * cnd(-d2) - f * cnd(-d1));
}

/** Implied volatility from a price (bisection), or null when no volatility reproduces it. */
export function impliedVol(type: OptionType, price: number, f: number, k: number, t: number, r: number): number | null {
  if (![price, f, k, t].every(Number.isFinite) || price <= 0 || f <= 0 || k <= 0 || t <= 0) return null;
  const df = Math.exp(-r * t);
  const intrinsic = df * Math.max(type === "CE" ? f - k : k - f, 0);
  const upper = df * (type === "CE" ? f : k);
  if (price <= intrinsic + 1e-9 || price >= upper) return null;
  let lo = 1e-4, hi = 3;
  if (black76(type, f, k, t, hi, r) < price) return null;
  for (let i = 0; i < 100 && hi - lo > 1e-8; i++) {
    const mid = (lo + hi) / 2;
    if (black76(type, f, k, t, mid, r) < price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Instant a contract stops trading: the session close on its expiry date, IST. */
export function expiryEnd(expiry: string): number {
  const [y, m, d] = expiry.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 0, SESSION_CLOSE_MIN, 0) - 330 * 60_000;
}

// ---------------------------------------------------------------- expiry payoff
const intrinsic = (l: Pick<Leg, "type" | "strike">, s: number) => Math.max(l.type === "CE" ? s - l.strike : l.strike - s, 0);

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

// ---------------------------------------------------------------- theoretical valuation (an estimate)
export interface Valuation {
  spotNow: number;
  nowMs: number;
  rate: number;
  /** added to every leg's volatility, in volatility points (0.02 = +2 vol points) */
  ivShift: number;
}

/** Volatility used for a leg: the manual override, else the one implied by its entry premium at the current spot. */
export function legIv(l: Leg, v: Valuation): { iv: number | null; source: "manual" | "implied from entry premium" | "unavailable" } {
  if (l.iv != null && l.iv > 0) return { iv: l.iv, source: "manual" };
  if (l.premium == null) return { iv: null, source: "unavailable" };
  const t = (expiryEnd(l.expiry) - v.nowMs) / YEAR_MS;
  const iv = impliedVol(l.type, l.premium, v.spotNow * Math.exp(v.rate * t), l.strike, t, v.rate);
  return iv == null ? { iv: null, source: "unavailable" } : { iv, source: "implied from entry premium" };
}

/** Model value per unit of one leg at spot s on date `atMs`. Null when its volatility is unknown. */
export function legTheoreticalValue(l: Leg, s: number, atMs: number, v: Valuation): number | null {
  const t = (expiryEnd(l.expiry) - atMs) / YEAR_MS;
  if (t <= 0) return intrinsic(l, s);
  const { iv } = legIv(l, v);
  if (iv == null) return null;
  return black76(l.type, s * Math.exp(v.rate * t), l.strike, t, Math.max(iv + v.ivShift, 1e-4), v.rate);
}

/** Estimated strategy P&L at spot s on a date before expiry (before costs). Null if any leg cannot be valued. */
export function theoreticalPnl(legs: Leg[], s: number, atMs: number, lotSize: number, v: Valuation): number | null {
  let total = 0;
  for (const l of legs) {
    if (l.premium == null) return null;
    const val = legTheoreticalValue(l, s, atMs, v);
    if (val == null) return null;
    total += sign(l.action) * (val - l.premium) * l.lots * lotSize;
  }
  return total;
}

export interface NetGreeks { delta: number; gamma: number; thetaDay: number; vegaPt: number; unavailable: string[] }

/** Position Greeks at the current spot and time (delta and gamma analytic; theta and vega by one-day / one-point bumps). */
export function netGreeks(legs: Leg[], lotSize: number, v: Valuation): NetGreeks {
  const out: NetGreeks = { delta: 0, gamma: 0, thetaDay: 0, vegaPt: 0, unavailable: [] };
  for (const l of legs) {
    const t = (expiryEnd(l.expiry) - v.nowMs) / YEAR_MS;
    const { iv } = legIv(l, v);
    if (t <= 0 || iv == null) { out.unavailable.push(`${l.type} ${l.strike}`); continue; }
    const sigma = Math.max(iv + v.ivShift, 1e-4);
    const q = sign(l.action) * l.lots * lotSize;
    const vt = sigma * Math.sqrt(t);
    const d1 = (Math.log(v.spotNow / l.strike) + (v.rate + 0.5 * sigma * sigma) * t) / vt; // Black-Scholes d1 with S fixed
    out.delta += q * (l.type === "CE" ? cnd(d1) : cnd(d1) - 1);
    out.gamma += (q * pdf(d1)) / (v.spotNow * vt);
    const val = (tt: number, sg: number) => black76(l.type, v.spotNow * Math.exp(v.rate * tt), l.strike, tt, sg, v.rate);
    out.thetaDay += q * ((t > 1 / 365 ? val(t - 1 / 365, sigma) : intrinsic(l, v.spotNow)) - val(t, sigma));
    out.vegaPt += q * (val(t, sigma + 0.01) - val(t, sigma));
  }
  return out;
}

// ---------------------------------------------------------------- costs (assumptions, editable)
export interface CostModel {
  brokeragePerOrder: number; // INR per executed leg
  sttSellPct: number; // % of premium on the sell side
  exchangePct: number; // % of premium turnover
  sebiPct: number; // % of turnover
  stampBuyPct: number; // % of premium on the buy side
  gstPct: number; // % on brokerage + exchange + SEBI
  slippagePerUnit: number; // INR per unit, paid against you on every execution
}
/** Starting values only. Statutory rates change: check them against your broker's contract note and edit. */
export const DEFAULT_COSTS: CostModel = { brokeragePerOrder: 20, sttSellPct: 0.1, exchangePct: 0.03503, sebiPct: 0.0001, stampBuyPct: 0.003, gstPct: 18, slippagePerUnit: 0 };

/** Cost of executing one leg once at `price` (entry or exit). Slippage is included. */
export function executionCost(action: Action, price: number, units: number, c: CostModel): number {
  const turnover = price * units;
  const exch = (turnover * c.exchangePct) / 100, sebi = (turnover * c.sebiPct) / 100;
  const stt = action === "SELL" ? (turnover * c.sttSellPct) / 100 : 0;
  const stamp = action === "BUY" ? (turnover * c.stampBuyPct) / 100 : 0;
  const gst = ((c.brokeragePerOrder + exch + sebi) * c.gstPct) / 100;
  return c.brokeragePerOrder + exch + sebi + stt + stamp + gst + c.slippagePerUnit * units;
}

/** Entry costs plus the costs of closing every leg at the given exit prices (per leg id). */
export function roundTripCost(legs: Leg[], exitPrice: (l: Leg) => number, lotSize: number, c: CostModel): number {
  let total = 0;
  for (const l of legs) {
    if (l.premium == null) continue;
    const units = l.lots * lotSize;
    total += executionCost(l.action, l.premium, units, c);
    total += executionCost(l.action === "BUY" ? "SELL" : "BUY", exitPrice(l), units, c);
  }
  return total;
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
  nextExpiry: string | null;
  premium: (expiry: string, strike: number, type: OptionType) => number | null;
}
type Draft = Omit<Leg, "id">;
export interface Template { id: string; label: string; group: "Directional" | "Neutral" | "Spreads" | "Multi-expiry"; view: string; build: (c: TemplateContext) => Draft[] | { error: string } }

function strikeAt(c: TemplateContext, steps: number): number | null {
  const ks = [...c.strikes].sort((a, b) => a - b);
  const i = ks.indexOf(c.atm);
  const j = i + steps;
  return i < 0 || j < 0 || j >= ks.length ? null : ks[j]!;
}

function mk(c: TemplateContext, rows: [Action, OptionType, number, number?, "next"?][]): Draft[] | { error: string } {
  const out: Draft[] = [];
  for (const [action, type, steps, lots = 1, which] of rows) {
    const strike = strikeAt(c, steps);
    if (strike == null) return { error: `The chain has no listed strike ${Math.abs(steps)} steps ${steps < 0 ? "below" : "above"} the ATM strike.` };
    const expiry = which === "next" ? c.nextExpiry : c.expiry;
    if (!expiry) return { error: "This template needs a second expiry and none is listed." };
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
  { id: "calendar", label: "Calendar spread (calls)", group: "Multi-expiry", view: "Flat near term, long volatility", build: (c) => mk(c, [["SELL", "CE", 0], ["BUY", "CE", 0, 1, "next"]]) },
  { id: "diagonal", label: "Diagonal spread (calls)", group: "Multi-expiry", view: "Mildly bullish, theta positive", build: (c) => mk(c, [["SELL", "CE", 1], ["BUY", "CE", 0, 1, "next"]]) },
];

let counter = 0;
export const newLegId = () => `leg-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const withIds = (drafts: Draft[]): Leg[] => drafts.map((d) => ({ ...d, id: newLegId() }));
