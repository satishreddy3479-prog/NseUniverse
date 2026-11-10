/**
 * IV rank and IV percentile over a trailing range of trading days, for the IV / HV / IVP chart.
 *  IVR = (IV - lowest IV in the range) / (highest - lowest) x 100: where today's IV sits between the extremes.
 *  IVP = share of the days in the range whose IV was below today's, in percent.
 * Days without an IV are skipped, never counted as zero. A range that holds fewer than 80% of its days gives no figure
 * (missing, not a shorter range passed off as the full one).
 */
export const RANGES = [
  { id: "3M", days: 63 },
  { id: "6M", days: 126 },
  { id: "1Y", days: 252 },
] as const;
export const HV_WINDOWS = [10, 21, 63] as const;
/** 21 trading days is one month, 63 three months. */
export const hvLabel = (w: number) => (w === 21 ? "1M" : w === 63 ? "3M" : `${w}d`);

export interface Rank { ivr: number | null; ivp: number | null; low: number | null; high: number | null; n: number }

/** Rank of values[i] against values[i - range + 1 .. i]. */
export function rankAt(values: (number | null)[], i: number, range: number): Rank {
  const v = values[i];
  const win = values.slice(Math.max(0, i - range + 1), i + 1).filter((x): x is number => x != null);
  const none = { ivr: null, ivp: null, low: null, high: null, n: win.length };
  if (v == null || i + 1 < range || win.length < range * 0.8) return none;
  const low = Math.min(...win);
  const high = Math.max(...win);
  return {
    ivr: high > low ? ((v - low) / (high - low)) * 100 : null,
    ivp: (win.filter((x) => x < v).length / win.length) * 100,
    low, high, n: win.length,
  };
}

/** IVR and IVP at every day (null until the range has filled). */
export function rollingRank(values: (number | null)[], range: number): { ivr: (number | null)[]; ivp: (number | null)[] } {
  const r = values.map((_, i) => rankAt(values, i, range));
  return { ivr: r.map((x) => x.ivr), ivp: r.map((x) => x.ivp) };
}

/** Where IV stands, in words; the thresholds are ours (below 30 low, above 70 high). */
export function ivpReading(ivp: number | null, range: string): string {
  if (ivp == null) return `Not enough history for a ${range} percentile.`;
  const band = ivp < 30 ? "low: options are cheap against the last " + range : ivp > 70 ? "high: options are expensive against the last " + range : "middle of its " + range + " range";
  return `IV is higher than on ${ivp.toFixed(0)}% of days in the last ${range}: ${band}.`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-05" -> "5 Nov 26" */
export const fmtDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1] ?? "?"} ${iso.slice(2, 4)}`;
/** Show about `target` labels, counted back from the newest day so the latest date is always labelled. */
export function labelEvery(n: number, target = 7): (i: number) => boolean {
  const step = Math.max(1, Math.ceil(n / target));
  return (i) => (n - 1 - i) % step === 0;
}

/** The worked example under the IV chart, written from the figures on screen with the same `rankAt` result that fills the cards. */
export function rankExample(iv: number | null, rank: Rank, range: string, window: number, hv: number | null, rv: number | null): string[] {
  const out: string[] = [];
  if (iv != null && rank.low != null && rank.high != null && rank.ivr != null) {
    out.push(`IV Rank ${range} = (${iv.toFixed(2)} − ${rank.low.toFixed(2)}) / (${rank.high.toFixed(2)} − ${rank.low.toFixed(2)}) × 100 = ${rank.ivr.toFixed(1)}`);
  }
  if (iv != null && rank.ivp != null) out.push(`IV Percentile ${range} = ${Math.round((rank.ivp / 100) * rank.n)} days below ${iv.toFixed(2)} out of ${rank.n} days × 100 = ${rank.ivp.toFixed(1)}`);
  if (iv != null && hv != null) out.push(`IV − HV ${hvLabel(window)} = ${iv.toFixed(2)} − ${hv.toFixed(2)} = ${(iv - hv).toFixed(2)} points`);
  if (iv != null && rv != null) out.push(`IV − RV ${hvLabel(window)} = ${iv.toFixed(2)} − ${rv.toFixed(2)} = ${(iv - rv).toFixed(2)} points`);
  return out;
}
