import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

const rail = () => screen.getByLabelText("Menu", { selector: "aside" });

describe("side menu", () => {
  it("starts collapsed so the page keeps its width", async () => {
    mockApi();
    renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    expect(rail()).toHaveAttribute("data-expanded", "false");
  });

  it("opens on hover or touch, and on keyboard focus", async () => {
    mockApi();
    renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    fireEvent.pointerEnter(rail());
    expect(rail()).toHaveAttribute("data-expanded", "true");
    fireEvent.pointerLeave(rail());
    expect(rail()).toHaveAttribute("data-expanded", "false");
    act(() => within(rail()).getAllByRole("link")[1]!.focus());
    expect(rail()).toHaveAttribute("data-expanded", "true");
  });

  it("closes after a choice and stays closed until the pointer leaves and returns", async () => {
    mockApi();
    renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    fireEvent.pointerEnter(rail());
    await userEvent.click(within(rail()).getByRole("link", { name: /Settings/ }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(rail()).toHaveAttribute("data-expanded", "false");
    fireEvent.pointerEnter(rail()); // still hovering: no re-open
    expect(rail()).toHaveAttribute("data-expanded", "false");
    fireEvent.pointerLeave(rail());
    fireEvent.pointerEnter(rail());
    expect(rail()).toHaveAttribute("data-expanded", "true");
  });

  it("can be kept open, and remembers that", async () => {
    mockApi();
    const first = renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(rail()).getByRole("button", { name: /Keep menu open/ }));
    expect(rail()).toHaveAttribute("data-expanded", "true");
    expect(localStorage.getItem("nse.nav.pinned")).toBe("1");
    await userEvent.click(within(rail()).getByRole("link", { name: /Analysis/ }));
    expect(rail()).toHaveAttribute("data-expanded", "true"); // pinned: no auto-close
    first.unmount();
    renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    expect(rail()).toHaveAttribute("data-expanded", "true");
    await userEvent.click(within(rail()).getByRole("button", { name: /Collapse menu/ }));
    expect(rail()).toHaveAttribute("aria-label", "Menu");
    expect(localStorage.getItem("nse.nav.pinned")).toBe("0");
  });

  it("every page is still reachable by name from the collapsed rail", async () => {
    mockApi();
    renderAt("/");
    await screen.findByRole("heading", { name: "Overview" });
    for (const name of ["Overview", "Live option chain", "Expiry comparison", "Analysis", "Data & sessions", "Connection diagnostics", "Settings"])
      expect(within(rail()).getByRole("link", { name: new RegExp(name) })).toBeInTheDocument();
  });
});

describe("top bar", () => {
  it("keeps the product, the NIFTY level and one status, and nothing else", async () => {
    mockApi();
    renderAt("/");
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
    renderAt("/");
    await userEvent.click(await screen.findByRole("link", { name: /System status:/ }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "System status" });
    expect(await within(panel).findByRole("list", { name: "System signals" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(panel).getByText("Selected expiries")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "dark" })).toBeInTheDocument(); // theme lives here
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

