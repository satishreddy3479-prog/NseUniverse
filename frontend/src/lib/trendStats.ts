/**
 * Trend / sideways statistics on NIFTY 50 one-minute index bars (and the NIFTY future's volume).
 *
 * Every function is pure. A figure that cannot be computed (too few bars, a flat window, a missing volume) is `null`, never zero.
 * These are DESCRIPTIVE statistics of the session so far: they say how the day has behaved, they do not forecast it. Only the daily
 * regime (Analyse > Trend & Regime) has a stored-history validation study; the intraday figures here are not validated.
 *
 *  - Efficiency Ratio (Kaufman): |net change| / sum of |bar changes| over n bars: 1 = a straight line, near 0 = going nowhere.
 *  - ADX / DMI (Wilder, n bars): +DI and -DI say which side is moving, ADX how strongly (direction-free).
 *  - Regression: slope and R^2 of closes on time: R^2 near 1 = one clean line.
 *  - Variance ratio (Lo-MacKinlay): variance of q-bar returns / (q x variance of 1-bar returns): > 1 trending, < 1 mean reverting.
 *  - Choppiness Index (Dreiss): 100 log10(sum of true ranges / range) / log10(n): high = choppy, low = trending.
 *  - Session mean: running mean of the closes (TWAP) and the future's volume-weighted price (VWAP).
 *  - Opening range: the first minutes' high / low and what the price did with it afterwards.
 */

export interface RBar { t: number; o: number; h: number; l: number; c: number; v?: number | null }

const IST_MS = 19_800_000; // +05:30
const OPEN_MIN = 555; // 09:15 as minutes after midnight

/** Minutes after IST midnight of a timestamp. */
export const istMinute = (t: number): number => Math.floor(((((t + IST_MS) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);

/** Group one-minute bars into m-minute bars anchored at 09:15 IST (m = 1 returns them unchanged). A bar's volume is the sum of its minutes' volumes, null when none had one. */
export function aggregate(bars: RBar[], m: number): RBar[] {
  if (m <= 1) return bars.map((b) => ({ ...b }));
  const out: RBar[] = [];
  let key = Number.NaN;
  for (const b of bars) {
    const k = Math.floor((istMinute(b.t) - OPEN_MIN) / m);
    const last = out[out.length - 1];
    if (k === key && last) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      if (b.v != null) last.v = (last.v ?? 0) + b.v;
    } else {
      out.push({ ...b });
      key = k;
    }
  }
  return out;
}

const trueRange = (b: RBar, prevClose: number | null) =>
  prevClose == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));

/** Average true range of the last n bars (simple mean; the first bar of the window uses the close before it). null with fewer than n + 1 bars. */
export function atr(bars: RBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += trueRange(bars[i]!, bars[i - 1]!.c);
  return s / n;
}

/** Kaufman efficiency ratio of the last n bar-to-bar changes of ``closes``. null with fewer than n + 1 closes, or when nothing moved. */
export function efficiencyRatio(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const w = closes.slice(closes.length - n - 1);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i]! - w[i - 1]!);
  return path === 0 ? null : Math.abs(w[w.length - 1]! - w[0]!) / path;
}

export interface AdxPoint { plusDi: number | null; minusDi: number | null; adx: number | null }

/** Wilder's DMI / ADX for every bar. Index i has +DI / -DI from bar n and ADX from bar 2n - 1; earlier bars are null. */
export function adx(bars: RBar[], n = 14): AdxPoint[] {
  const out: AdxPoint[] = bars.map(() => ({ plusDi: null, minusDi: null, adx: null }));
  if (bars.length < n + 1) return out;
  const tr: number[] = [0];
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i]!.h - bars[i - 1]!.h;
    const dn = bars[i - 1]!.l - bars[i]!.l;
    tr.push(trueRange(bars[i]!, bars[i - 1]!.c));
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTr = 0, sP = 0, sM = 0;
  for (let i = 1; i <= n; i++) { sTr += tr[i]!; sP += pdm[i]!; sM += mdm[i]!; }
  const dx: number[] = [];
  let adxPrev: number | null = null;
  for (let i = n; i < bars.length; i++) {
    if (i > n) { sTr += tr[i]! - sTr / n; sP += pdm[i]! - sP / n; sM += mdm[i]! - sM / n; }
    const p = sTr === 0 ? null : (100 * sP) / sTr;
    const m = sTr === 0 ? null : (100 * sM) / sTr;
    out[i]!.plusDi = p;
    out[i]!.minusDi = m;
    const d = p == null || m == null || p + m === 0 ? null : (100 * Math.abs(p - m)) / (p + m);
    if (d == null) { dx.length = 0; adxPrev = null; continue; }
    dx.push(d);
    if (adxPrev == null) {
      if (dx.length === n) { adxPrev = dx.reduce((a, b) => a + b, 0) / n; out[i]!.adx = adxPrev; }
    } else {
      adxPrev = (adxPrev * (n - 1) + d) / n;
      out[i]!.adx = adxPrev;
    }
  }
  return out;
}

export interface Regression { slope: number; r2: number | null; n: number }

/** Least-squares line of the last n closes on 0..n-1: slope per bar and R^2 (null when the closes are all equal). */
export function regression(closes: number[], n: number): Regression | null {
  if (closes.length < n || n < 3) return null;
  const y = closes.slice(closes.length - n);
  const xm = (n - 1) / 2;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (i - xm) ** 2; sxy += (i - xm) * (y[i]! - ym); syy += (y[i]! - ym) ** 2; }
  return { slope: sxy / sxx, r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy), n };
}

export interface VarianceRatio { vr: number; z: number; q: number; n: number }

/** Lo-MacKinlay variance ratio of the log price at horizon q (overlapping q-bar returns, small-sample corrected), with the homoskedastic z statistic.
 *  Needs at least 3q closes. */
export function varianceRatio(closes: number[], q: number): VarianceRatio | null {
  const N = closes.length - 1; // one-bar returns
  if (q < 2 || N < 3 * q || closes.some((c) => !(c > 0))) return null;
  const lp = closes.map(Math.log);
  const mu = (lp[N]! - lp[0]!) / N;
  let s1 = 0;
  for (let t = 1; t <= N; t++) s1 += (lp[t]! - lp[t - 1]! - mu) ** 2;
  const sa = s1 / (N - 1);
  if (sa === 0) return null;
  let sq = 0;
  for (let t = q; t <= N; t++) sq += (lp[t]! - lp[t - q]! - q * mu) ** 2;
  const m = q * (N - q + 1) * (1 - q / N);
  const vr = sq / m / sa;
  const z = (vr - 1) / Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * N));
  return { vr, z, q, n: N };
}

/** Choppiness Index of the last n bars, 0 to 100. null with fewer than n + 1 bars or a flat window. */
export function choppiness(bars: RBar[], n = 14): number | null {
  if (n < 2 || bars.length < n + 1) return null;
  let sum = 0, hi = -Infinity, lo = Infinity;
  for (let i = bars.length - n; i < bars.length; i++) {
    sum += trueRange(bars[i]!, bars[i - 1]!.c);
    hi = Math.max(hi, bars[i]!.h);
    lo = Math.min(lo, bars[i]!.l);
  }
  if (hi <= lo || sum <= 0) return null;
  return (100 * Math.log10(sum / (hi - lo))) / Math.log10(n);
}

/** Running mean of the values (the session TWAP when given closes). */
export function runningMean(values: number[]): number[] {
  let s = 0;
  return values.map((v, i) => { s += v; return s / (i + 1); });
}

/** Running volume-weighted price. A step whose price or volume is missing (or volume zero) adds nothing; the value there is the running figure so far, or null before any volume. */
export function runningVwap(prices: (number | null)[], vols: (number | null)[]): (number | null)[] {
  let pv = 0, v = 0;
  return prices.map((p, i) => {
    const w = vols[i];
    if (p != null && w != null && w > 0) { pv += p * w; v += w; }
    return v > 0 ? pv / v : null;
  });
}

export interface Structure { pctAbove: number; crossings: number; longestRun: number; runSide: 1 | -1 | 0; distance: number; n: number }

/** How the closes sit around a mean line: share of bars above it, how often they cross it, the longest stay on one side (in bars) and the last distance (close - mean).
 *  Bars equal to the mean count as neither side. Needs at least 2 compared bars. */
export function structure(closes: number[], mean: (number | null)[]): Structure | null {
  const sides: number[] = [];
  let last = 0;
  for (let i = 0; i < closes.length; i++) {
    const m = mean[i];
    if (m == null) continue;
    sides.push(Math.sign(closes[i]! - m));
    last = closes[i]! - m;
  }
  if (sides.length < 2) return null;
  const nz = sides.filter((s) => s !== 0);
  let crossings = 0;
  for (let i = 1; i < nz.length; i++) if (nz[i] !== nz[i - 1]) crossings++;
  let longest = 0, run = 0, runSide: 1 | -1 | 0 = 0, curSide = 0;
  for (const s of sides) {
    if (s !== 0 && s === curSide) run++;
    else { curSide = s; run = s === 0 ? 0 : 1; }
    if (run > longest) { longest = run; runSide = s as 1 | -1; }
  }
  return { pctAbove: (100 * sides.filter((s) => s > 0).length) / sides.length, crossings, longestRun: longest, runSide, distance: last, n: sides.length };
}

export interface OpeningRange {
  high: number; low: number; minutes: number; state: "inside" | "above" | "below"; barsOutside: number; breaks: number; falseBreaks: number; ready: boolean
}

/** The opening range (first ``minutes`` minutes from 09:15, by bar time) and the behaviour of the later closes: the side the last close is on, how many closes were outside the range,
 *  how many times the price broke out of it (inside -> outside) and how many of those returned inside afterwards (a failed break). null without bars in the range. */
export function openingRange(bars: RBar[], minutes = 15): OpeningRange | null {
  const inOr = bars.filter((b) => istMinute(b.t) - OPEN_MIN < minutes);
  const after = bars.filter((b) => istMinute(b.t) - OPEN_MIN >= minutes);
  if (inOr.length === 0) return null;
  const high = Math.max(...inOr.map((b) => b.h));
  const low = Math.min(...inOr.map((b) => b.l));
  let state: OpeningRange["state"] = "inside";
  let barsOutside = 0, breaks = 0, falseBreaks = 0;
  for (const b of after) {
    const s = b.c > high ? "above" : b.c < low ? "below" : "inside";
    if (s !== "inside") barsOutside++;
    if (state === "inside" && s !== "inside") breaks++;
    if (state !== "inside" && s === "inside") falseBreaks++;
    state = s;
  }
  return { high, low, minutes, state, barsOutside, breaks, falseBreaks, ready: after.length > 0 };
}

/** The range used so far against a normal day's: (high - low) / (1.5958 sigma_day), where 1.5958 = 2 sqrt(2/pi) is the expected range of a driftless random walk in units of its sigma and
 *  sigma_day = spot x IV / sqrt(252) (IV in percent, trading-day basis). 1 = a normal day's range already used. null without a positive IV. */
export function rangeUsed(high: number, low: number, spot: number, ivPct: number | null): number | null {
  if (ivPct == null || !(ivPct > 0) || !(spot > 0) || high < low) return null;
  return (high - low) / ((1.5958 * spot * (ivPct / 100)) / Math.sqrt(252));
}
