/**
 * Strategies whose legs expire on different dates (calendar, diagonal, weekly + monthly combinations).
 *
 * There is no single "expiry payoff" for such a strategy, so the payoff is always read AT A DATE, the end of one of the legs' expiries
 * (the session close of that day, ``expiryEnd``):
 *   - a leg that has expired by that date is worth its intrinsic value at the NIFTY level S of the chart. This is a simplification: the
 *     leg really settles at NIFTY's level on ITS OWN expiry day, not at the chart's level on the later date. It is exact for the
 *     earliest expiry and for strategies where every leg shares the date, and it treats the earlier legs as settled at S for later dates;
 *   - a leg that is still alive at that date is valued by the Black-76 model with its own expiry, its own forward (carry) and its market
 *     implied volatility, held constant. This part is a model estimate, not a market price.
 * The result is exact (to the cent) only when no leg is still alive at the chosen date; otherwise ``estimate`` is true and every number
 * derived from the curve is labelled a model estimate by the page.
 *
 * Pure functions, no UI, no network.
 */
import { expiryEnd, theoreticalPnl, type Valuation } from "./optionModel";
import { sign, type Leg } from "./strategy";

/** The distinct expiries of the legs, earliest first. */
export function legExpiries(legs: Pick<Leg, "expiry">[]): string[] {
  return [...new Set(legs.map((l) => l.expiry))].sort();
}

/** Strategy P&L at NIFTY level ``s`` on the close of ``payExpiry``; null when a live leg cannot be valued or a premium is missing. */
export function pnlAtExpiry(legs: Leg[], s: number, payExpiry: string, lotSize: number, v: Valuation): number | null {
  return theoreticalPnl(legs, s, expiryEnd(payExpiry), lotSize, v);
}

/** True when some leg is still alive at the close of ``payExpiry``: the curve then contains model values. */
export const isEstimateAt = (legs: Pick<Leg, "expiry" | "exitPrice">[], payExpiry: string): boolean =>
  legs.some((l) => l.exitPrice == null && expiryEnd(l.expiry) > expiryEnd(payExpiry));

export interface CurveAnalysis {
  defined: boolean;
  reason?: string;
  breakevens: number[];
  maxProfit: number | null;
  maxLoss: number | null;
  profitUnlimited: boolean;
  lossUnlimited: boolean;
  /** true when the numbers include model values (a leg still alive at the chosen date) */
  estimate: boolean;
  kinks: number[];
}

/**
 * Breakevens, maximum profit and maximum loss read from the payoff function on a fine grid (the payoff is not piecewise linear while a leg
 * is alive). Breakevens are refined by bisection. Profit or loss is unbounded when the slope above the highest strike is not zero: far
 * above every strike each call has delta 1 and each put 0, so the slope is the net signed call quantity.
 */
export function analyzeCurve(legs: Leg[], lotSize: number, spot: number, pnlAt: (s: number) => number | null, estimate: boolean): CurveAnalysis {
  const none = { breakevens: [] as number[], maxProfit: null, maxLoss: null, profitUnlimited: false, lossUnlimited: false, estimate, kinks: [] as number[] };
  if (legs.length === 0) return { defined: false, reason: "Add at least one leg.", ...none };
  if (legs.some((l) => l.premium == null && l.exitPrice == null)) return { defined: false, reason: "Enter the entry premium of every leg.", ...none };
  const open = legs.filter((l) => l.exitPrice == null);
  const strikes = [...new Set(open.map((l) => l.strike))].sort((a, b) => a - b);
  const lo = Math.max(1, Math.min(spot, ...strikes) * 0.5), hi = Math.max(spot, ...strikes) * 1.8;
  const n = 2400;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = lo + ((hi - lo) * i) / n;
    const p = pnlAt(s);
    if (p == null) return { defined: false, reason: "A leg could not be valued by the model (no volatility fits its price).", ...none };
    xs.push(s); ys.push(p);
  }
  // the strikes are kinks of the payoff while a leg is at expiry: evaluate them exactly, not only on the grid
  for (const k of strikes) {
    const p = pnlAt(k);
    if (p == null) return { defined: false, reason: "A leg could not be valued by the model (no volatility fits its price).", ...none };
    ys.push(p);
  }
  const upSlope = open.reduce((a, l) => a + (l.type === "CE" ? sign(l.action) * l.lots * lotSize : 0), 0);
  const be: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ys[i]!, b = ys[i + 1]!;
    if (a === 0) be.push(xs[i]!);
    else if (a * b < 0) {
      let x0 = xs[i]!, x1 = xs[i + 1]!;
      for (let k = 0; k < 50; k++) {
        const m = (x0 + x1) / 2, fm = pnlAt(m);
        if (fm == null) break;
        if (fm * (pnlAt(x0) as number) <= 0) x1 = m; else x0 = m;
      }
      be.push((x0 + x1) / 2);
    }
  }
  const uniq = [...new Set(be.map((x) => Math.round(x * 100) / 100))].sort((x, y) => x - y);
  const profitUnlimited = upSlope > 0, lossUnlimited = upSlope < 0;
  return {
    defined: true, estimate, breakevens: uniq, kinks: strikes,
    maxProfit: profitUnlimited ? null : Math.max(...ys), maxLoss: lossUnlimited ? null : Math.min(...ys),
    profitUnlimited, lossUnlimited,
  };
}

/** Payoff curve over [lo, hi] at ``step`` using ``pnlAt``; empty when any level cannot be valued. */
export function curveOf(pnlAt: (s: number) => number | null, lo: number, hi: number, step: number): { s: number; pnl: number }[] {
  const out: { s: number; pnl: number }[] = [];
  if (!(step > 0) || hi < lo) return out;
  for (let s = lo; s <= hi + 1e-9; s += step) {
    const p = pnlAt(s);
    if (p == null) return [];
    out.push({ s, pnl: p });
  }
  return out;
}
