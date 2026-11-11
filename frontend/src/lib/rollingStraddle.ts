/**
 * ATM rolling straddle from the stored one-minute samples (pure functions; the board draws what this returns).
 *
 * The plain "ATM straddle" tool draws the straddle of whichever strike is ATM at each sample, so its line jumps every time the ATM strike changes
 * and part of every move is just a different contract. This module separates the pieces:
 *
 *   rolling premium   R[t] = straddle of the HELD strike at t (CE + PE price). The held strike follows a roll rule: "nearest" (the strike nearest spot at
 *                     every sample) or "after n steps" (stay with a strike until spot is n strike-gaps away from it, then roll to the nearest: fewer rolls).
 *   fixed premium     F[t] = straddle of the strike that was ATM at the first sample, held all session (what a position opened at the start would show).
 *   roll-adjusted     A[t] = A[t-1] + (price of the strike held at t-1, now) - (its price at t-1). It adds up only same-contract changes, so a roll creates no
 *                     jump: the pure premium path (decay and volatility) of a short straddle that is rolled by the rule.
 *   roll credit       at a roll, premium(new strike) - premium(old strike) at that sample: what a short-straddle seller takes in (+) or gives up (-) by rolling.
 *
 * A value that cannot be formed (a price missing for the held strike) is null: nothing is filled, carried or interpolated; the adjusted series
 * simply continues from its last known value when the next valid pair exists. Prices are last traded prices of stored samples, not bid/ask.
 */

export interface StrikeStraddle {
  strike: number;
  /** CE price + PE price at each sample, null where either price is missing */
  straddle: (number | null)[];
}

export type RollRule = { kind: "nearest" } | { kind: "steps"; n: number };

export interface RollEvent {
  index: number;
  time: number;
  from: number;
  to: number;
  spot: number;
  fromPremium: number | null;
  toPremium: number | null;
  /** premium(to) - premium(from) at that sample: positive = the new straddle is dearer (a seller receives more), null if a price is missing */
  credit: number | null;
}

export interface RollingStats {
  open: number | null;
  high: number | null;
  low: number | null;
  current: number | null;
  /** simple time average of the stored samples (not volume weighted: option volume is not part of this series) */
  average: number | null;
  changeFromOpen: number | null;
  changeFromOpenPct: number | null;
  adjustedChange: number | null;
  /** change of the roll-adjusted premium over the last 60 minutes of samples (null if the session is shorter) */
  adjustedLast60: number | null;
  spotOpen: number | null;
  spotNow: number | null;
  spotMove: number | null;
  /** |spot move since the first sample| divided by the opening premium: 1 = NIFTY has moved by as much as the opening straddle priced in */
  moveVsOpeningPremium: number | null;
  impliedMovePctNow: number | null;
  /** the held strike and the band held strike +- premium (the break-even levels of a straddle held at the strike right now) */
  heldNow: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  rolls: number;
  rollCreditTotal: number | null;
  rollsWithMissingPrice: number;
  missingPoints: number;
}

export interface RollingResult {
  times: number[];
  spot: (number | null)[];
  held: (number | null)[];
  rolling: (number | null)[];
  fixed: (number | null)[];
  adjusted: (number | null)[];
  impliedPct: (number | null)[];
  rolls: RollEvent[];
  openingStrike: number | null;
  step: number | null;
  stats: RollingStats;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The listed strike nearest spot (the lower one on an exact tie, as everywhere in the app). */
export function nearestStrike(strikes: readonly number[], spot: number): number | null {
  let best: number | null = null;
  for (const k of strikes) if (best == null || Math.abs(k - spot) < Math.abs(best - spot) || (Math.abs(k - spot) === Math.abs(best - spot) && k < best)) best = k;
  return best;
}

/** The gap between neighbouring listed strikes (the smallest one), null with fewer than two. */
export function strikeStep(strikes: readonly number[]): number | null {
  const s = [...new Set(strikes)].sort((a, b) => a - b);
  let min: number | null = null;
  for (let i = 1; i < s.length; i++) { const d = s[i]! - s[i - 1]!; if (min == null || d < min) min = d; }
  return min;
}

/** The strike held at each sample under the roll rule. A sample without a spot keeps the strike held before it (no information to roll on). */
export function heldStrikes(spot: readonly (number | null)[], strikes: readonly number[], rule: RollRule): (number | null)[] {
  const step = strikeStep(strikes);
  const out: (number | null)[] = [];
  let cur: number | null = null;
  for (const s of spot) {
    if (s == null) { out.push(cur); continue; }
    const near = nearestStrike(strikes, s);
    if (cur == null) cur = near;
    else if (rule.kind === "nearest") cur = near;
    else if (step != null && Math.abs(s - cur) >= rule.n * step) cur = near;
    out.push(cur);
  }
  return out;
}

export function rollingStraddle(times: readonly number[], spot: readonly (number | null)[], boards: readonly StrikeStraddle[], rule: RollRule = { kind: "nearest" }): RollingResult {
  const n = times.length;
  const by = new Map(boards.map((b) => [b.strike, b.straddle]));
  const strikes = boards.map((b) => b.strike);
  const held = heldStrikes(spot, strikes, rule);
  const price = (k: number | null, i: number): number | null => (k == null ? null : by.get(k)?.[i] ?? null);
  const rolling = held.map((k, i) => price(k, i));
  const first = spot.findIndex((s, i) => s != null && rolling[i] != null);
  const openingStrike = first < 0 ? null : held[first] ?? null;
  const fixed = Array.from({ length: n }, (_, i) => price(openingStrike, i));
  // roll-adjusted: only same-contract changes are added, so a roll adds no jump
  const adjusted: (number | null)[] = Array.from({ length: n }, () => null);
  let acc: number | null = null;
  for (let i = 0; i < n; i++) {
    if (acc == null) {
      if (rolling[i] != null) { acc = rolling[i]!; adjusted[i] = r2(acc); }
      continue;
    }
    const k = held[i - 1] ?? null;
    const now = price(k, i), before = price(k, i - 1);
    if (now != null && before != null) { acc += now - before; adjusted[i] = r2(acc); }
  }
  const rolls: RollEvent[] = [];
  for (let i = 1; i < n; i++) {
    const a = held[i - 1], b = held[i];
    if (a == null || b == null || a === b || spot[i] == null) continue;
    const fp = price(a, i), tp = price(b, i);
    rolls.push({ index: i, time: times[i]!, from: a, to: b, spot: spot[i]!, fromPremium: fp, toPremium: tp, credit: fp == null || tp == null ? null : r2(tp - fp) });
  }
  const impliedPct = rolling.map((v, i) => (v == null || spot[i] == null || spot[i]! <= 0 ? null : Math.round((v / spot[i]!) * 100 * 1000) / 1000));
  const valid = rolling.filter((v): v is number => v != null);
  const last = n - 1;
  const lastIdx = (a: readonly (number | null)[]) => { for (let i = last; i >= 0; i--) if (a[i] != null) return i; return -1; };
  const li = lastIdx(rolling);
  const open = first < 0 ? null : rolling[first]!;
  const current = li < 0 ? null : rolling[li]!;
  const adjOpen = first < 0 ? null : adjusted[first] ?? null;
  const ai = lastIdx(adjusted);
  const adjNow = ai < 0 ? null : adjusted[ai]!;
  let last60: number | null = null;
  if (ai >= 0) {
    const cut = times[ai]! - 60 * 60_000;
    const j = times.findIndex((t, i) => t >= cut && adjusted[i] != null);
    if (j >= 0 && times[0]! <= cut && j < ai) last60 = r2(adjNow! - adjusted[j]!);
  }
  const spotOpen = first < 0 ? null : spot[first] ?? null;
  const si = lastIdx(spot);
  const spotNow = si < 0 ? null : spot[si]!;
  const move = spotOpen == null || spotNow == null ? null : r2(spotNow - spotOpen);
  const heldNow = li < 0 ? null : held[li] ?? null;
  const credits = rolls.map((x) => x.credit);
  const stats: RollingStats = {
    open, high: valid.length ? Math.max(...valid) : null, low: valid.length ? Math.min(...valid) : null, current,
    average: valid.length ? r2(valid.reduce((s, v) => s + v, 0) / valid.length) : null,
    changeFromOpen: open == null || current == null ? null : r2(current - open),
    changeFromOpenPct: open == null || current == null || open === 0 ? null : r2(((current - open) / open) * 100),
    adjustedChange: adjOpen == null || adjNow == null ? null : r2(adjNow - adjOpen), adjustedLast60: last60,
    spotOpen, spotNow, spotMove: move, moveVsOpeningPremium: move == null || open == null || open === 0 ? null : Math.round((Math.abs(move) / open) * 1000) / 1000,
    impliedMovePctNow: li < 0 ? null : impliedPct[li] ?? null,
    heldNow, bandLow: heldNow == null || current == null ? null : r2(heldNow - current), bandHigh: heldNow == null || current == null ? null : r2(heldNow + current),
    rolls: rolls.length, rollCreditTotal: credits.some((c) => c != null) ? r2(credits.reduce<number>((s, c) => s + (c ?? 0), 0)) : null,
    rollsWithMissingPrice: credits.filter((c) => c == null).length, missingPoints: n - valid.length,
  };
  return { times: [...times], spot: [...spot], held, rolling, fixed, adjusted, impliedPct, rolls, openingStrike, step: strikeStep(strikes), stats };
}

/** Plain-language reading of the numbers: descriptive only, never a trade call. */
export function readRollingStraddle(r: RollingResult): string[] {
  const s = r.stats, out: string[] = [];
  const f = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  if (s.open == null || s.current == null) return ["Not enough stored samples with both option prices to read the premium."];
  out.push(`The rolling ATM straddle opened at ${s.open.toFixed(1)} and is ${s.current.toFixed(1)} now (${f(s.changeFromOpen ?? 0)} points). Part of that is rolling to different strikes: the roll-adjusted premium, which adds up only same-contract changes, is ${s.adjustedChange == null ? "unavailable" : `${f(s.adjustedChange)} points`}.`);
  if (s.rolls > 0) out.push(`${s.rolls} roll${s.rolls === 1 ? "" : "s"} under this rule; rolling credits (new strike's premium minus the old one's) add up to ${s.rollCreditTotal == null ? "unavailable" : `${f(s.rollCreditTotal)} points`}.`);
  if (s.moveVsOpeningPremium != null && s.spotMove != null) {
    const x = s.moveVsOpeningPremium;
    out.push(`NIFTY has moved ${f(s.spotMove, 0)} points since the first sample, ${(x * 100).toFixed(0)}% of the opening straddle premium${x >= 1 ? ": the market has already moved by more than the opening straddle priced in" : x < 0.4 ? ": well inside what the opening straddle priced in" : ""}.`);
  }
  if (s.adjustedLast60 != null) out.push(`Over the last hour the roll-adjusted premium changed ${f(s.adjustedLast60)} points (time decay and volatility together; this does not separate them).`);
  if (s.heldNow != null && s.bandLow != null && s.bandHigh != null) out.push(`A straddle at the ${s.heldNow} strike is break-even at expiry between ${s.bandLow.toFixed(0)} and ${s.bandHigh.toFixed(0)} (strike ± premium), ignoring costs.`);
  return out;
}
