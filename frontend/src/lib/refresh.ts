/** Refetch interval for data the server stores once a minute (the sampler's snapshots, the one-minute index bars): the next fetch is timed for a few seconds past the next minute
 *  mark, when the new sample has just been stored, instead of a fixed 15 or 30 seconds that runs out of step with it. React Query calls this after each fetch. */
export const SAMPLE_LAG_S = 8;
export function untilNextSample(now: number = Date.now(), lagS: number = SAMPLE_LAG_S): number {
  const wait = (lagS * 1000 - (now % 60_000) + 60_000) % 60_000;
  return wait < 2_000 ? wait + 60_000 : wait; // a fetch that ends within 2 s of the mark waits for the next one
}
export const minuteAligned = (): number => untilNextSample();
