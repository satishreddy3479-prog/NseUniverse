/**
 * The open of the day.
 *
 * Pages poll on their own clocks (5 s to 60 s, some only when something changes), so at 09:15 each one learned that a new day had begun at a different moment, and a page that had failed
 * during the quiet pre-open (no data yet) stayed failed until its own next poll. Around the open the whole app is refreshed together at a few fixed moments, so every box starts the day
 * from the server's current answer: just before the open, just after it, and once more when the first minute's data has been stored.
 */
import type { QueryClient } from "@tanstack/react-query";
import { isHoliday, sessionOpenMin } from "./session";

const IST_MS = 330 * 60_000;
/** Seconds from the opening time: just before it (the day's state is ready), just after it, and after the first stored minute. */
export const ROLL_OFFSETS_S = [-30, 20, 90] as const;
/** A moment is still "due" this long after it (a tab that was asleep for a few seconds still catches it, one that was asleep for the whole open does not replay it). */
const GRACE_MS = 45_000;

/** The moments (UTC ms) of the open-of-day refreshes for the IST day of ``nowMs``; none on a weekend or an exchange holiday. */
export function rollMoments(nowMs: number): number[] {
  const d = new Date(nowMs + IST_MS);
  const ymd = d.toISOString().slice(0, 10);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || isHoliday(ymd)) return [];
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS;
  const open = midnight + sessionOpenMin() * 60_000;
  return ROLL_OFFSETS_S.map((s) => open + s * 1000);
}

/** The moment that is due now and has not fired yet (null if none). */
export function dueMoment(nowMs: number, fired: ReadonlySet<number>): number | null {
  return rollMoments(nowMs).find((t) => nowMs >= t && nowMs < t + GRACE_MS && !fired.has(t)) ?? null;
}

/** Starts the watch; returns a stop function. ``refresh`` is called once for each moment (default: every active query is fetched again). */
export function startOpenRoll(client: Pick<QueryClient, "invalidateQueries">, now: () => number = Date.now, refresh?: () => void, everyMs = 5_000): () => void {
  const fired = new Set<number>();
  const go = refresh ?? (() => { void client.invalidateQueries(); });
  const tick = () => {
    const t = dueMoment(now(), fired);
    if (t !== null) { fired.add(t); go(); }
  };
  tick();
  const id = window.setInterval(tick, everyMs);
  return () => window.clearInterval(id);
}
