import { describe, expect, it } from "vitest";
import { SAMPLE_LAG_S, untilNextSample } from "../lib/refresh";

describe("untilNextSample", () => {
  const at = (s: number, ms = 0) => Date.UTC(2026, 10, 18, 4, 6, s, ms); // 09:36:ss IST
  it("waits until 8 seconds past the next minute mark, when the sampler has stored its sample", () => {
    expect(SAMPLE_LAG_S).toBe(8);
    expect(untilNextSample(at(29))).toBe(39_000); // 09:36:29 -> 09:37:08
    expect(untilNextSample(at(50, 500))).toBe(17_500); // 09:36:50.5 -> 09:37:08
    expect(untilNextSample(at(2))).toBe(6_000); // 09:36:02 -> 09:36:08, the same minute
  });
  it("skips a mark that is less than 2 seconds away and is always between 2 and 62 seconds", () => {
    expect(untilNextSample(at(7))).toBe(61_000); // 1 s to the mark: wait for the next one
    for (let s = 0; s < 60; s++) {
      const w = untilNextSample(at(s));
      expect(w).toBeGreaterThanOrEqual(2_000);
      expect(w).toBeLessThan(62_000 + 1);
      expect(((at(s) + w) % 60_000)).toBe(8_000); // always lands on :08
    }
  });
});
