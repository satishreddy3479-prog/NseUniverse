import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TOOLS, toolPath } from "../lib/tools";
import { expiries, status, summary } from "./fixtures";

function mockApi() {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [],
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined
      ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 })
      : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("tool registry", () => {
  it("ids are unique and every ready tool resolves to a route", () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      if (t.status === "ready") expect(toolPath(t)).toBeTruthy();
      else { expect(toolPath(t)).toBeNull(); expect(t.needs).toBeTruthy(); }
    }
  });
});

describe("home", () => {
  it("lists ready tools as links and planned tools as disabled cards with their reason", async () => {
    mockApi();
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /option and futures tools/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Smart OI/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /IV Grid/ })).toBeNull();
    const card = screen.getByText("IV Grid").closest("[aria-disabled]") as HTMLElement;
    expect(within(card).getByText(/Needs implied volatility/)).toBeInTheDocument();
  });

  it("search narrows the tools", async () => {
    mockApi();
    renderAt("/");
    await userEvent.type(await screen.findByRole("searchbox", { name: "Search tools" }), "gamma");
    expect(screen.getAllByText("Gamma Exposure").length).toBeGreaterThan(0);
    expect(screen.queryByText("Max Pain")).toBeNull();
  });
});

describe("tool page", () => {
  it("a planned tool says it is not built and does not show a chart", async () => {
    mockApi();
    renderAt("/tools/iv-grid");
    expect(await screen.findByText(/Planned, not built yet/)).toBeInTheDocument();
  });

  it("an unknown tool says so", async () => {
    mockApi();
    renderAt("/tools/nope");
    expect(await screen.findByText(/no such tool/)).toBeInTheDocument();
  });

  it("an index tool reports a server without stock data instead of inventing numbers", async () => {
    mockApi();
    renderAt("/tools/index-contributors");
    expect(await screen.findByRole("heading", { name: "Index Contributors" })).toBeInTheDocument();
    expect(await screen.findByText(/Stock breadth is turned off on this server/)).toBeInTheDocument();
  });
});
