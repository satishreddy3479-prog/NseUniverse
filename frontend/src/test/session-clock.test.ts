import { describe, expect, it } from "vitest";
import { marketClockMs } from "../lib/session";

const ist = (s: string) => Date.parse(`${s}+05:30`);
describe("marketClockMs", () => {
  it("keeps a time inside the session", () => expect(marketClockMs(ist("2026-10-29T11:00:00"))).toBe(ist("2026-10-29T11:00:00")));
  it("dates an after-close fetch to that day's 15:40 close", () => expect(marketClockMs(ist("2026-10-29T21:00:00"))).toBe(ist("2026-10-29T15:40:00")));
  it("the real case: fetched 02:37 IST on Fri 30 Oct holds the Thu 29 Oct 15:40 prices", () => expect(marketClockMs(Date.parse("2026-10-29T21:07:37Z"))).toBe(ist("2026-10-29T15:40:00")));
  it("a weekend fetch holds Friday's close", () => expect(marketClockMs(ist("2026-10-31T12:00:00"))).toBe(ist("2026-10-30T15:40:00")));
  it("a Monday pre-open fetch holds Friday's close", () => expect(marketClockMs(ist("2026-11-02T08:00:00"))).toBe(ist("2026-10-30T15:40:00")));
});
