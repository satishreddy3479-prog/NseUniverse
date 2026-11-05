/**
 * Vega analysis from the stored one-minute chain samples.
 *
 * Vega here is the Greek: the change in one option's price, in rupees, for a one-point change in its implied volatility
 * (Black-76, volatility solved from each contract's own last price). Two views:
 *  - LEVEL of a strike window: the average vega of the calls (and of the puts) of the chosen strikes, per candle;
 *  - CHANGE of an anchored band: the sum of vega over the calls from the at-the-money strike of the open upwards and over
 *    the puts from it downwards, measured from a baseline sample (each strike from its own value at the baseline).
 * A contract with no usable price gives no vega and is left out of the average or sum, never counted as zero.
 */
import { isSessionMs } from "./analytics";
import { chainGreeks } from "./optionTools";
import type { OptionChainRow, OptionQuote, StrikeSeries } from "./types";

export interface VegaSample {
  t: number;
  /** IST calendar day of the sample */
  day: string;
  spot: number;
  fwd: number | null;
  ce: Map<number, number>;
  pe: Map<number, number>;
}

const istDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const quote = (ltp: number | null) => ({ ltp, oi: null } as unknown as OptionQuote);

/** Vega of every listed strike, both sides, at every in-session sample of the series. */
export function vegaSamples(res: StrikeSeries, expiry: string, rate = 0.06): VegaSample[] {
  const out: VegaSample[] = [];
  res.times.forEach((iso, i) => {
    const t = new Date(iso).getTime();
    const spot = res.spot[i];
    if (!isSessionMs(t) || spot == null) return;
    const rows = res.strikes.map((k) => ({ strike: k, call: quote(res.ce_price[String(k)]?.[i] ?? null), put: quote(res.pe_price[String(k)]?.[i] ?? null) }) as OptionChainRow);
    const g = chainGreeks(rows, spot, expiry, t, rate);
    const ce = new Map<number, number>();
    const pe = new Map<number, number>();
    for (const x of g.strikes) {
      if (x.ce) ce.set(x.strike, x.ce.vegaPt);
      if (x.pe) pe.set(x.strike, x.pe.vegaPt);
    }
    out.push({ t, day: istDay(t), spot, fwd: g.forward, ce, pe });
  });
  return out;
}

export interface LevelPoint { t: number; day: string; spot: number; fwd: number | null; ce: number | null; pe: number | null; avg: number | null; diff: number | null }

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Average call vega and average put vega over `strikes`, per sample; CE − PE only where both exist. */
export function vegaLevel(samples: VegaSample[], strikes: number[]): LevelPoint[] {
  return samples.map((s) => {
    const ce = mean(strikes.flatMap((k) => (s.ce.has(k) ? [s.ce.get(k)!] : [])));
    const pe = mean(strikes.flatMap((k) => (s.pe.has(k) ? [s.pe.get(k)!] : [])));
    return { t: s.t, day: s.day, spot: s.spot, fwd: s.fwd, ce, pe, avg: ce != null && pe != null ? (ce + pe) / 2 : (ce ?? pe), diff: ce != null && pe != null ? ce - pe : null };
  });
}

/** The last point inside each candle of `tf` minutes counted from the open: vega is a level, so the candle shows where it ended. */
export function candles<T extends { t: number }>(points: T[], tf: number, openMin: number): T[] {
  if (tf <= 1) return points;
  const key = (t: number) => {
    const d = new Date(t + 330 * 60_000);
    return `${d.toISOString().slice(0, 10)}|${Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes() - openMin) / tf)}`;
  };
  const out: T[] = [];
  let last = "";
  for (const p of points) {
    const k = key(p.t);
    if (k === last) out[out.length - 1] = p; else out.push(p);
    last = k;
  }
  return out;
}

/** Percentile rank (0-100) of `v` among `history`: the share of values below it plus half the share equal to it. */
export function percentileRank(history: number[], v: number | null): number | null {
  if (v == null || history.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const h of history) { if (h < v) below++; else if (h === v) equal++; }
  return ((below + equal / 2) / history.length) * 100;
}

export type Regime = "Low Vega" | "Normal Vega" | "High Vega";
/** Our own rule: the lowest third of the stored history is low, the highest third high. */
export function regimeOf(rank: number | null): Regime | null {
  return rank == null ? null : rank < 100 / 3 ? "Low Vega" : rank >= 200 / 3 ? "High Vega" : "Normal Vega";
}

export interface ChangePoint { t: number; day: string; spot: number; fwd: number | null; call: number | null; put: number | null; ceN: number; peN: number }

/**
 * Change of the summed vega of an anchored band since a baseline sample. A strike counts at a sample only if it has a vega both
 * there and at the baseline, so a strike that gets its first price later adds nothing (instead of looking like a build-up).
 * `normalized` divides by the band's baseline sum (percent change). The baseline sample itself is 0.
 */
export function vegaChange(samples: VegaSample[], ceStrikes: number[], peStrikes: number[], baselineIndex: number, normalized = false): ChangePoint[] {
  const b = samples[Math.max(0, Math.min(samples.length - 1, baselineIndex))];
  if (!b) return [];
  const side = (s: VegaSample, strikes: number[], pick: "ce" | "pe") => {
    let now = 0;
    let base = 0;
    let n = 0;
    for (const k of strikes) {
      const x = s[pick].get(k);
      const y = b[pick].get(k);
      if (x == null || y == null) continue;
      now += x; base += y; n++;
    }
    if (n === 0) return { v: null as number | null, n };
    return { v: normalized ? (base === 0 ? null : ((now - base) / base) * 100) : now - base, n };
  };
  return samples.slice(Math.max(0, baselineIndex)).map((s) => {
    const c = side(s, ceStrikes, "ce");
    const p = side(s, peStrikes, "pe");
    return { t: s.t, day: s.day, spot: s.spot, fwd: s.fwd, call: c.v, put: p.v, ceN: c.n, peN: p.n };
  });
}

/** Call strikes from `atm` upwards and put strikes from `atm` downwards, `perSide` of each (the at-the-money strike is in both). */
export function anchoredBand(listed: number[], atm: number, perSide: number): { ce: number[]; pe: number[] } {
  const s = [...listed].sort((a, b) => a - b);
  let i = 0;
  s.forEach((k, j) => { if (Math.abs(k - atm) < Math.abs(s[i]! - atm)) i = j; });
  return { ce: s.slice(i, i + perSide), pe: s.slice(Math.max(0, i - perSide + 1), i + 1) };
}

export interface Stats { current: number | null; average: number | null; low: number | null; high: number | null }
export function stats(values: (number | null)[]): Stats {
  const v = values.filter((x): x is number => x != null);
  return { current: v.length ? v[v.length - 1]! : null, average: mean(v), low: v.length ? Math.min(...v) : null, high: v.length ? Math.max(...v) : null };
}

/** Plain-language reading of the level cards; thresholds are ours and stated in the text. */
export function readingOf(regime: Regime | null, rank: number | null, samples: number, skew: number | null, avg: number | null): { environment: string; skew: string } {
  const environment =
    regime == null
      ? "Not enough stored history to say whether vega is high or low: the percentile needs at least 100 stored samples of this strike window over two sessions."
      : regime === "Low Vega"
        ? `Vega is in the lowest third of the ${samples} stored samples (rank ${rank!.toFixed(0)}%): option prices respond less to a change in implied volatility than usual for this window.`
        : regime === "High Vega"
          ? `Vega is in the highest third of the ${samples} stored samples (rank ${rank!.toFixed(0)}%): option prices respond more to a change in implied volatility than usual for this window.`
          : `Vega is in the middle third of the ${samples} stored samples (rank ${rank!.toFixed(0)}%): normal sensitivity to implied volatility for this window.`;
  let sk: string;
  if (skew == null || avg == null || avg === 0) sk = "Call and put vega could not both be read for this window.";
  else if (Math.abs(skew) / avg < 0.01) sk = "Balanced: call and put vega differ by less than 1%. In theory they are equal at the same strike; a gap only appears because each contract is solved with its own implied volatility.";
  else sk = `${skew > 0 ? "Call" : "Put"} vega is higher by ${Math.abs(skew).toFixed(3)} (${((Math.abs(skew) / avg) * 100).toFixed(1)}%): that side's contracts are priced at a higher implied volatility. It describes relative pricing, not direction.`;
  return { environment, skew: sk };
}
