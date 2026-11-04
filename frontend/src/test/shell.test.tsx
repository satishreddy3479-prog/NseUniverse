import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { summarize, type Signal } from "../lib/signals";
import { expiries, status, summary } from "./fixtures";

function mockApi(over: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/sessions": [],
    "/api/config/status": { credentials_present: {}, allowed_origins: [], host_is_loopback: true, underlying: "NIFTY", option_chain_strike_count: 40 },
    "/api/errors": [], ...over,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined
      ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 })
      : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("top menu bar", () => {
  it("Strategy Builder menu holds the builder and the portfolio; System does not", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    await userEvent.click(within(nav).getByRole("button", { name: /Strategy Builder/ }));
    expect(within(nav).getByRole("link", { name: "Strategy builder" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Strategy portfolio" })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: /System/ }));
    expect(within(nav).queryByRole("link", { name: "Strategy portfolio" })).toBeNull();
  });

  const bar = () => screen.getAllByRole("navigation", { name: "Main" })[0]!;

  it("has the tool menus and the main links in the bar", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    for (const name of ["Option Chain", "Prediction"])
      expect(within(bar()).getByRole("link", { name })).toBeInTheDocument();
    for (const name of ["Strategy Builder", "Options Lab", "Future Lab", "Analyse", "System"])
      expect(within(bar()).getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
  });

  it("opens a menu on click, closes it with Escape and after a choice", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const lab = within(bar()).getByRole("button", { name: /Options Lab/ });
    expect(lab).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(lab);
    expect(lab).toHaveAttribute("aria-expanded", "true");
    expect(within(bar()).getByRole("link", { name: /Smart OI/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(lab).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(lab);
    await userEvent.click(within(bar()).getByRole("link", { name: /Smart OI/ }));
    expect(lab).toHaveAttribute("aria-expanded", "false");
  });

  it("shows planned tools as disabled items with their reason, never as links", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /Options Lab/ }));
    expect(within(bar()).queryByRole("link", { name: /IV Grid/ })).toBeNull();
    const planned = within(bar()).getByText("IV Grid").closest("[aria-disabled]") as HTMLElement;
    expect(planned).toHaveAttribute("aria-disabled", "true");
    expect(planned.getAttribute("title")).toBeTruthy();
  });

  it("System menu reaches the platform pages", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /System/ }));
    for (const name of ["Platform status", "Data & sessions", "Connection diagnostics", "Settings"])
      expect(within(bar()).getByRole("link", { name })).toBeInTheDocument();
  });

  it("changes theme and remembers it", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const group = screen.getByRole("group", { name: "Theme" });
    await userEvent.click(within(group).getByRole("button", { name: "Ocean" }));
    expect(document.documentElement.dataset.theme).toBe("ocean");
    expect(within(group).getByRole("button", { name: "Ocean" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("top bar", () => {
  it("keeps the product, the NIFTY level and one status, and nothing else", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const header = document.querySelector("header") as HTMLElement;
    expect(await within(header).findByText("22,698.85")).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: /System status:/ })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(within(header).queryByRole("button", { name: /theme/i })).toBeNull();
    expect(within(header).queryByText(/Last update/)).toBeNull();
    expect(within(header).queryByRole("list", { name: "System signals" })).toBeNull();
    expect(within(header).queryByText(/Weekly/)).toBeNull();
  });

  it("status pill goes to the full status in Settings", async () => {
    mockApi();
    renderAt("/overview");
    await userEvent.click(await screen.findByRole("link", { name: /System status:/ }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "System status" });
    expect(await within(panel).findByRole("list", { name: "System signals" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(panel).getByText("Selected expiries")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeInTheDocument(); // theme lives here
  });

  it("shows a problem instead of hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderAt("/");
    expect(await screen.findByRole("link", { name: "System status: Backend offline" })).toBeInTheDocument();
  });
});

describe("status summary", () => {
  const sig = (key: Signal["key"], value: string, tone: Signal["tone"]): Signal => ({ key, label: key, value, tone, detail: "" });
  it("puts problems first, then warnings, then live vs stored data", () => {
    const base = [sig("broker", "Signed in", "ok"), sig("snapshot", "Last fetch OK", "ok"), sig("stream", "Streaming", "ok"),
      sig("market", "Open", "ok"), sig("freshness", "Live", "ok")];
    expect(summarize(base)).toMatchObject({ label: "Live", tone: "ok" });
    expect(summarize([...base.slice(0, 2), sig("stream", "Stale", "warn"), ...base.slice(3)])).toMatchObject({ label: "stream: Stale", tone: "warn" });
    expect(summarize([sig("broker", "Sign-in failed", "bad"), ...base.slice(1)])).toMatchObject({ label: "broker: Sign-in failed", tone: "bad" });
    const closed = [...base.slice(0, 2), sig("stream", "Market closed", "idle"), sig("market", "Closed", "idle"), sig("freshness", "Last session", "idle")];
    expect(summarize(closed)).toMatchObject({ label: "Last session", tone: "idle" });
  });
});

