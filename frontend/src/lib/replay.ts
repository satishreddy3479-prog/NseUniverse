/**
 * Replay of a stored session on a tool page. The page loads the whole day once; replay only decides how much of it each chart may
 * show: everything up to the replay time and nothing after it. No value is made up: the steps are the stored samples (about one a
 * minute), a minute that was not recorded is simply not a step.
 */
import type { Observation } from "./types";

const IST_MS = 5.5 * 3600_000;

/** The IST calendar day (YYYY-MM-DD) of an instant. */
export const istDay = (iso: string | number): string => new Date((typeof iso === "number" ? iso : Date.parse(iso)) + IST_MS).toISOString().slice(0, 10);

/** The days that have stored samples, newest first. */
export function replayDays(obs: readonly Pick<Observation, "retrieved_at">[] | undefined): string[] {
  return [...new Set((obs ?? []).map((o) => istDay(o.retrieved_at)))].sort().reverse();
}

/** The sample times (ms) of one day, oldest first: the steps of the replay. */
export function replaySteps(obs: readonly Pick<Observation, "retrieved_at">[] | undefined, day: string | null): number[] {
  if (!day) return [];
  return (obs ?? []).map((o) => Date.parse(o.retrieved_at)).filter((t) => Number.isFinite(t) && istDay(t) === day).sort((a, b) => a - b);
}

/** The observations a replay at ``cutMs`` may show: earlier days in full, the replayed day up to the cut, nothing later. */
export function clipObservations<T extends Pick<Observation, "retrieved_at">>(obs: readonly T[], cutMs: number | null): T[] {
  return cutMs == null ? [...obs] : obs.filter((o) => Date.parse(o.retrieved_at) <= cutMs);
}

/**
 * A per-time series (``times`` plus arrays, or records of arrays, with one value per time) cut at ``cutMs``. Anything that is not
 * one value per time (strikes, warnings, definitions) is left alone. Returns the same object when there is no cut.
 */
export function clipSeries<T extends { times: string[] }>(s: T, cutMs: number | null): T {
  if (cutMs == null) return s;
  let n = 0;
  while (n < s.times.length && Date.parse(s.times[n]!) <= cutMs) n++;
  if (n === s.times.length) return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v) && v.length === s.times.length) out[k] = v.slice(0, n);
    else if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).length > 0 && Object.values(v).every((x) => Array.isArray(x) && x.length === s.times.length)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown[]>).map(([kk, arr]) => [kk, arr.slice(0, n)]));
    } else out[k] = v;
  }
  return out as unknown as T;
}

/** Index of the step at or before ``ms`` (-1 when it is before the first). */
export function stepAt(steps: readonly number[], ms: number): number {
  let lo = 0, hi = steps.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]! <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30] as const;
