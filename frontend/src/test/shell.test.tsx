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
    for (const name of ["Market Intelligence", "Swing trading"])
      expect(within(bar()).getByRole("link", { name })).toBeInTheDocument();
    expect(within(bar()).queryByRole("link", { name: "Option Chain" })).toBeNull(); // the chain lives under FNO Tools now
    expect(within(bar()).queryByRole("button", { name: /Options Lab|Future Lab/ })).toBeNull(); // the two labs became one menu
    for (const name of ["Strategy Builder", "FNO Tools", "Analyse", "System"])
      expect(within(bar()).getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
  });

  it("opens a menu on click, closes it with Escape and after a choice", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const lab = within(bar()).getByRole("button", { name: /FNO Tools/ });
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

  it("FNO Tools has no Screeners section (OI Crossover, Intraday Booster and Option Triggers were removed)", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /FNO Tools/ }));
    for (const n of [/Screeners/i, /OI Crossover/, /Intraday Booster/, /Option Triggers/]) expect(within(bar()).queryByText(n)).toBeNull();
  });

  it("FNO Tools holds the option chain, the options tools and the futures tools together", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /FNO Tools/ }));
    expect(within(bar()).getByRole("link", { name: "Option Chain" })).toHaveAttribute("href", "/option-chain");
    expect(within(bar()).getByRole("link", { name: /Smart OI/ })).toBeInTheDocument(); // an options tool
    expect(within(bar()).getByRole("link", { name: /Future Dashboard/ })).toBeInTheDocument(); // a futures tool
  });

  it("FNO Tools is one A to Z list without group headings", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /FNO Tools/ }));
    const menu = within(screen.getByTestId("toolmenu-fno"));
    for (const g of ["Live chain", "OI tools", "Popular tools", "Price tools", "IV tools", "Futures price", "Futures OI", "Positioning"]) expect(menu.queryByText(new RegExp(`^${g}$`, "i"))).toBeNull();
    expect(menu.getByText(/All tools · A to Z/)).toBeInTheDocument();
    expect(menu.queryByTestId("recent-tools")).toBeNull(); // nothing used yet on this device
    const names = menu.getAllByRole("link").map((a) => a.textContent ?? "");
    expect(names.length).toBeGreaterThan(25);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true })));
  });

  it("the three most recently opened tools lead the menu, newest first", async () => {
    localStorage.setItem("nse-universe.recent-tools", JSON.stringify(["max-pain", "smart-oi", "option-chain", "straddle"]));
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(bar()).getByRole("button", { name: /FNO Tools/ }));
    const recent = within(screen.getByTestId("recent-tools"));
    expect(recent.getAllByRole("link").map((a) => a.textContent)).toEqual(["Max Pain", "Smart OI", "Option Chain"]); // only three
  });

  it("opening a tool page records it as the newest recent tool", async () => {
    mockApi();
    renderAt("/option-chain");
    await screen.findByRole("heading", { name: /option chain/i });
    expect(JSON.parse(localStorage.getItem("nse-universe.recent-tools") ?? "[]")[0]).toBe("option-chain");
  });

  it("Swing trading is a main section of its own, not inside Strategy Builder", async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    expect(within(bar()).getByRole("link", { name: "Swing trading" })).toHaveAttribute("href", "/swing");
    await userEvent.click(within(bar()).getByRole("button", { name: /Strategy Builder/ }));
    expect(within(bar()).getAllByRole("link", { name: "Swing trading" })).toHaveLength(1); // only the main one
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
    expect(within(group).queryByRole("button", { name: "Ocean" })).toBeNull();
    await userEvent.click(within(group).getByRole("button", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(within(group).getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("nse-universe.theme")).toBe("dark");
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


describe("phone menu", () => {
  const open = async () => {
    mockApi();
    renderAt("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    return within(document.getElementById("mobile-nav") as HTMLElement);
  };

  it("lists the main destinations first and the sections collapsed", async () => {
    const m = await open();
    for (const name of ["Home · all tools", "Market Intelligence", "Swing trading"]) expect(m.getByRole("link", { name })).toBeInTheDocument();
    for (const name of ["Strategy Builder", "FNO Tools", "Analyse", "System"]) expect(m.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    expect(m.queryByRole("link", { name: "Smart OI" })).toBeNull();
  });

  it("tapping a section shows its tools, and opening another closes the first", async () => {
    const m = await open();
    await userEvent.click(m.getByRole("button", { name: "Strategy Builder" }));
    expect(m.getByRole("link", { name: "Strategy builder" })).toBeInTheDocument();
    expect(m.getByRole("link", { name: "Strategy portfolio" })).toBeInTheDocument();
    await userEvent.click(m.getByRole("button", { name: "FNO Tools" }));
    expect(m.getByRole("button", { name: "FNO Tools" })).toHaveAttribute("aria-expanded", "true");
    expect(m.queryByRole("link", { name: "Strategy portfolio" })).toBeNull();
    expect(m.queryByRole("button", { name: /Live chain|Futures price/ })).toBeNull(); // no groups: one list
    expect(m.getByRole("link", { name: "Option Chain" })).toHaveAttribute("href", "/option-chain");
    expect(m.getByRole("link", { name: /Future Dashboard/ })).toBeInTheDocument();
  });

  it("FNO Tools on the phone is one A to Z list with a filter", async () => {
    const m = await open();
    await userEvent.click(m.getByRole("button", { name: "FNO Tools" }));
    const names = m.getAllByRole("link").map((a) => a.textContent ?? "").filter((x) => !/^(Home|Market Intelligence|Swing trading)/.test(x));
    expect(names.length).toBeGreaterThan(25);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true })));
    await userEvent.type(m.getByRole("searchbox", { name: "Find a tool" }), "straddle");
    const found = m.getAllByRole("link").map((a) => a.textContent ?? "");
    expect(found.some((x) => /Rolling Straddle/.test(x))).toBe(true);
    expect(found.some((x) => x === "Option Chain")).toBe(false);
    await userEvent.clear(m.getByRole("searchbox", { name: "Find a tool" }));
    await userEvent.type(m.getByRole("searchbox", { name: "Find a tool" }), "zzzz");
    expect(m.getByText(/No tool matches/)).toBeInTheDocument();
  });

  it("choosing a tool closes the menu", async () => {
    const m = await open();
    await userEvent.click(m.getByRole("button", { name: "System" }));
    await userEvent.click(m.getByRole("link", { name: "Settings" }));
    expect(document.getElementById("mobile-nav")).toBeNull();
  });
});
