// Two scrollbars on the Swing page (5 Nov 2026): screen-reader-only text (`sr-only`, position: absolute) inside the scrolling
// <main> was positioned against the page, not against <main>, so it stretched the document and the page scrolled as well as
// <main>. The scrolling area must be its own positioning context. (Measured in a browser: document height 2122 px against an
// 800 px window before, equal after.)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("page shell", () => {
  it("keeps absolutely positioned descendants inside the one scrolling area", () => {
    const shell = readFileSync(resolve(__dirname, "..", "components", "AppShell.tsx"), "utf8");
    const main = shell.match(/<main className="([^"]+)"/)?.[1] ?? "";
    expect(main).toMatch(/\brelative\b/);
    expect(main).toMatch(/\boverflow-y-auto\b/);
  });
});
