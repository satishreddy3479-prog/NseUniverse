import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { readFileSync, existsSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TOOLS, toolPath } from "../lib/tools";

// AUDIT HARNESS, skipped unless AUDIT_DIR points at a folder of payloads captured from the server (curl each /api path to <path with / as _>.json, e.g. intelligence_straddle.json):
// renders every page against them, opens every tab and toggle, and fails when a page shows the error screen. (17 Nov 2026: found the straddle page crashing on a series that ended with missing minutes.)
const DIR = process.env.AUDIT_DIR ?? "";
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const routes = ["/", "/overview", "/market-intelligence", "/market-intelligence/straddle", "/option-chain", "/analysis", "/strategy", "/swing", "/data", "/portfolio", "/cleanup", "/server", "/diagnostics", "/settings",
  ...TOOLS.map((t) => toolPath(t)).filter((p): p is string => !!p && p !== "/option-chain"), "/tools/forward-test", "/tools/forward-test-cost"];

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://x");
    const name = u.pathname.replace(/^\/api\//, "").replace(/\/on-demand$/, "").replace(/\//g, "_") + ".json";
    const f = `${DIR}/${name}`;
    if (!existsSync(f)) return new Response("{}", { status: 404 });
    return new Response(readFileSync(f, "utf-8"), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!DIR)("every page renders with the captured server payloads", () => {
  for (const path of routes) {
    it(path, async () => {
      const errs: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errs.push(String(a[0]).slice(0, 200) + " " + String(a[1] ?? "").slice(0, 200)); });
      const { container, unmount } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
      await new Promise((r) => setTimeout(r, 1200));
      await waitFor(() => expect(container.textContent ?? "").not.toMatch(/This page could not be shown/), { timeout: 3000 });
      // every tab and every toggle button of the page is opened in turn: a crash often sits behind one
      const clicked = new Set<string>();
      for (let round = 0; round < 3; round++) {
        const btns = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"], button[aria-pressed], [role="tablist"] button')).filter((b) => !clicked.has(b.textContent ?? ""));
        for (const b of btns) {
          clicked.add(b.textContent ?? "");
          try { b.click(); } catch { /* a click handler threw: the check below sees the page state */ }
          await new Promise((r) => setTimeout(r, 150));
          expect(container.textContent ?? "", `after clicking "${b.textContent}"`).not.toMatch(/This page could not be shown/);
        }
      }
      const bad = errs.filter((e) => /The above error occurred|Cannot read|is not a function|undefined|null/.test(e) && !/act\(|not wrapped|ResizeObserver/.test(e));
      expect(bad, bad.join("\n")).toEqual([]);
      spy.mockRestore(); unmount();
    }, 20000);
  }
});
