/**
 * Gamma-exposure intelligence built on `gammaAnalysis.ts` (the single GEX calculation): the three strike universes, sign-convention
 * sensitivity, intraday dynamics (change, acceleration, persistence, migration, time above/below the flip) and the GEX-price
 * divergence reading. Nothing here recomputes gamma; every figure comes from `gexProfile` / `gexLevels` of a chosen set of strikes.
 * Registry ids: gex_universes, gex_sign_scenarios, gex_dynamics, gex_divergence.
 */
import { gexLevels, gexProfile, type GexLevels, type GexProfile, type StructurePoint } from "./gammaAnalysis";
import type { OptionChainRow } from "./types";

export type UniverseId = "fixed" | "dynamic" | "full";
export interface Universe {
  id: UniverseId; label: string; strikes: number[]; profile: GexProfile; levels: GexLevels;
  /** strikes in the universe, strikes with an exposure, strikes left out (no usable price, volatility or OI) */
  listed: number; used: number; excluded: number;
}

const around = (listed: number[], centre: number, each: number): number[] => {
  const ks = [...listed].sort((a, b) => a - b);
  if (ks.length === 0) return [];
  let i = 0;
  ks.forEach((k, j) => { if (Math.abs(k - centre) < Math.abs(ks[i]! - centre)) i = j; });
  return ks.slice(Math.max(0, i - each), i + each + 1);
};

/**
 * The same chain, the same expiry, lot convention (OI is already in units), rate and missing-data rule, over three sets of strikes:
 * fixed = the ATM +/- `each` strikes chosen at the session open and kept; dynamic = ATM +/- `each` around the current spot;
 * full = every listed strike. A universe the inputs cannot build (no opening ATM) is omitted, never substituted.
 */
export function gexUniverses(rows: OptionChainRow[], spot: number, expiry: string, atMs: number, openAtm: number | null, each = 10): Universe[] {
  const listed = rows.map((r) => r.strike);
  const sets: [UniverseId, string, number[]][] = [
    ["full", "Full chain", listed],
    ["dynamic", `Dynamic ATM ±${each} (current)`, around(listed, spot, each)],
    ...(openAtm == null ? [] : [["fixed", `Fixed opening ATM ±${each}`, around(listed, openAtm, each)] as [UniverseId, string, number[]]]),
  ];
  return sets.map(([id, label, strikes]) => {
    const keep = new Set(strikes);
    const profile = gexProfile(rows.filter((r) => keep.has(r.strike)), spot, expiry, atMs);
    const levels = gexLevels(profile, 5, true);
    return { id, label, strikes, profile, levels, listed: strikes.length, used: levels.strikesUsed, excluded: strikes.length - levels.strikesUsed };
  }).sort((a, b) => ["fixed", "dynamic", "full"].indexOf(a.id) - ["fixed", "dynamic", "full"].indexOf(b.id));
}

// ------------------------------------------------------------------ sign-convention sensitivity
export interface SignScenario { id: string; label: string; call: 1 | -1; put: 1 | -1 }
export const SIGN_SCENARIOS: SignScenario[] = [
  { id: "default", label: "Calls +, puts − (model default)", call: 1, put: -1 },
  { id: "reversed", label: "Calls −, puts +", call: -1, put: 1 },
  { id: "long_all", label: "Dealers long both (all +)", call: 1, put: 1 },
  { id: "short_all", label: "Dealers short both (all −)", call: -1, put: -1 },
];
/** Aggregate net GEX of a profile under another sign assumption: call GEX times its sign plus the put magnitude times its sign. Null if no strike has an exposure. */
export function scenarioNet(p: GexProfile, s: SignScenario): number | null {
  const used = p.rows.filter((r) => r.ce != null && r.pe != null);
  if (used.length === 0) return null;
  return used.reduce((a, r) => a + s.call * r.ce! + s.put * Math.abs(r.pe!), 0);
}

// ------------------------------------------------------------------ through the session
export const sideOfFlip = (spot: number, flip: number | null): "above" | "below" | null => (flip == null ? null : spot >= flip ? "above" : "below");

/** Minutes the underlying spent above and below the gamma flip (each interval takes the side at its start); minutes with no flip are reported separately. */
export function flipTime(points: StructurePoint[]): { above: number; below: number; unknown: number; crossings: number } {
  let above = 0, below = 0, unknown = 0, crossings = 0;
  let last: "above" | "below" | null = null;
  for (let i = 0; i < points.length; i++) {
    const side = sideOfFlip(points[i]!.spot, points[i]!.flip);
    if (side && last && side !== last) crossings++;
    if (side) last = side;
    const next = points[i + 1];
    if (!next) break;
    const m = (next.t - points[i]!.t) / 60_000;
    if (side === "above") above += m; else if (side === "below") below += m; else unknown += m;
  }
  return { above, below, unknown, crossings };
}

export type Migrating = "flip" | "callWall" | "putWall" | "peak";
/** First, last, extremes and the number of times a level moved to a different value through the session; missing values are skipped, not carried. */
export function migration(points: StructurePoint[], key: Migrating): { first: number | null; last: number | null; change: number | null; min: number | null; max: number | null; moves: number; n: number } {
  const vals = points.map((p) => p[key]).filter((v): v is number => v != null);
  let moves = 0;
  vals.forEach((v, i) => { if (i > 0 && v !== vals[i - 1]) moves++; });
  return {
    first: vals[0] ?? null, last: vals[vals.length - 1] ?? null, change: vals.length ? vals[vals.length - 1]! - vals[0]! : null,
    min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, moves, n: vals.length,
  };
}

export interface Dynamics {
  /** newest point versus the previous one (one candle) */
  netChange: number | null; netChangePct: number | null;
  /** change of the per-minute rate of change between the last two candles */
  acceleration: number | null;
  /** how many candles in a row the net GEX moved the same way, ending now, and the share of the last 10 moves that agree with the latest */
  persistence: { run: number; direction: "rising" | "falling" | null; share: number | null };
  flipMove: number | null; callWallMove: number | null; putWallMove: number | null; peakMove: number | null;
  spotChangePct: number | null;
}
const step = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a - b);

export function gexDynamics(points: StructurePoint[]): Dynamics {
  const n = points.length;
  const last = points[n - 1], prev = points[n - 2];
  const moves: number[] = [];
  for (let i = 1; i < n; i++) { const d = step(points[i]!.net, points[i - 1]!.net); if (d != null && d !== 0) moves.push(Math.sign(d)); }
  const dir = moves.length ? moves[moves.length - 1]! : 0;
  let run = 0;
  for (let i = moves.length - 1; i >= 0 && moves[i] === dir; i--) run++;
  const tail = moves.slice(-10);
  const netChange = step(last?.net, prev?.net);
  return {
    netChange,
    netChangePct: netChange == null || !prev || prev.net == null || prev.net === 0 ? null : (netChange / Math.abs(prev.net)) * 100,
    acceleration: last?.roc != null && prev?.roc != null ? last.roc - prev.roc : null,
    persistence: { run, direction: dir === 0 ? null : dir > 0 ? "rising" : "falling", share: tail.length && dir !== 0 ? tail.filter((m) => m === dir).length / tail.length : null },
    flipMove: step(last?.flip, prev?.flip), callWallMove: step(last?.callWall, prev?.callWall), putWallMove: step(last?.putWall, prev?.putWall), peakMove: step(last?.peak, prev?.peak),
    spotChangePct: last && prev && prev.spot ? (last.spot / prev.spot - 1) * 100 : null,
  };
}

// ------------------------------------------------------------------ GEX-price divergence
/** a spot move smaller than this (percent) is "flat"; a net-GEX change smaller than this share of the larger |net| is "unchanged" (our thresholds) */
export const SPOT_FLAT_PCT = 0.05;
export const GEX_FLAT_SHARE = 0.05;
export interface Divergence {
  windowMin: number | null; from: number | null; spotChange: number | null; spotChangePct: number | null;
  netThen: number | null; netNow: number | null; netChange: number | null; netChangePct: number | null;
  label: string; kind: "amplifying" | "stabilising" | "none" | "unavailable";
}
/** NIFTY and net GEX over the last `minutes` (or the whole session when null): the sign of each change decides the reading. */
export function gexPriceDivergence(points: StructurePoint[], minutes: number | null): Divergence {
  const none = (label: string): Divergence => ({ windowMin: minutes, from: null, spotChange: null, spotChangePct: null, netThen: null, netNow: null, netChange: null, netChangePct: null, label, kind: "unavailable" });
  const now = points[points.length - 1];
  if (!now || now.net == null) return none("No net GEX at the newest sample.");
  let then: StructurePoint | undefined;
  if (minutes == null) then = points.find((p) => p.net != null);
  else {
    const target = now.t - minutes * 60_000;
    const tol = Math.max(2, minutes * 0.25) * 60_000;
    for (const p of points) if (p.t <= target && p.net != null) then = p;
    if (!then || target - then.t > tol) then = undefined;
  }
  if (!then || then === now || then.net == null) return none(minutes == null ? "Only one sample with a net GEX." : `No stored sample about ${minutes} minutes earlier.`);
  const spotChange = now.spot - then.spot, spotPct = then.spot ? (now.spot / then.spot - 1) * 100 : null;
  const dNet = now.net - then.net, scale = Math.max(Math.abs(now.net), Math.abs(then.net));
  const base = { windowMin: minutes, from: then.t, spotChange, spotChangePct: spotPct, netThen: then.net, netNow: now.net, netChange: dNet, netChangePct: then.net === 0 ? null : (dNet / Math.abs(then.net)) * 100 };
  const spotMove = spotPct == null || Math.abs(spotPct) < SPOT_FLAT_PCT ? 0 : Math.sign(spotPct);
  const gexMove = scale === 0 || Math.abs(dNet) < GEX_FLAT_SHARE * scale ? 0 : Math.sign(dNet);
  if (spotMove === 0 || gexMove === 0) return { ...base, label: spotMove === 0 ? "NIFTY about flat: no divergence reading." : "Net GEX about unchanged: no divergence reading.", kind: "none" };
  const up = spotMove > 0, more = gexMove < 0; // "more negative" = net GEX fell
  const label = up
    ? more ? "NIFTY up while net GEX becomes more negative: potentially amplifying." : "NIFTY up while net GEX becomes more positive: potentially stabilising."
    : more ? "NIFTY down while net GEX becomes more negative: potential downside amplification." : "NIFTY down while net GEX becomes more positive: potential stabilisation.";
  return { ...base, label, kind: more ? "amplifying" : "stabilising" };
}
