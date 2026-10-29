/**
 * Option model used for the estimates next to the exact expiry payoff: Black-76 prices, implied volatility, per-strike delta,
 * a dashed "estimated on a chosen date" curve, net Greeks and a probability-of-profit estimate. These are model values built
 * from stored last traded prices, never market prices, and the page labels them so.
 */
import { SESSION_CLOSE_MIN } from "./session";
import { intrinsic, sign, type Leg, type OptionType, expiryPnl } from "./strategy";

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


/** Black-76 delta of one contract with respect to the forward-adjusted spot (call N(d1), put N(d1)-1), or null when no volatility fits the price. */
export function contractDelta(type: OptionType, price: number | null, spot: number, strike: number, expiry: string, nowMs: number, rate: number): { delta: number; iv: number } | null {
  if (price == null) return null;
  const t = (expiryEnd(expiry) - nowMs) / YEAR_MS;
  if (t <= 0) return null;
  const iv = impliedVol(type, price, spot * Math.exp(rate * t), strike, t, rate);
  if (iv == null) return null;
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * t) / (iv * Math.sqrt(t));
  return { delta: type === "CE" ? cnd(d1) : cnd(d1) - 1, iv };
}

/**
 * Probability that the strategy ends in profit at expiry if NIFTY follows a lognormal distribution with the given
 * volatility (zero drift beyond the interest rate). A model estimate; it is not a forecast.
 */
export function probabilityOfProfit(legs: Leg[], lotSize: number, spot: number, sigma: number, expiry: string, nowMs: number, rate: number): number | null {
  const t = (expiryEnd(expiry) - nowMs) / YEAR_MS;
  if (!(t > 0) || !(sigma > 0) || !(spot > 0)) return null;
  const mu = Math.log(spot * Math.exp(rate * t)) - 0.5 * sigma * sigma * t, sd = sigma * Math.sqrt(t);
  const lo = spot * Math.exp(-6 * sd), hi = spot * Math.exp(6 * sd), n = 4000;
  const dx = (hi - lo) / n;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const s = lo + (i + 0.5) * dx;
    const pnl = expiryPnl(legs, s, lotSize);
    if (pnl == null) return null;
    if (pnl > 0) {
      const z = (Math.log(s) - mu) / sd;
      p += (pdf(z) / (s * sd)) * dx;
    }
  }
  return Math.min(1, p);
}

/** Spot levels one and two standard deviations away at expiry for the given volatility. */
export function sdBands(spot: number, sigma: number, expiry: string, nowMs: number): { m2: number; m1: number; p1: number; p2: number } | null {
  const t = (expiryEnd(expiry) - nowMs) / YEAR_MS;
  if (!(t > 0) || !(sigma > 0)) return null;
  const sd = spot * sigma * Math.sqrt(t);
  return { m2: spot - 2 * sd, m1: spot - sd, p1: spot + sd, p2: spot + 2 * sd };
}
