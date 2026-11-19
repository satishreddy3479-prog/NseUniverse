import { afterEach, describe, expect, it } from "vitest";
import { holdProblem } from "../lib/strategy";
import { smartOiCandles } from "../lib/optionTools";
import { CAS_SECOND_DAY, closingSchedule, defaultCloseFor, resetSessionClock, sessionCloseHHMM, setSessionClock } from "../lib/session";

// From Monday 7 Dec 2026 continuous cash trading runs to 15:30, the closing auction is 15:30-15:40 and F&O trades to 15:45.
// Until 4 Dec the cash segment stops at 15:15 (seen live on 19 Nov 2026) and F&O closes at 15:40.
afterEach(() => resetSessionClock());

describe("the closing schedule by date", () => {
  it("moves the F&O close and the auction on 7 Dec 2026", () => {
    expect(CAS_SECOND_DAY).toBe("2026-12-07");
    expect([defaultCloseFor("2026-07-31"), defaultCloseFor("2026-11-19"), defaultCloseFor("2026-12-04"), defaultCloseFor("2026-12-07")]).toEqual(["15:30", "15:40", "15:40", "15:45"]);
    expect(closingSchedule("2026-11-19")).toEqual({ cashEnd: "15:15", indicativeFrom: "15:20", indexEnd: "15:30" });
    expect(closingSchedule("2026-12-04")).toEqual({ cashEnd: "15:15", indicativeFrom: "15:20", indexEnd: "15:30" });
    expect(closingSchedule("2026-12-07")).toEqual({ cashEnd: "15:30", indicativeFrom: "15:31", indexEnd: "15:40" });
  });
});

describe("the auto-close limit follows the session close", () => {
  it("allows a time up to the close in force and no later", () => {
    setSessionClock({ open: "09:15", close: "15:40", label: "09:15–15:40", source: "test", holidays: [] });
    expect(holdProblem({ mode: "intraday", closeAt: "15:40" })).toBeNull();
    expect(holdProblem({ mode: "intraday", closeAt: "15:42" })).toContain("09:15-15:40");
    setSessionClock({ open: "09:15", close: "15:45", label: "09:15–15:45", source: "test", holidays: [] });
    expect(sessionCloseHHMM()).toBe("15:45");
    expect(holdProblem({ mode: "intraday", closeAt: "15:42" })).toBeNull(); // F&O trades to 15:45 from 7 Dec
    expect(holdProblem({ mode: "intraday", closeAt: "15:46" })).toContain("09:15-15:45");
  });
});

describe("smartOiCandles: the closing value of the index on 7 Dec 2026", () => {
  const z = (min: number) => new Date(Date.UTC(2026, 11, 7, 9, 30 + min)).toISOString(); // 15:00 IST + min
  const run = (from: number) => {
    const m = Array.from({ length: 8 }, (_, i) => from + i);
    return smartOiCandles({ times: m.map(z), spot: m.map(() => 25227.95), ce_oi: m.map((_, i) => i + 1), pe_oi: m.map((_, i) => i + 1) }, 1, { day: "2026-12-07" }).stalls;
  };
  it("a constant that starts at 15:39 is the closing value, not a stall; one that starts at 15:26 still is", () => {
    expect(run(39)).toEqual([]);
    expect(run(26)).toHaveLength(1);
    // under the earlier schedule a constant from 15:29 on is already the closing value, and 15:26 a stall (the 18 Nov case)
    const m = Array.from({ length: 8 }, (_, i) => 29 + i);
    expect(smartOiCandles({ times: m.map((x) => new Date(Date.UTC(2026, 10, 18, 9, 30 + x)).toISOString()), spot: m.map(() => 25227.95), ce_oi: m.map((_, i) => i + 1), pe_oi: m.map((_, i) => i + 1) }, 1, { day: "2026-11-18" }).stalls).toEqual([]);
  });
});
