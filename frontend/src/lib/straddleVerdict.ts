/** The plain-language reading at the top of the Straddle page, written only from fields the straddle summary already carries (nothing is computed or invented here):
 *  what the conditions are, where the followed straddle stands, what is holding the scores back, and what would change the picture. */
import type { StraddleDecay } from "./straddleDecay";

export type Mode = "fixed" | "rolling";
export interface SideReading { score: number | null; label: string; move15: number | null }
export interface PositionReading { name: string; open: number | null; now: number | null; change: number | null; words: string }
export interface StraddleReading {
  headline: string;
  seller: SideReading | null;
  buyer: SideReading | null;
  positions: PositionReading[];
  cautions: string[];
  invalidation: string[];
  climate: { label: string; text: string | null } | null;
}

const move = (score: number | null | undefined, then: number | null | undefined): number | null => (score == null || then == null ? null : score - then);

function words(change: number | null): string {
  if (change == null) return "not enough data yet";
  if (change === 0) return "unchanged since the open";
  return change < 0 ? "the premium has fallen (decayed): a seller is ahead" : "the premium has risen: a seller is behind";
}

export function straddleReading(d: StraddleDecay): StraddleReading {
  const env = d.environment ?? null, tr = d.tracker, tn = d.environment_trend ?? null;
  const positions: PositionReading[] = [];
  if (tr) {
    positions.push({ name: `Fixed ${tr.fixed.strike}`, open: tr.fixed.straddle.open, now: tr.fixed.straddle.current, change: tr.fixed.straddle.change, words: words(tr.fixed.straddle.change) });
    positions.push({ name: `Rolling ATM${tr.atm_now == null ? "" : ` (now ${tr.atm_now})`}`, open: tr.rolling.straddle.open, now: tr.rolling.straddle.current, change: tr.rolling.adjusted_change, words: words(tr.rolling.adjusted_change) });
  }
  const cautions: string[] = [];
  if (env) {
    for (const f of env.seller.flags) cautions.push(f.text);
    if (env.seller.capped_by_flags) cautions.push(`The seller label is held at "${env.seller.capped_by_flags}" by the flags above, whatever the score says.`);
  }
  const q = d.quality;
  if (q?.stale) cautions.push(`Stale: the last sample is ${q.age_minutes == null ? "of unknown age" : `${q.age_minutes.toFixed(0)} min old`}.`);
  if (q && !q.live) cautions.push("A stored session, not live data.");
  return {
    headline: env ? env.comparison.text : (d.environment_note ?? "No environment is available."),
    seller: env ? { score: env.seller.score, label: env.seller.class, move15: move(env.seller.score, tn?.seller.m15) } : null,
    buyer: env ? { score: env.buyer.score, label: env.buyer.class, move15: move(env.buyer.score, tn?.buyer.m15) } : null,
    positions, cautions,
    invalidation: env ? env.invalidation.slice(0, 3) : [],
    climate: d.climate ? { label: d.climate.label, text: d.retention?.text ?? null } : null,
  };
}
