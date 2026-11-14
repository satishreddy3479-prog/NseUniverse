import { describe, expect, it } from "vitest";
import { labelRowOffset, labelRowsTop } from "../lib/gammaAnalysis";

describe("level labels above the GEX charts", () => {
  it("every label has a row of its own, however many there are (five levels used to wrap onto a row already taken)", () => {
    const offs = Array.from({ length: 7 }, (_, k) => labelRowOffset(k)[1]);
    expect(new Set(offs).size).toBe(7);
    expect(offs.slice(0, 3)).toEqual([0, -13, -26]); // rows 13 px apart, the first on the line's end
    expect(labelRowOffset(5)[0]).toBe(0); // never shifted sideways
  });
  it("the top margin leaves room for all the rows under the legend", () => {
    for (const n of [0, 1, 4, 5, 6]) {
      const highest = Math.abs(labelRowOffset(Math.max(0, n - 1))[1]); // how far above the plot the highest label sits
      expect(labelRowsTop(n)).toBeGreaterThanOrEqual(34 + highest + (n > 0 ? 13 : 0)); // 34 px for the legend line, then the rows
    }
    expect(labelRowsTop(5)).toBeGreaterThan(84); // five labels need more than the old fixed margin of 84
  });
});
