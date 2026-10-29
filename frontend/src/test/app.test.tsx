import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { chain, expiries, status, summary } from "./fixtures";

type Routes = Record<string, unknown | (() => Response)>;

function mockFetch(routes: Routes) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    const hit = routes[url];
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    if (typeof hit === "function") return (hit as () => Response)();
    return new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const base = {
  "/api/status": status(),
  "/api/expiries": expiries,
  "/api/snapshots": [],
  "/api/sessions": [],
  "/api/config/status": { credentials_present: { kotak_mpin: false },
    allowed_origins: [], host_is_loopback: true, underlying: "NIFTY", option_chain_strike_count: 40 },
  "/api/errors": [],
};

afterEach(() => vi.unstubAllGlobals());

describe("dashboard", () => {
  it("renders the overview with no demo or mock labelling anywhere", async () => {
    mockFetch(base);
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /System status:/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/demo|synthetic|mock/i);
  });

  it("shows loading skeletons before data arrives", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = renderAt("/");
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("shows empty states when nothing is captured", async () => {
    mockFetch(base);
    renderAt("/");
    expect(await screen.findByText("No snapshots stored")).toBeInTheDocument();
    expect(screen.getAllByText("Not started").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start stream" })).toBeEnabled();
  });

  it("reports an unreachable backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderAt("/");
    expect((await screen.findAllByText("Backend offline")).length).toBeGreaterThan(0);
  });

  it("never shows underlying price as a number before it is available", async () => {
    mockFetch(base);
    renderAt("/");
    const label = await screen.findByText("Underlying price");
    expect(within(label.parentElement!).getByText(/Unavailable/)).toBeInTheDocument();
  });

  it("shows the underlying price only from a snapshot, labelled as not live", async () => {
    mockFetch({ ...base, "/api/snapshots": [summary()] });
    renderAt("/");
    expect((await screen.findAllByText("22,698.85")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/From snapshot .*not live/).length).toBeGreaterThan(0);
  });

  it("labels the monthly roll to next month", async () => {
    mockFetch(base);
    renderAt("/");
    expect(await screen.findByText(/Next month: no expiry left this month/)).toBeInTheDocument();
  });

  it("marks stored snapshots as historical and missing values as dashes", async () => {
    mockFetch({ ...base, "/api/snapshots": [summary()],
      [`/api/snapshots/${summary().snapshot_id}`]: chain() });
    renderAt(`/data?snapshot=${summary().snapshot_id}`);
    expect(await screen.findByText(/Historical snapshot retrieved/)).toBeInTheDocument();
    expect(screen.getAllByText("Stored (historical)").length).toBeGreaterThan(0);
    const table = screen.getByRole("table", { name: /Option chain/ });
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(table).getByText("101.50")).toBeInTheDocument();
  });

  it("shows planned pages honestly instead of fake features", async () => {
    mockFetch(base);
    renderAt("/expiry-comparison");
    expect(await screen.findByText("Planned for Checkpoint 3")).toBeInTheDocument();
  });

  it("sends the old /charts address to the analysis dashboard", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    mockFetch(base);
    renderAt("/charts");
    expect(await screen.findByRole("heading", { name: "Intraday analysis" }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Intraday analysis" }).length).toBeGreaterThan(0);
  });

  it("opens the mobile navigation menu", async () => {
    mockFetch(base);
    renderAt("/");
    const btn = screen.getByRole("button", { name: "Menu" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const navs = screen.getAllByRole("navigation", { name: "Main" });
    expect(navs.length).toBe(2);
  });

  it("surfaces snapshot capture errors from the backend", async () => {
    mockFetch({ ...base, "/api/snapshots/capture": () =>
      new Response(JSON.stringify({ detail: { code: "rate_limited", message: "broker rate limit reached; retry later" } }), { status: 429 }) });
    renderAt("/");
    const btn = await screen.findByRole("button", { name: "Capture snapshot" });
    await screen.findByText("Weekly expiry");
    await userEvent.click(btn);
    expect(await screen.findByText("broker rate limit reached; retry later")).toBeInTheDocument();
  });
});

describe("older backend still running", () => {
  const oldStatus = { ...status(), stream: { implemented: false, state: "not_implemented", note: "old" } };

  it("Overview renders and tells the user to restart the backend", async () => {
    mockFetch({ ...base, "/api/status": oldStatus });
    renderAt("/");
    expect(await screen.findByText("The running backend is an older version")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "System status: Stream: Backend needs restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start stream" })).toBeDisabled();
  });

  it("Diagnostics renders instead of crashing", async () => {
    mockFetch({ ...base, "/api/status": oldStatus });
    renderAt("/diagnostics");
    expect(await screen.findByRole("heading", { name: "Connection diagnostics" })).toBeInTheDocument();
    expect(await screen.findByText("The running backend is an older version")).toBeInTheDocument();
  });
});
