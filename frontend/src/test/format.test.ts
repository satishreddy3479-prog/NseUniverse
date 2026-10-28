import { describe, expect, it } from "vitest";
import { ageSeconds, fmtAge, fmtExpiry, fmtInt, fmtPct, fmtPrice, fmtSigned, MISSING } from "../lib/format";

describe("format", () => {
  it("renders missing values as an em dash, never zero", () => {
    for (const f of [fmtPrice, fmtInt, fmtSigned, fmtPct, fmtExpiry, fmtAge]) {
      expect(f(null as never)).toBe(MISSING);
    }
    expect(fmtPrice(0)).toBe("0.00");
  });

  it("formats Indian digit grouping and signs", () => {
    expect(fmtInt(1234567)).toBe("12,34,567");
    expect(fmtSigned(-1500)).toBe("−1,500");
    expect(fmtSigned(1500)).toBe("+1,500");
    expect(fmtPct(2.5)).toBe("+2.50%");
  });

  it("keeps expiry calendar dates unshifted by time zone", () => {
    expect(fmtExpiry("2026-11-03")).toContain("03");
    expect(fmtExpiry("2026-11-03")).toContain("Nov");
  });

  it("computes ages", () => {
    expect(ageSeconds("2026-10-28T09:00:00Z", Date.parse("2026-10-28T09:01:30Z"))).toBe(90);
    expect(fmtAge(90)).toBe("1m ago");
  });
});
