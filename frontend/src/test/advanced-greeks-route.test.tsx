// The page is Advanced Greeks; the old address still works; the what-if scenarios are no longer on it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TOOLS } from "../lib/tools";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 }))));
afterEach(() => vi.unstubAllGlobals());
const at = (path: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);

describe("Advanced Greeks", () => {
  it("is titled Advanced Greeks at its new address and at the old one, and points to the Strategy Builder for scenarios", async () => {
    for (const path of ["/advanced-greeks", "/greeks-whatif"]) {
      const { unmount } = at(path);
      expect(await screen.findByRole("heading", { level: 1, name: "Advanced Greeks" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Strategy Builder" })).toHaveAttribute("href", "/strategy");
      expect(screen.queryByTestId("risk-scenario")).toBeNull(); // the what-if panel is not here
      expect(screen.queryByTestId("risk-matrix")).toBeNull();
      unmount();
    }
  });
  it("is listed under that name", () => {
    const t = TOOLS.find((x) => x.id === "advanced-greeks")!;
    expect(t.label).toBe("Advanced Greeks"); expect(t.to).toBe("/advanced-greeks");
    expect(TOOLS.some((x) => /What-If/.test(x.label))).toBe(false);
  });
});
