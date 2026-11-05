/**
 * Gamma exposure (GEX) from the option chain and from the stored one-minute samples.
 *
 * Per strike: GEX = gamma x open interest (units) x spot^2 x 1 %, in rupees crore of underlying whose delta changes for a 1 %
 * move, with gamma from Black-76 and each contract's own implied volatility. Calls are positive and puts negative: that is a
 * CONVENTION (the market long calls and short puts), not an observed position; if real positioning were the reverse the profile
 * would invert. Net GEX of a strike = call + put. A contract without a usable price or OI gives no exposure and is left out of
 * the sums, never counted as zero.
 *
 *  - Call wall: the strike at or above spot with the largest call GEX. Put wall: the strike at or below spot with the largest put GEX.
 *  - Peak gamma: the strike with the largest absolute GEX (call + |put|).
 *  - Gamma flip: the spot level at which aggregate net GEX changes sign, found by re-pricing every contract's gamma at trial
 *    spot levels (its own implied volatility held fixed) and taking the crossing nearest to spot.
 */
import { RISK_FREE_RATE } from "./assumptions";
import { isSessionMs } from "./analytics";
import { contractGreeks } from "./optionModel";
import { chainGreeks } from "./optionTools";
import type { OptionChainRow, OptionQuote, StrikeSeries } from "./types";

export const CRORE = 1e7;

export interface GexRow {
  strike: number;
  ceOi: number | null; peOi: number | null;
  ceIv: number | null; peIv: number | null;
  ceGamma: number | null; peGamma: number | null;
  /** rupees crore per 1 % move: calls positive, puts negative */
  ce: number | null; pe: number | null;
  net: number | null; abs: number | null;
}
export interface GexProfile { rows: GexRow[]; spot: number; expiry: string; at: number; rate: number; carry: number; forward: number | null; skipped: number }

const exposure = (gamma: number | null, oi: number | null | undefined, spot: number) =>
  gamma == null || oi == null ? null : (gamma * oi * spot * spot * 0.01) / CRORE;

/** The GEX of every listed strike of one chain. */
export function gexProfile(rows: OptionChainRow[], spot: number, expiry: string, atMs: number, rate = RISK_FREE_RATE): GexProfile {
  const g = chainGreeks(rows, spot, expiry, atMs, rate);
  const byStrike = new Map(g.strikes.map((x) => [x.strike, x]));
  const out: GexRow[] = rows.map((r) => {
    const x = byStrike.get(r.strike);
    const ceG = x?.ce?.gamma ?? null, peG = x?.pe?.gamma ?? null;
    const ce = exposure(ceG, r.call?.oi, spot);
    const peAbs = exposure(peG, r.put?.oi, spot);
    const pe = peAbs == null ? null : -peAbs;
    return {
      strike: r.strike, ceOi: r.call?.oi ?? null, peOi: r.put?.oi ?? null, ceIv: x?.ce?.iv ?? null, peIv: x?.pe?.iv ?? null,
      ceGamma: ceG, peGamma: peG, ce, pe, net: ce != null && pe != null ? ce + pe : null, abs: ce != null && pe != null ? ce + peAbs! : null,
    };
  }).sort((a, b) => a.strike - b.strike);
  return { rows: out, spot, expiry, at: atMs, rate, carry: g.carry, forward: g.forward, skipped: g.skipped };
}

const argmax = <T,>(xs: T[], f: (x: T) => number | null): T | null => {
  let best: T | null = null; let bv = -Infinity;
  for (const x of xs) { const v = f(x); if (v != null && v > bv) { bv = v; best = x; } }
  return best;
};

/** Aggregate net GEX at a trial spot: every contract's gamma re-priced there with its own implied volatility. */
export function netGexAt(p: GexProfile, trialSpot: number): number | null {
  let sum = 0; let n = 0;
  for (const r of p.rows) {
    const c = r.ceIv != null && r.ceOi != null ? contractGreeks("CE", null, trialSpot, r.strike, p.expiry, p.at, p.rate, p.carry, r.ceIv)?.gamma ?? null : null;
    const q = r.peIv != null && r.peOi != null ? contractGreeks("PE", null, trialSpot, r.strike, p.expiry, p.at, p.rate, p.carry, r.peIv)?.gamma ?? null : null;
    if (c != null) { sum += (c * r.ceOi! * trialSpot * trialSpot * 0.01) / CRORE; n++; }
    if (q != null) { sum -= (q * r.peOi! * trialSpot * trialSpot * 0.01) / CRORE; n++; }
  }
  return n === 0 ? null : sum;
}

/** The spot level, within +-`span` of spot, where aggregate net GEX crosses zero (nearest to spot; each bracket refined by bisection). */
export function gammaFlip(p: GexProfile, span = 0.08, steps = 64): number | null {
  const pts: { s: number; v: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = p.spot * (1 - span + (2 * span * i) / steps);
    const v = netGexAt(p, s);
    if (v != null) pts.push({ s, v });
  }
  let best: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (a.v === 0 || (a.v < 0) !== (b.v < 0)) {
      let lo = a.s, hi = b.s, vlo = a.v;
      for (let k = 0; k < 30; k++) { // refine the bracket by bisection: the profile is curved, a straight line between trial levels is not exact
        const mid = (lo + hi) / 2;
        const vm = netGexAt(p, mid);
        if (vm == null) break;
        if ((vm < 0) === (vlo < 0)) { lo = mid; vlo = vm; } else hi = mid;
      }
      const x = (lo + hi) / 2;
      if (best == null || Math.abs(x - p.spot) < Math.abs(best - p.spot)) best = x;
    }
  }
  return best;
}

export interface GexLevels {
  spot: number; netTotal: number | null; absTotal: number | null; strikesUsed: number;
  peak: number | null; callWall: number | null; putWall: number | null; flip: number | null;
  atmStrike: number | null; atmNet: number | null; nearNet: number | null;
}
/** Walls, peak, flip and the totals of a profile. `near` = strikes either side of the at-the-money strike for the near-ATM total. */
export function gexLevels(p: GexProfile, near = 5, withFlip = true): GexLevels {
  const used = p.rows.filter((r) => r.net != null);
  const atm = argmax(p.rows, (r) => -Math.abs(r.strike - p.spot));
  const i = atm ? p.rows.indexOf(atm) : -1;
  const nearRows = i < 0 ? [] : p.rows.slice(Math.max(0, i - near), i + near + 1).filter((r) => r.net != null);
  return {
    spot: p.spot,
    netTotal: used.length ? used.reduce((a, r) => a + r.net!, 0) : null,
    absTotal: used.length ? used.reduce((a, r) => a + r.abs!, 0) : null,
    strikesUsed: used.length,
    peak: argmax(p.rows, (r) => r.abs)?.strike ?? null,
    callWall: argmax(p.rows.filter((r) => r.strike >= p.spot), (r) => r.ce)?.strike ?? null,
    putWall: argmax(p.rows.filter((r) => r.strike <= p.spot), (r) => (r.pe == null ? null : -r.pe))?.strike ?? null,
    flip: withFlip ? gammaFlip(p) : null,
    atmStrike: atm?.strike ?? null, atmNet: atm?.net ?? null,
    nearNet: nearRows.length ? nearRows.reduce((a, r) => a + r.net!, 0) : null,
  };
}

export type RegimeName = "Positive Gamma" | "Negative Gamma" | "Near the gamma flip";
export interface Regime { name: RegimeName; volatility: "LOW VOL" | "HIGH VOL" | "UNSTABLE"; summary: string; expectation: string }
/** Regime of the aggregate: its sign, unless spot sits within 0.2 % of the flip, where a small move can change it. */
export function regimeFor(l: GexLevels): Regime | null {
  if (l.netTotal == null) return null;
  if (l.flip != null && Math.abs(l.spot - l.flip) / l.spot <= 0.002)
    return { name: "Near the gamma flip", volatility: "UNSTABLE", summary: "Spot is within 0.2% of the gamma flip: a small move can change the modelled regime.", expectation: "Whipsaw risk: treat the wall levels with lower confidence." };
  return l.netTotal >= 0
    ? { name: "Positive Gamma", volatility: "LOW VOL", summary: "Under the convention (calls positive, puts negative) hedging leans against moves: it sells strength and buys weakness.", expectation: "Range-bound behaviour with a pull toward the inner levels is the modelled tendency." }
    : { name: "Negative Gamma", volatility: "HIGH VOL", summary: "Under the convention hedging follows moves: it buys strength and sells weakness.", expectation: "Range expansion and accepted breaks that extend are the modelled tendency." };
}

/** The two key levels around spot: the highest at or below it and the lowest above it (walls, peak, flip, max pain). */
export function corridor(spot: number, levels: (number | null)[]): { lower: number | null; upper: number | null; widthPct: number | null } {
  const ls = levels.filter((x): x is number => x != null);
  const below = ls.filter((x) => x <= spot), above = ls.filter((x) => x > spot);
  const lower = below.length ? Math.max(...below) : null, upper = above.length ? Math.min(...above) : null;
  return { lower, upper, widthPct: lower != null && upper != null ? ((upper - lower) / spot) * 100 : null };
}

export type StrikeType = "Call wall" | "Put wall" | "+GEX" | "−GEX";
export function strikeType(r: GexRow, l: GexLevels): StrikeType | null {
  if (r.strike === l.callWall) return "Call wall";
  if (r.strike === l.putWall) return "Put wall";
  return r.net == null ? null : r.net >= 0 ? "+GEX" : "−GEX";
}
export const IMPLICATION: Record<StrikeType, string> = {
  "Call wall": "Largest call gamma concentration at or above spot",
  "Put wall": "Largest put gamma concentration at or below spot",
  "+GEX": "Stabilizing: hedging dampens moves around this strike",
  "−GEX": "Amplifying: hedging accelerates moves around this strike",
};

// ---------------------------------------------------------------- gamma density (smoothed concentration over all strikes)
export interface Density { xs: number[]; sell: number[]; buy: number[]; neutral: number[]; sellPeak: number | null; buyPeak: number | null; neutralPeak: number | null; sellBuy: number[] }
/** Gaussian-smoothed call GEX ("sell gamma"), |put GEX| ("buy gamma") and their sum ("neutral") across the strikes. `smooth` widens the kernel. */
export function gammaDensity(rows: GexRow[], smooth = 1): Density | null {
  const pts = rows.filter((r) => r.ce != null || r.pe != null).sort((a, b) => a.strike - b.strike);
  if (pts.length < 3) return null;
  const gaps = pts.slice(1).map((r, i) => r.strike - pts[i]!.strike).sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)] || 50;
  const h = step * 1.5 * smooth;
  const lo = pts[0]!.strike - 2 * step, hi = pts[pts.length - 1]!.strike + 2 * step;
  const n = Math.round((hi - lo) / (step / 5));
  const xs = Array.from({ length: n + 1 }, (_, i) => lo + (i * (hi - lo)) / n);
  const k = (x: number, c: number) => Math.exp(-((x - c) ** 2) / (2 * h * h)) / smooth; // a wider kernel keeps the total area, so it lowers and spreads the peaks
  const sell = xs.map((x) => pts.reduce((a, r) => a + (r.ce ?? 0) * k(x, r.strike), 0));
  const buy = xs.map((x) => pts.reduce((a, r) => a + Math.abs(r.pe ?? 0) * k(x, r.strike), 0));
  const neutral = sell.map((s, i) => s + buy[i]!);
  const peak = (v: number[]) => { let b = 0; v.forEach((y, i) => { if (y > v[b]!) b = i; }); return v[b]! > 0 ? xs[b]! : null; };
  const sellBuy: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = sell[i - 1]! - buy[i - 1]!, b = sell[i]! - buy[i]!;
    if (a !== b && (a < 0) !== (b < 0)) sellBuy.push(xs[i - 1]! + ((0 - a) * (xs[i]! - xs[i - 1]!)) / (b - a));
  }
  return { xs, sell, buy, neutral, sellPeak: peak(sell), buyPeak: peak(buy), neutralPeak: peak(neutral), sellBuy };
}

// ---------------------------------------------------------------- through the session
export interface GexSample { t: number; day: string; profile: GexProfile }
const istDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const quote = (ltp: number | null, oi: number | null) => ({ ltp, oi } as unknown as OptionQuote);

/** The GEX profile of the series' strikes at every in-session sample. */
export function gexSamples(res: StrikeSeries, expiry: string, rate = RISK_FREE_RATE): GexSample[] {
  const out: GexSample[] = [];
  res.times.forEach((iso, i) => {
    const t = new Date(iso).getTime();
    const spot = res.spot[i];
    if (!isSessionMs(t) || spot == null) return;
    const rows = res.strikes.map((k) => ({ strike: k, call: quote(res.ce_price[String(k)]?.[i] ?? null, res.ce_oi[String(k)]?.[i] ?? null), put: quote(res.pe_price[String(k)]?.[i] ?? null, res.pe_oi[String(k)]?.[i] ?? null) }) as OptionChainRow);
    out.push({ t, day: istDay(t), profile: gexProfile(rows, spot, expiry, t, rate) });
  });
  return out;
}

export interface StructurePoint { t: number; spot: number; net: number | null; peak: number | null; callWall: number | null; putWall: number | null; flip: number | null; roc: number | null }
/** Net GEX, walls, peak and flip at each sample; `roc` = change of net GEX per minute since the previous point. */
export function gexStructure(samples: GexSample[]): StructurePoint[] {
  const out: StructurePoint[] = [];
  for (const s of samples) {
    const l = gexLevels(s.profile, 5, true);
    const prev = out[out.length - 1];
    const minutes = prev ? (s.t - prev.t) / 60_000 : 0;
    out.push({ t: s.t, spot: s.profile.spot, net: l.netTotal, peak: l.peak, callWall: l.callWall, putWall: l.putWall, flip: l.flip, roc: prev && minutes > 0 && prev.net != null && l.netTotal != null ? (l.netTotal - prev.net) / minutes : null });
  }
  return out;
}

/** "5.38K" for thousands of crore, otherwise crore with two decimals. */
export function fmtCrore(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  const s = a >= 1000 ? `${(a / 1000).toFixed(2)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return `${v < 0 ? "−" : ""}${s}`;
}
