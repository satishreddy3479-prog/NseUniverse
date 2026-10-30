import { afterEach, describe, expect, it } from "vitest";
import { isSessionMs } from "../lib/analytics";
import { getSessionClock, isHoliday, marketClockMs, sessionCloseMin, setSessionClock } from "../lib/session";

const ist = (y: number, mo: number, d: number, h: number, m: number) => Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000;
const DEFAULT = { ...getSessionClock() };

describe("session clock from the backend", () => {
  afterEach(() => setSessionClock(DEFAULT));

  it("starts at 15:40 and follows the close the backend reports", () => {
    expect(sessionCloseMin()).toBe(15 * 60 + 40);
    expect(isSessionMs(ist(2026, 10, 30, 15, 35))).toBe(true);
    setSessionClock({ open: "09:15", close: "15:30", label: "09:15–15:30", source: "test", holidays: [] });
    expect(sessionCloseMin()).toBe(15 * 60 + 30);
    expect(isSessionMs(ist(2026, 10, 30, 15, 35))).toBe(false); // after the 15:30 close now
    expect(isSessionMs(ist(2026, 10, 30, 15, 30))).toBe(true);
    // prices after the close are dated to the close in force
    expect(marketClockMs(ist(2026, 10, 30, 21, 0))).toBe(ist(2026, 10, 30, 15, 30));
  });

  it("a weekday exchange holiday is not a session and the clock skips it", () => {
    setSessionClock({ ...DEFAULT, holidays: ["2026-11-10"] });
    expect(isHoliday("2026-11-10")).toBe(true);
    expect(isSessionMs(ist(2026, 11, 10, 11, 0))).toBe(false); // Tuesday holiday
    expect(isSessionMs(ist(2026, 11, 11, 11, 0))).toBe(true);
    // a fetch on the holiday holds the previous trading day's close (Mon 9 Nov 15:40)
    expect(marketClockMs(ist(2026, 11, 10, 11, 0))).toBe(ist(2026, 11, 9, 15, 40));
  });
});
