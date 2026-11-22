/**
 * Advanced Greeks: the analyses a risk desk runs on a position, as pure functions of the legs, the index level, the time and the volatility of each leg.
 * Black-76 throughout, the same model as the rest of the app: the forward is F = S e^(c T) (c the carry read from the chain, T years to the expiry close),
 * the price is discounted at the rate r, and each option leg keeps its own implied volatility (sticky strike) unless an analysis says otherwise.
 *
 * Units, in the position (quantity is signed units: long positive, lots x lot size x multiplier):
 *   delta   index units (rupees per index point)        gamma   change of delta per index point
 *   vega    rupees per volatility point                 theta   rupees per calendar day (price one day later minus now)
 *   vanna   change of delta per volatility point        volga   change of vega per volatility point, rupees per point per point
 *   charm   change of delta per calendar day
 * Everything is a model estimate from stored prices; a missing input leaves the figure out (null), never zero.
 */
import { black76, cnd, expiryEnd, impliedVol } from "./optionModel";
import type { OptionType } from "./strategy";

const YEAR_MS = 365 * 86_400_000;
const DAY = 1 / 365;
const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export interface PLeg {
  id: string;
  type: OptionType | "FUT";
  strike: number;
  expiry: string;
  /** signed units: long positive */
  qty: number;
  /** implied volatility of the option leg (a fraction); null for a future or when it cannot be read */
  iv: number | null;
  /** continuous cost of carry of the leg's expiry */
  carry: number;
  /** entry price per unit (the premium; for a future its entry price), null when not entered */
  entry: number | null;
  enteredAt?: string | null;
}
export interface Mkt { rate: number }
const yearsTo = (expiry: string, atMs: number) => (expiryEnd(expiry) - atMs) / YEAR_MS;

// ---------------------------------------------------------------- one option, per unit
export interface OptRisk { price: number; delta: number; gamma: number; vega: number; vanna: number; volga: number; charmDay: number }
/**
 * Price and Greeks of one option per unit (closed forms). ``vega`` is per unit of volatility (1.0 = 100 points), ``vanna`` and ``volga`` likewise; ``charmDay`` is
 * the change of delta in one calendar day. With F = S e^(cT), k = e^((c-r)T), d1 = (ln(F/K) + sigma^2 T / 2) / (sigma sqrt(T)), d2 = d1 - sigma sqrt(T):
 *   delta = k N(d1) (call), k (N(d1) - 1) (put)      gamma = k phi(d1) / (S sigma sqrt(T))      vega = e^(-rT) F phi(d1) sqrt(T)
 *   vanna = -k phi(d1) d2 / sigma      volga = vega d1 d2 / sigma      d(delta)/dT = (c - r) delta + k phi(d1) (d1)'_T,  (d1)'_T = (c + sigma^2/2)/(sigma sqrt(T)) - d1/(2T)
 */
export function optRisk(type: OptionType, S: number, K: number, T: number, sigma: number, r: number, c: number): OptRisk | null {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const F = S * Math.exp(c * T), v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * v * v) / v, d2 = d1 - v;
  const k = Math.exp((c - r) * T), df = Math.exp(-r * T);
  const delta = type === "CE" ? k * cnd(d1) : k * (cnd(d1) - 1);
  const vega = df * F * pdf(d1) * Math.sqrt(T);
  const d1T = (c + 0.5 * sigma * sigma) / (sigma * Math.sqrt(T)) - d1 / (2 * T);
  const dDeltaDT = (c - r) * delta + k * pdf(d1) * d1T;
  return {
    price: black76(type, F, K, T, sigma, r), delta, gamma: (k * pdf(d1)) / (S * v), vega,
    vanna: (-k * pdf(d1) * d2) / sigma, volga: (vega * d1 * d2) / sigma, charmDay: -dDeltaDT * DAY,
  };
}

/** Value of one leg per unit at index level S and time ``atMs``: an option by Black-76 at its own volatility (intrinsic at expiry), a future at S e^(cT). Null when it cannot be valued. */
export function legValue(l: PLeg, S: number, atMs: number, m: Mkt, ivShift = 0): number | null {
  const T = yearsTo(l.expiry, atMs);
  if (l.type === "FUT") return T > 0 ? S * Math.exp(l.carry * T) : S;
  if (T <= 0) return Math.max(l.type === "CE" ? S - l.strike : l.strike - S, 0);
  if (l.iv == null) return null;
  const sig = Math.max(l.iv + ivShift, 1e-4);
  return black76(l.type, S * Math.exp(l.carry * T), l.strike, T, sig, m.rate);
}
/** Value of the whole position (rupees); null when any leg cannot be valued. */
export function positionValue(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, ivShift = 0): number | null {
  let t = 0;
  for (const l of legs) { const v = legValue(l, S, atMs, m, ivShift); if (v == null) return null; t += l.qty * v; }
  return t;
}

// ---------------------------------------------------------------- the position's Greeks
export interface PosGreeks { delta: number; gamma: number; vega: number; theta: number; vanna: number; volga: number; charm: number; unavailable: string[] }
export const nameOf = (l: Pick<PLeg, "type" | "strike">) => (l.type === "FUT" ? "NIFTY future" : `${l.strike} ${l.type}`);

/** Net Greeks of the position at index level S and time ``atMs``. A leg that cannot be valued is listed in ``unavailable`` and left out of the sums (never counted as zero). */
export function positionGreeks(legs: readonly PLeg[], S: number, atMs: number, m: Mkt): PosGreeks {
  const out: PosGreeks = { delta: 0, gamma: 0, vega: 0, theta: 0, vanna: 0, volga: 0, charm: 0, unavailable: [] };
  for (const l of legs) {
    const T = yearsTo(l.expiry, atMs);
    if (T <= 0) { out.unavailable.push(`${nameOf(l)} (expired)`); continue; }
    if (l.type === "FUT") {
      const e = Math.exp(l.carry * T), e1 = Math.exp(l.carry * Math.max(T - DAY, 0));
      out.delta += l.qty * e; out.theta += l.qty * S * (e1 - e); out.charm += l.qty * (e1 - e);
      continue;
    }
    if (l.iv == null) { out.unavailable.push(`${nameOf(l)} (no volatility)`); continue; }
    const g = optRisk(l.type, S, l.strike, T, l.iv, m.rate, l.carry);
    if (!g) { out.unavailable.push(`${nameOf(l)} (cannot be valued)`); continue; }
    const later = T > DAY ? black76(l.type, S * Math.exp(l.carry * (T - DAY)), l.strike, T - DAY, l.iv, m.rate) : Math.max(l.type === "CE" ? S - l.strike : l.strike - S, 0);
    out.delta += l.qty * g.delta; out.gamma += l.qty * g.gamma; out.vega += l.qty * g.vega * 0.01;
    out.theta += l.qty * (later - g.price); out.vanna += l.qty * g.vanna * 0.01; out.volga += l.qty * g.volga * 0.0001; out.charm += l.qty * g.charmDay;
  }
  return out;
}

// ---------------------------------------------------------------- 1. ladders
export interface LadderRow { pct: number; spot: number; pnl: number | null; greeks: PosGreeks }
/** The position's Greeks and its change in value at index levels ``pcts`` percent from today's (volatility and time held). */
export function greekLadder(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, pcts: readonly number[] = LADDER_PCTS): LadderRow[] {
  const base = positionValue(legs, S, atMs, m);
  return pcts.map((p) => {
    const s = S * (1 + p / 100);
    const v = positionValue(legs, s, atMs, m);
    return { pct: p, spot: s, pnl: v == null || base == null ? null : v - base, greeks: positionGreeks(legs, s, atMs, m) };
  });
}
export const LADDER_PCTS = [-5, -4, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 4, 5] as const;
/** The index level between the ladder rows where net delta changes sign (linear between the two rows), or null when it does not. */
export function deltaFlipSpot(rows: readonly LadderRow[]): number | null {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i]!;
    if (a.greeks.delta === 0) return a.spot;
    if ((a.greeks.delta < 0) !== (b.greeks.delta < 0)) return a.spot + ((0 - a.greeks.delta) * (b.spot - a.spot)) / (b.greeks.delta - a.greeks.delta);
  }
  return null;
}

// ---------------------------------------------------------------- 2. delta hedge sheet
export interface HedgeRow { pct: number; spot: number; delta: number; lots: number; adjust: number }
/**
 * Futures lots that make the position delta-neutral now (``-delta / lot size``; positive = buy, negative = sell), and at index levels around today's: the lots
 * needed there and the change from the hedge held now. Fractions are shown as they are; the rounded lot is what could be traded. No cost is estimated (the app holds
 * no order book to price the slippage).
 */
export function hedgeSheet(ladder: readonly LadderRow[], lotSize: number, pcts: readonly number[] = [-2, -1, 0, 1, 2]): { now: number; rows: HedgeRow[] } | null {
  const zero = ladder.find((r) => r.pct === 0);
  if (!zero || !(lotSize > 0)) return null;
  const now = -zero.greeks.delta / lotSize;
  return { now, rows: pcts.map((p) => ladder.find((r) => r.pct === p)).filter((r): r is LadderRow => !!r).map((r) => ({ pct: r.pct, spot: r.spot, delta: r.greeks.delta, lots: -r.greeks.delta / lotSize, adjust: -r.greeks.delta / lotSize - now })) };
}

// ---------------------------------------------------------------- 3. gamma-theta breakeven
export interface Breakeven { points: number; impliedDay: number | null; impliedRatio: number | null; realisedDay: number | null; realisedRatio: number | null; kind: "long gamma pays theta" | "short gamma earns theta" }
/**
 * The index move in one calendar day at which gamma and theta cancel: 1/2 |gamma| m^2 = |theta|, so m = sqrt(2 |theta| / |gamma|). It exists only when gamma and
 * theta have opposite signs (a long-gamma position pays theta; a short-gamma one earns it). Compared with the move the market implies per calendar day, S sigma / sqrt(365),
 * and with the realised one (annualised realised volatility on the same basis): a long-gamma position needs the index to move more than m to pay for itself.
 */
export function gammaThetaBreakeven(gamma: number, theta: number, S: number, impliedVol: number | null, realisedVol: number | null): Breakeven | null {
  if (!(gamma !== 0) || !(theta !== 0) || (gamma > 0) === (theta > 0)) return null;
  const m = Math.sqrt((2 * Math.abs(theta)) / Math.abs(gamma));
  const day = (v: number | null) => (v == null ? null : (S * v) / Math.sqrt(365));
  const iDay = day(impliedVol), rDay = day(realisedVol);
  return { points: m, impliedDay: iDay, impliedRatio: iDay == null ? null : m / iDay, realisedDay: rDay, realisedRatio: rDay == null ? null : m / rDay, kind: gamma > 0 ? "long gamma pays theta" : "short gamma earns theta" };
}

// ---------------------------------------------------------------- 6. vega by bucket and by smile factor
export interface VegaBuckets { byExpiry: { expiry: string; vega: number }[]; byZone: { zone: "puts below 5 % under the forward" | "within 5 % of the forward" | "calls above 5 % over the forward"; vega: number }[]; total: number }
/** Net vega (rupees per volatility point) by expiry and by where the strike sits against the forward. */
export function vegaBuckets(legs: readonly PLeg[], S: number, atMs: number, m: Mkt): VegaBuckets {
  const by = new Map<string, number>();
  const zones = { below: 0, near: 0, above: 0 };
  let total = 0;
  for (const l of legs) {
    if (l.type === "FUT" || l.iv == null) continue;
    const T = yearsTo(l.expiry, atMs);
    const g = optRisk(l.type, S, l.strike, T, l.iv, m.rate, l.carry);
    if (!g) continue;
    const v = l.qty * g.vega * 0.01, k = Math.log(l.strike / (S * Math.exp(l.carry * T)));
    by.set(l.expiry, (by.get(l.expiry) ?? 0) + v); total += v;
    if (k < -0.05) zones.below += v; else if (k > 0.05) zones.above += v; else zones.near += v;
  }
  return {
    byExpiry: [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([expiry, vega]) => ({ expiry, vega })),
    byZone: [{ zone: "puts below 5 % under the forward", vega: zones.below }, { zone: "within 5 % of the forward", vega: zones.near }, { zone: "calls above 5 % over the forward", vega: zones.above }], total,
  };
}
export interface SmileFactors { level: number; skew: number; curvature: number }
/**
 * Exposure to three shapes of change of the smile, in rupees for one volatility point of each shape (first order: the sum of leg vega times the shape at the leg's
 * log-moneyness k = ln(K / F)): level = every strike +1 point; skew = +1 point at k = -5 % falling to -1 at k = +5 % (a steeper downside); curvature = +1 point at
 * k = +-5 % and 0 at the money (fatter wings). These are defined shapes, not parameters of the fitted smile.
 */
export function smileFactors(legs: readonly PLeg[], S: number, atMs: number, m: Mkt): SmileFactors {
  const out = { level: 0, skew: 0, curvature: 0 };
  for (const l of legs) {
    if (l.type === "FUT" || l.iv == null) continue;
    const T = yearsTo(l.expiry, atMs);
    const g = optRisk(l.type, S, l.strike, T, l.iv, m.rate, l.carry);
    if (!g) continue;
    const v = l.qty * g.vega * 0.01, x = Math.log(l.strike / (S * Math.exp(l.carry * T))) / 0.05;
    out.level += v; out.skew += v * -x; out.curvature += v * x * x;
  }
  return out;
}

// ---------------------------------------------------------------- 8. P&L attribution since entry
export interface AttribRow { id: string; name: string; qty: number; delta: number; gamma: number; vega: number; theta: number; residual: number; actual: number }
export interface AttribInput { leg: PLeg; entrySpot: number | null; entryMs: number | null; nowSpot: number; nowMs: number; nowPrice: number | null }
export interface Attribution { rows: AttribRow[]; total: Omit<AttribRow, "id" | "name" | "qty">; skipped: { name: string; why: string }[] }
/**
 * Where the P&L since entry came from, by Greek, with what the Greeks do not explain shown as the residual (higher-order terms, and the gap between the entry
 * price and the model). Per option unit: delta0 x dS + 1/2 gamma0 x dS^2 + vega0 x (iv1 - iv0) + theta0 x days, the Greeks taken at the entry (index level, time and the
 * volatility the entry price implies), iv1 the volatility the price now implies. A future is delta (its move) and the carry running off. A leg without an entry price or
 * entry level is listed in ``skipped``, not guessed.
 */
export function attribution(inputs: readonly AttribInput[], m: Mkt): Attribution {
  const rows: AttribRow[] = [], skipped: { name: string; why: string }[] = [];
  for (const { leg: l, entrySpot, entryMs, nowSpot, nowMs, nowPrice } of inputs) {
    const name = nameOf(l);
    if (l.entry == null || entrySpot == null || entryMs == null) { skipped.push({ name, why: "no entry price or no stored index level at the entry time" }); continue; }
    if (nowPrice == null) { skipped.push({ name, why: "no price now" }); continue; }
    const days = (nowMs - entryMs) / 86_400_000, dS = nowSpot - entrySpot;
    if (l.type === "FUT") {
      const T0 = yearsTo(l.expiry, entryMs), d0 = Math.exp(l.carry * T0);
      const delta = l.qty * d0 * dS, actual = l.qty * (nowPrice - l.entry);
      rows.push({ id: l.id, name, qty: l.qty, delta, gamma: 0, vega: 0, theta: l.qty * (actual / l.qty - d0 * dS), residual: 0, actual });
      continue;
    }
    const T0 = yearsTo(l.expiry, entryMs), T1 = yearsTo(l.expiry, nowMs);
    const iv0 = impliedVol(l.type, l.entry, entrySpot * Math.exp(l.carry * T0), l.strike, T0, m.rate), iv1 = impliedVol(l.type, nowPrice, nowSpot * Math.exp(l.carry * T1), l.strike, T1, m.rate);
    const g0 = iv0 == null ? null : optRisk(l.type, entrySpot, l.strike, T0, iv0, m.rate, l.carry);
    if (iv0 == null || iv1 == null || !g0) { skipped.push({ name, why: "the entry or the current price implies no volatility" }); continue; }
    const later = T0 > DAY ? black76(l.type, entrySpot * Math.exp(l.carry * (T0 - DAY)), l.strike, T0 - DAY, iv0, m.rate) : g0.price;
    const theta0 = later - g0.price;
    const parts = { delta: g0.delta * dS, gamma: 0.5 * g0.gamma * dS * dS, vega: g0.vega * (iv1 - iv0), theta: theta0 * days };
    const actual = nowPrice - l.entry;
    rows.push({ id: l.id, name, qty: l.qty, delta: l.qty * parts.delta, gamma: l.qty * parts.gamma, vega: l.qty * parts.vega, theta: l.qty * parts.theta, actual: l.qty * actual, residual: l.qty * (actual - parts.delta - parts.gamma - parts.vega - parts.theta) });
  }
  const sum = (k: "delta" | "gamma" | "vega" | "theta" | "residual" | "actual") => rows.reduce((a, r) => a + r[k], 0);
  return { rows, total: { delta: sum("delta"), gamma: sum("gamma"), vega: sum("vega"), theta: sum("theta"), residual: sum("residual"), actual: sum("actual") }, skipped };
}

// ---------------------------------------------------------------- realised volatility
/** Annualised close-to-close realised volatility from daily closes (sample standard deviation of log returns x sqrt(252)); null with fewer than 3 closes. */
export function closeToCloseVol(closes: readonly number[]): number | null {
  const c = closes.filter((x) => x > 0);
  if (c.length < 3) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]!));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}
/** Realised volatility of one session from its stored samples: the sum of squared log returns between consecutive samples is the session's realised variance; annualised x 252. */
export function sessionRealisedVol(spots: readonly (number | null)[]): number | null {
  const s = spots.filter((x): x is number => x != null && x > 0);
  if (s.length < 20) return null;
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.log(s[i]! / s[i - 1]!) ** 2;
  return Math.sqrt(sum * 252);
}

// ---------------------------------------------------------------- 4. VaR and expected shortfall
/** A small seeded generator (mulberry32): the same seed gives the same paths, so a risk figure can be reproduced. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function normalDraws(n: number, seed: number): number[] {
  const u = rng(seed), out: number[] = [];
  while (out.length < n) {
    const a = Math.max(u(), 1e-12), b = u(), r = Math.sqrt(-2 * Math.log(a));
    out.push(r * Math.cos(2 * Math.PI * b)); if (out.length < n) out.push(r * Math.sin(2 * Math.PI * b));
  }
  return out;
}
export interface VarResult { var95: number; var99: number; es95: number; es99: number; mean: number; worst: number; paths: number; deltaNormal95: number | null; deltaNormal99: number | null; sigma: number }
/**
 * One-day value at risk and expected shortfall by full revaluation: ``paths`` index moves from a lognormal with annual volatility ``sigma`` over one trading day
 * (variance sigma^2 / 252, no drift beyond the Ito term), every leg re-priced at the new level one calendar day later, each option at its own volatility (sticky strike).
 * VaR(q) is the loss not exceeded with probability q (a positive number of rupees); ES(q) the average loss beyond it. ``deltaNormal`` is the delta-only closed form
 * z x |delta| x S x sigma / sqrt(252), a cross-check. A model estimate on a normal distribution: it understates gaps. Null when a leg cannot be valued.
 */
export function valueAtRisk(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, sigma: number, paths = 5000, seed = 20261123): VarResult | null {
  const base = positionValue(legs, S, atMs, m);
  if (base == null || !(sigma > 0)) return null;
  const h = 1 / 252, later = atMs + 86_400_000, z = normalDraws(paths, seed), pnl: number[] = [];
  for (const e of z) {
    const s = S * Math.exp(-0.5 * sigma * sigma * h + sigma * Math.sqrt(h) * e);
    const v = positionValue(legs, s, later, m);
    if (v == null) return null;
    pnl.push(v - base);
  }
  pnl.sort((a, b) => a - b);
  const q = (p: number) => pnl[Math.min(pnl.length - 1, Math.max(0, Math.floor(p * pnl.length)))]!;
  const es = (p: number) => { const k = Math.max(1, Math.floor(p * pnl.length)); return -pnl.slice(0, k).reduce((a, b) => a + b, 0) / k; };
  const d = positionGreeks(legs, S, atMs, m).delta;
  return { var95: -q(0.05), var99: -q(0.01), es95: es(0.05), es99: es(0.01), mean: pnl.reduce((a, b) => a + b, 0) / pnl.length, worst: -pnl[0]!, paths, sigma,
    deltaNormal95: 1.6448536 * Math.abs(d) * S * sigma * Math.sqrt(h), deltaNormal99: 2.3263479 * Math.abs(d) * S * sigma * Math.sqrt(h) };
}

// ---------------------------------------------------------------- 5. stress
export interface StressCell { k: number; volShift: number; spot: number; pnl: number | null }
/** P&L now (time held) at index moves of ``ks`` one-day standard deviations (sigma / sqrt(252) each) with a parallel volatility shift in points; sticky strike. */
export function stressGrid(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, sigma: number, ks: readonly number[] = [-3, -2, -1, 0, 1, 2, 3], volShifts: readonly number[] = [-5, 0, 5]): StressCell[] {
  const base = positionValue(legs, S, atMs, m);
  const sd = sigma / Math.sqrt(252);
  return volShifts.flatMap((vs) => ks.map((k) => {
    const s = S * Math.exp(k * sd), v = positionValue(legs, s, atMs, m, vs / 100);
    return { k, volShift: vs, spot: s, pnl: v == null || base == null ? null : v - base };
  }));
}
export interface Replay { label: string; pct: number; pnl: number | null }
/** The position under index moves that actually happened (percent), volatility and time held. */
export function replayMoves(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, moves: readonly { label: string; pct: number }[]): Replay[] {
  const base = positionValue(legs, S, atMs, m);
  return moves.map((x) => { const v = positionValue(legs, S * (1 + x.pct / 100), atMs, m); return { ...x, pnl: v == null || base == null ? null : v - base }; });
}
/** The largest daily moves in a series of closes: the ``n`` biggest falls and the ``n`` biggest rises, as percentages with their dates. */
export function largestMoves(days: readonly { day: string; close: number }[], n = 3): { label: string; pct: number }[] {
  const mv = days.slice(1).map((d, i) => ({ label: d.day, pct: (d.close / days[i]!.close - 1) * 100 }));
  const sorted = [...mv].sort((a, b) => a.pct - b.pct);
  return [...sorted.slice(0, n), ...sorted.slice(-n).reverse()];
}
/**
 * The smallest index move, down and up, at which the position loses ``loss`` rupees (volatility and time held), searched out to +-``range`` in 0.25 % steps and refined
 * by bisection; null for a side where the loss is not reached within the range.
 */
export function reverseStress(legs: readonly PLeg[], S: number, atMs: number, m: Mkt, loss: number, range = 0.15): { down: number | null; up: number | null } {
  const base = positionValue(legs, S, atMs, m);
  if (base == null || !(loss > 0)) return { down: null, up: null };
  const f = (x: number) => { const v = positionValue(legs, S * (1 + x), atMs, m); return v == null ? null : v - base + loss; }; // negative once the loss is reached
  const side = (dir: 1 | -1): number | null => {
    let prev = 0;
    for (let i = 1; i <= Math.round(range / 0.0025); i++) {
      const x = dir * i * 0.0025, v = f(x);
      if (v == null) return null;
      if (v <= 0) {
        let lo = prev, hi = x;
        for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, vm = f(mid); if (vm == null) return null; if (vm <= 0) hi = mid; else lo = mid; }
        return ((lo + hi) / 2) * 100;
      }
      prev = x;
    }
    return null;
  };
  return { down: side(-1), up: side(1) };
}

// ---------------------------------------------------------------- 9. smile analytics
export interface SmileRow { strike: number; ceIv: number | null; ceDelta: number | null; peIv: number | null; peDelta: number | null }
export interface SmileMetrics { atm: number | null; call25: number | null; put25: number | null; riskReversal: number | null; butterfly: number | null }
const ivAtDelta = (pts: { d: number; iv: number }[], target: number): number | null => {
  const p = [...pts].sort((a, b) => a.d - b.d);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!, b = p[i]!;
    if (target >= a.d && target <= b.d) return b.d === a.d ? a.iv : a.iv + ((b.iv - a.iv) * (target - a.d)) / (b.d - a.d);
  }
  return null;
};
/**
 * The 25-delta quotes of one expiry from its strikes: the volatility of the call at +0.25 delta and of the put at -0.25 (each interpolated linearly in delta between the
 * two strikes that bracket it), the risk reversal (call minus put: negative when puts are richer) and the butterfly (the average of the two minus the at-the-money level).
 */
export function smileMetrics(rows: readonly SmileRow[], atm: number | null): SmileMetrics {
  const calls = rows.filter((r) => r.ceIv != null && r.ceDelta != null).map((r) => ({ d: r.ceDelta!, iv: r.ceIv! }));
  const puts = rows.filter((r) => r.peIv != null && r.peDelta != null).map((r) => ({ d: r.peDelta!, iv: r.peIv! }));
  const c = ivAtDelta(calls, 0.25), p = ivAtDelta(puts, -0.25);
  return { atm, call25: c, put25: p, riskReversal: c == null || p == null ? null : c - p, butterfly: c == null || p == null || atm == null ? null : (c + p) / 2 - atm };
}
/** The forward volatility between two expiries: sqrt((sigma2^2 T2 - sigma1^2 T1) / (T2 - T1)); null when the total variance would fall (calendar arbitrage) or the times do not increase. */
export function forwardVol(s1: number, t1: number, s2: number, t2: number): number | null {
  if (!(t2 > t1) || !(t1 > 0)) return null;
  const v = (s2 * s2 * t2 - s1 * s1 * t1) / (t2 - t1);
  return v > 0 ? Math.sqrt(v) : null;
}

// ---------------------------------------------------------------- 11. vanna and charm exposure of the market
export interface ExposureRow { strike: number; vanna: number | null; charm: number | null }
/**
 * Vanna and charm exposure by strike, in the same convention as the gamma exposure: calls positive and puts negative (the market long calls and short puts), which is an
 * assumption, not an observed position. Vanna exposure = vanna per volatility point x open interest (units; change of the market's delta per volatility point), charm
 * exposure = charm per day x open interest. A contract without a volatility or open interest is left out.
 */
export function marketExposure(rows: readonly { strike: number; ceIv: number | null; peIv: number | null; ceOi: number | null; peOi: number | null }[], S: number, expiry: string, atMs: number, m: Mkt, carry: number): ExposureRow[] {
  const T = yearsTo(expiry, atMs);
  return rows.map((r) => {
    const one = (type: OptionType, iv: number | null, oi: number | null, sg: 1 | -1) => {
      if (iv == null || oi == null) return null;
      const g = optRisk(type, S, r.strike, T, iv, m.rate, carry);
      return g ? { vanna: sg * g.vanna * 0.01 * oi, charm: sg * g.charmDay * oi } : null;
    };
    const c = one("CE", r.ceIv, r.ceOi, 1), p = one("PE", r.peIv, r.peOi, -1);
    return { strike: r.strike, vanna: c && p ? c.vanna + p.vanna : null, charm: c && p ? c.charm + p.charm : null };
  });
}
