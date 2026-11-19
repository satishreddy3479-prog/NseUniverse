import { describe, expect, it } from "vitest";
import { lookup } from "../lib/glossary";

// One vocabulary for how a price is labelled: every label the app can put on a level explains itself the same way wherever it appears.
describe("the data-state glossary", () => {
  it.each(["live price", "held price", "stored snapshot", "stand in candle", "indicative closing value", "closing auction"])("has an entry for %s", (term) => {
    const f = lookup(term);
    expect(f).not.toBeNull();
    expect(f!.entry.what.length).toBeGreaterThan(40);
    expect(f!.entry.read.length).toBeGreaterThan(20);
  });

  it("says when the closing auction moves", () => {
    const e = lookup("closing auction")!.entry;
    expect(e.what).toContain("15:15-15:35 until Friday 4 Dec 2026");
    expect(e.what).toContain("15:30-15:40 from Monday 7 Dec 2026");
  });

  it("calls the held price a pre-open price before the open and not a traded price", () => {
    expect(lookup("held price")!.entry.caution).toContain("pre-open");
  });
});
