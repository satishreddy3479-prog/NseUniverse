/**
 * The mark-to-market graph of a closed strategy, kept with the record. At closing the page stores the live ticks it saw; the stored one-minute history from the entry to the close
 * (the sampler's strike series, and the future's) completes it, and the result is saved in the Closed record so the graph is there to open later on the Strategy portfolio page.
 * A record from before this existed is built from the stored history the first time its graph is asked for (the history is kept for a limited time; beyond it the graph says so).
 */
import { api } from "./api";
import type { FuturesSeries, StrikeSeries } from "./types";
import { isFuture, sign, type Leg } from "./strategy";
import { buildMtm, joinLive, mtmStats } from "./strategyMtm";

/** What a Closed record keeps of its graph. ``complete`` is false while only the live ticks seen at closing are in it. */
export interface StoredMtm {
  t: number[];
  pnl: number[];
  complete: boolean;
  /** "live" ticks seen on the page, "stored" one-minute samples, or both joined */
  source: "live" | "stored" | "stored+live";
  savedAt: string;
}
export interface ClosedLike { id: string; closedAt: string; lotSize: number; legs: (Leg & { exit?: number })[]; mtm?: StoredMtm }

const MAX_POINTS = 900;

/** The earliest entry minus a minute, as the page asks the stored history from: the same instant the live graph uses. "none" when no leg has an entry time. */
export function mtmSince(legs: readonly Leg[]): string | null {
  const ts = legs.map((l) => (l.enteredAt ? Date.parse(l.enteredAt) : NaN)).filter((x) => Number.isFinite(x));
  return ts.length ? new Date(Math.min(...ts) - 60_000).toISOString() : null;
}
/** Where the page keeps the live ticks of a strategy: by its first entry and its legs, so exits do not change it and the closing page can read it. */
export const liveMtmKey = (legs: readonly Leg[]): string => `nse.mtm.live.${mtmSince(legs) ?? "none"}.${legs.map((l) => l.id).join(",")}`;
export function readLiveTicks(legs: readonly Leg[]): { t: number; v: number }[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(liveMtmKey(legs)) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as { t: number; v: number }[]).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v)) : [];
  } catch { return []; }
}

/** At most ``max`` points, always keeping the first, the last, the highest and the lowest. */
export function thinPoints(pts: readonly { t: number; v: number }[], max = MAX_POINTS): { t: number; v: number }[] {
  if (pts.length <= max) return [...pts];
  const step = Math.ceil(pts.length / max);
  const keep = new Set<number>([0, pts.length - 1]);
  let hi = 0, lo = 0;
  pts.forEach((p, i) => { if (p.v > pts[hi]!.v) hi = i; if (p.v < pts[lo]!.v) lo = i; if (i % step === 0) keep.add(i); });
  keep.add(hi); keep.add(lo);
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]!);
}
export function toStored(pts: readonly { t: number; v: number }[], complete: boolean, source: StoredMtm["source"], now = new Date()): StoredMtm {
  const p = thinPoints(pts);
  return { t: p.map((x) => x.t), pnl: p.map((x) => Math.round(x.v * 100) / 100), complete, source, savedAt: now.toISOString() };
}
export const pointsOf = (m: StoredMtm): { t: number; v: number }[] => m.t.map((t, i) => ({ t, v: m.pnl[i]! }));
export const statsOf = (m: StoredMtm) => mtmStats(pointsOf(m));

/** The legs of a closed record as the graph needs them: a leg the "exit all" closed (exit price kept as ``exit``) is out at the closing time. */
export function legsForMtm(c: ClosedLike): Leg[] {
  return c.legs.filter((l) => l.enabled !== false).map(({ exit, ...l }) => {
    if (l.exitPrice != null) return { ...l, exitedAt: l.exitedAt ?? c.closedAt }; // closed by a stop, a target or a rule: its booked P&L is in ``realised``
    if (exit == null) return l; // still open when the record was made (should not happen): marked to the close
    // closed by "Exit all" at ``exit``: that result is booked at the closing time, on top of what earlier cycles booked
    const booked = (l.realised ?? 0) + sign(l.action) * (exit - (l.premium ?? exit)) * l.lots * c.lotSize;
    return { ...l, exitPrice: exit, exitedAt: c.closedAt, realised: booked };
  });
}

/**
 * The graph of a closed record from the stored history up to its close, joined to the live ticks already kept. Null when it cannot be built (the history has aged out, or the legs have
 * no entry time or entry price); ``reason`` then says why.
 */
export async function buildClosedMtm(c: ClosedLike, fetchers = { strikes: api.strikeSeries, futures: api.futuresSeries }): Promise<{ mtm: StoredMtm | null; reason: string | null }> {
  const legs = legsForMtm(c);
  const since = mtmSince(legs);
  if (!since) return { mtm: c.mtm ?? null, reason: c.mtm ? null : "No leg of this strategy has a recorded entry time, so its graph cannot be drawn." };
  const until = new Date(Date.parse(c.closedAt) + 60_000).toISOString();
  const exps = [...new Set(legs.filter((l) => !isFuture(l)).map((l) => l.expiry))].sort();
  const byExpiry: Record<string, StrikeSeries | undefined> = {};
  let fut: FuturesSeries | undefined;
  try {
    await Promise.all(exps.map(async (e) => {
      const ks = [...new Set(legs.filter((l) => !isFuture(l) && l.expiry === e).map((l) => l.strike))].sort((a, b) => a - b).join(",");
      byExpiry[e] = await fetchers.strikes(e, ks, since, until);
    }));
    if (legs.some(isFuture)) fut = await fetchers.futures(since);
  } catch (e) {
    return { mtm: c.mtm ?? null, reason: `The stored prices could not be read (${e instanceof Error ? e.message : "error"}).` };
  }
  const m = buildMtm(legs, c.lotSize, byExpiry, fut);
  const live = c.mtm && c.mtm.source !== "stored" ? pointsOf(c.mtm) : [];
  if (m.reason && live.length === 0) return { mtm: null, reason: m.reason };
  const stored = m.reason ? [] : m.t.map((t, i) => ({ t, pnl: m.pnl[i] ?? null })).filter((p) => p.t <= Date.parse(until));
  const pts = joinLive(stored, live);
  if (pts.length === 0) return { mtm: null, reason: "No stored price sample covers this strategy's time in the market." };
  return { mtm: toStored(pts, true, stored.length && live.length ? "stored+live" : live.length ? "live" : "stored"), reason: null };
}
