/**
 * Shaping stored one-minute prices for the global-markets chart. A closed market leaves hours with no prices; drawn on a time axis that is a
 * flat empty stretch (a 7-day chart of a US index becomes five small fragments). Here the axis is the samples themselves in order, so the line is
 * continuous, and every place where the market was closed is marked with a dotted separator that says how long it was closed.
 * Nothing is invented: no price is added, interpolated or carried across a closure.
 */
const IST_MS = 330 * 60_000;
export const istDayKey = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istHour = (ms: number): number => new Date(ms + IST_MS).getUTCHours();

export interface CompressedSeries {
  /** sample time, ms, in order: the category axis */
  ms: number[];
  values: number[];
  /** a closure: ``index`` is the first sample after it, ``gapMs`` how long no price was stored */
  breaks: { index: number; gapMs: number }[];
}

/** Keep the valid samples in time order and find the closures (a silence longer than ``gapMs``). */
export function compressSeries(times: readonly string[], prices: readonly (number | null)[], gapMs: number): CompressedSeries {
  const pts: { t: number; v: number }[] = [];
  times.forEach((x, i) => {
    const t = Date.parse(x), v = prices[i];
    if (Number.isFinite(t) && v != null && Number.isFinite(v)) pts.push({ t, v });
  });
  pts.sort((a, b) => a.t - b.t);
  const breaks: CompressedSeries["breaks"] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i]!.t - pts[i - 1]!.t > gapMs) breaks.push({ index: i, gapMs: pts[i]!.t - pts[i - 1]!.t });
  return { ms: pts.map((p) => p.t), values: pts.map((p) => p.v), breaks };
}

/**
 * Which samples carry an axis label. Several days: the first sample of each IST day. One day: the first sample of every ``everyHours`` hours
 * (IST), and the very first sample.
 */
export function labelIndexes(ms: readonly number[], multiDay: boolean, everyHours = 2): Set<number> {
  const out = new Set<number>();
  let prev = "";
  ms.forEach((t, i) => {
    const key = multiDay ? istDayKey(t) : `${istDayKey(t)}|${Math.floor(istHour(t) / everyHours)}`;
    if (key !== prev) out.add(i);
    prev = key;
  });
  return out;
}

/** "5h 20m", "45m": how long a market was closed. */
export function gapText(gapMs: number): string {
  const m = Math.round(gapMs / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
}

export interface RangeStats { first: number; last: number; change: number; changePct: number | null; high: number; low: number; n: number }
/** Change over the drawn range, and its high and low. Null with fewer than two samples. */
export function rangeStats(values: readonly number[]): RangeStats | null {
  if (values.length < 2) return null;
  const first = values[0]!, last = values[values.length - 1]!;
  return { first, last, change: last - first, changePct: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null, high: Math.max(...values), low: Math.min(...values), n: values.length };
}
