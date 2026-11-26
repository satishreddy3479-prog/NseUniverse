import { afterEach, describe, expect, it, vi } from "vitest";
import { dueMoment, rollMoments, startOpenRoll } from "../lib/openRoll";
import { resetSessionClock } from "../lib/session";

// 09:15 IST on Thursday 26 Nov 2026 = 03:45:00 UTC
const OPEN = Date.UTC(2026, 10, 26, 3, 45, 0);

afterEach(() => { vi.useRealTimers(); resetSessionClock(); });

describe("the open of the day", () => {
  it("refreshes just before the open, just after it and after the first stored minute, on a trading day only", () => {
    expect(rollMoments(OPEN + 3_600_000).map((t) => (t - OPEN) / 1000)).toEqual([-30, 20, 90]);
    expect(rollMoments(Date.UTC(2026, 10, 28, 5, 0, 0))).toEqual([]); // Saturday
    expect(rollMoments(Date.UTC(2026, 10, 29, 5, 0, 0))).toEqual([]); // Sunday
  });

  it("a moment is due for a short while, once", () => {
    const fired = new Set<number>();
    expect(dueMoment(OPEN - 40_000, fired)).toBeNull();
    expect(dueMoment(OPEN - 29_000, fired)).toBe(OPEN - 30_000);
    fired.add(OPEN - 30_000);
    expect(dueMoment(OPEN - 28_000, fired)).toBeNull(); // already done
    expect(dueMoment(OPEN + 25_000, fired)).toBe(OPEN + 20_000);
    expect(dueMoment(OPEN + 20_000 + 60_000, new Set([OPEN + 20_000]))).toBeNull(); // a tab asleep through a moment does not replay it late
  });

  it("calls the refresh once per moment while the clock runs through the open", () => {
    vi.useFakeTimers();
    let now = OPEN - 60_000;
    const refresh = vi.fn();
    const stop = startOpenRoll({ invalidateQueries: vi.fn() } as never, () => now, refresh, 5_000);
    for (let i = 0; i < 40; i++) { now += 5_000; vi.advanceTimersByTime(5_000); } // 200 s: 08:14:15 .. 09:17:35
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("refreshes every active query by default", () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();
    const stop = startOpenRoll({ invalidateQueries: invalidate } as never, () => OPEN - 20_000, undefined, 5_000);
    expect(invalidate).toHaveBeenCalledTimes(1); // at the first look, the moment is due
    stop();
  });
});
