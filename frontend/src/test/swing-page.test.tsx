import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import type { SwingPaperView, SwingReport } from "../lib/types";
import { expiries, status, summary } from "./fixtures";
import { istToday, paperView, swingReport } from "./swingFixture";

// jsdom has no canvas: the chart wrapper becomes a stub that exposes what was plotted.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} />;
  },
}));

class RO { observe() {} unobserve() {} disconnect() {} }
type Reply<T> = T | { code: string; http: number } | null;

function reply<T>(body: Reply<T>): Response {
  if (body == null) return new Response("{}", { status: 500 });
  if (typeof body === "object" && "http" in (body as object)) {
    const b = body as { code: string; http: number };
    return new Response(JSON.stringify({ detail: { code: b.code, message: "x" } }), { status: b.http });
  }
  return new Response(JSON.stringify(body), { status: 200 });
}

let runCalls = 0;
const RUNNING = { phase: "Downloading prices", done: 312, total: 803, started_at: "2026-11-05T11:30:00Z" };

function mount(report: Reply<SwingReport> = swingReport(), paper: Reply<SwingPaperView> = paperView(),
               run: Reply<{ started: boolean }> = { started: true }) {
  runCalls = 0;
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0]!;
    if (url === "/api/swing/report") return reply(report);
    if (url === "/api/swing/paper/run" && init?.method === "POST") { runCalls += 1; return reply(run); }
    if (url === "/api/swing/paper") {
      // after the button is pressed the server reports the scan as running
      if (runCalls > 0 && paper && !("http" in (paper as object))) {
        const p = paper as SwingPaperView;
        return reply({ ...p, status: { ...p.status, running: true, progress: RUNNING } });
      }
      return reply(paper);
    }
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()] };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/swing"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

const openTab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("Swing trading page: paper trading", () => {
  it("opens on the paper book, which is in the menu, with the simulated-only warning and the book figures", async () => {
    mount();
    // the first test of the file pays for the lazy page chunk, which is slow when the whole suite runs at once
    expect(await screen.findByRole("heading", { name: "Swing trading", level: 1 }, { timeout: 10_000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Strategy Builder/ })); // the menu entry lives in this drop-down
    expect(await screen.findByRole("link", { name: /Swing trading/ })).toHaveAttribute("href", "/swing");
    expect(await screen.findByRole("tab", { name: "Paper trading", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("Paper trading: simulated, no real orders")).toBeInTheDocument();
    const figures = screen.getByRole("region", { name: "Paper book figures" });
    expect(within(figures).getByText("+2.45%")).toBeInTheDocument();
    expect(within(figures).getByText("NIFTY 50: +1.10%")).toBeInTheDocument();
    expect(within(figures).getByText("1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Paper book equity/ })).toHaveAttribute("data-series", expect.stringContaining("NIFTY 50"));
  });

  it("shows open positions with the stop stage, queued orders with trigger and no-chase price, and how earlier orders ended", async () => {
    mount();
    const pos = await screen.findByRole("table", { name: "Open paper positions" });
    expect(within(pos).getByText("TITAN")).toBeInTheDocument();
    expect(pos).toHaveTextContent("breakeven");
    expect(pos).toHaveTextContent("3.9%");
    const orders = screen.getByRole("table", { name: "Orders queued for the next session" });
    const rows = within(orders).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("KMEW");
    expect(rows[1]).toHaveTextContent("3,419.23");
    expect(rows[1]).toHaveTextContent("3,494.23");
    expect(rows[1]).toHaveTextContent("7.3% (wide)");
    expect(screen.getByText(/Gate at that close: NIFTY 50/)).toHaveTextContent("✓ open");
    expect(screen.getByText(/closed: FMCG & consumer/)).toBeInTheDocument();
    const decisions = screen.getByRole("table", { name: "Outcome of earlier orders" });
    expect(decisions).toHaveTextContent("✓ Filled 100 @ 3,500.00");
    expect(decisions).toHaveTextContent("✕ Skipped: opened 102.60, above the no-chase limit 102.50");
    expect(screen.getByRole("table", { name: "Closed paper trades" })).toHaveTextContent("Day-1 cut: closed below pivot");
  });

  it("explains an empty book instead of inventing numbers", async () => {
    const base = paperView();
    mount(swingReport(), paperView({
      book: { ...base.book, sessions: 0, as_of: null, started: null, equity: 1_000_000, return_pct: 0, nifty_return_pct: null },
      positions: [], orders: [], scan: null, decisions: [], trades: [], equity: [], trade_totals: { closed: 0, wins: 0, net_pnl: 0, costs: 0 },
      status: { ...base.status, last_run_at: null, last_result: "not run yet", started_session: null },
    }));
    expect(await screen.findByText("The scanner has not run yet")).toBeInTheDocument();
    expect(screen.getByText("No open positions")).toBeInTheDocument();
    expect(screen.getByText("Nothing queued")).toBeInTheDocument();
    expect(screen.getByText("No orders judged yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Paper book figures" })).not.toBeInTheDocument();
  });

  it("warns when the scanner has fallen behind, and says why nothing was queued", async () => {
    const base = paperView();
    mount(swingReport(), paperView({
      book: { ...base.book, as_of: istToday(-10) }, orders: [],
      scan: { ...base.scan!, blocked_by_gate: 2 },
      status: { ...base.status, last_result: "data_unavailable: only 600 of 791 stocks had usable bars; scan not trusted" },
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stale: the paper book was last updated for");
    expect(screen.getByRole("alert")).toHaveTextContent("scan not trusted");
    expect(screen.getByText("No stock passed every rule at this close")).toBeInTheDocument();
    expect(screen.getByText(/2 stock\(s\) would qualify but the market or sector gate is closed/)).toBeInTheDocument();
  });

  it("shows a plain error if the paper book cannot be read", async () => {
    mount(swingReport(), null);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the paper book");
  });

  it("tabs follow the arrow keys", async () => {
    mount();
    const first = await screen.findByRole("tab", { name: "Paper trading" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Backtest", selected: true })).toBeInTheDocument();
  });
});

describe("Swing trading page: backtest research", () => {
  it("shows the backtest with costs applied by default, switchable to before costs", async () => {
    mount();
    await openTab("Backtest");
    const figures = await screen.findByRole("region", { name: "Key figures" });
    expect(within(figures).getByText("+48.6%")).toBeInTheDocument();
    expect(within(figures).getAllByText(/NIFTY 50: \+32\.3%/).length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /Equity curve/ })).toHaveAttribute("data-series", expect.stringContaining("after costs"));
    await userEvent.click(screen.getByRole("button", { name: "Before costs" }));
    expect(within(figures).getByText("+95.4%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Equity curve/ })).toHaveAttribute("data-series", expect.stringContaining("before costs"));
    expect(screen.getByRole("note")).toHaveTextContent("94%"); // concentration warning is always visible
  });

  it("filters the trade list and exports exactly the filtered rows", async () => {
    mount();
    await openTab("Backtest trades");
    expect(await screen.findByText(/3 of 3 trades/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Entry year"), "2025");
    expect(screen.getByText(/2 of 3 trades/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Symbol"), "aris");
    expect(screen.getByText(/1 of 3 trades/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV (1)" })).toBeEnabled();
    await userEvent.type(screen.getByLabelText("Symbol"), "zzz");
    expect(screen.getByText("No trades match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV (0)" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText(/3 of 3 trades/)).toBeInTheDocument();
  });

  it("robustness shows numbers from the report and the original ledger comparison; rules list the limits", async () => {
    mount();
    await openTab("Robustness");
    const note = await screen.findByTestId("score-sensitivity");
    expect(note).toHaveTextContent("score ≥ 64: +22%");
    expect(note).toHaveTextContent("score ≥ 65 (rule): +95%");
    expect(screen.getByRole("table", { name: "Comparison with the original ledger" })).toHaveTextContent("402");
    await openTab("Rules & limits");
    expect(await screen.findByText("Universe is today's Chartink list; survivorship flatters the test.")).toBeInTheDocument();
    expect(screen.getByText(/scripts\\swing-refresh\.ps1/)).toBeInTheDocument();
  });

  it("paper trading still works when the backtest report has not been published to this machine", async () => {
    const { unmount } = mount({ code: "swing_report_missing", http: 404 });
    expect(await screen.findByRole("table", { name: "Open paper positions" })).toBeInTheDocument();
    await openTab("Backtest");
    expect(await screen.findByText("The backtest has not been published here")).toBeInTheDocument();
    expect(screen.getByText(/Copy that one file to the server/)).toBeInTheDocument();
    unmount();
    mount(null);
    await openTab("Robustness");
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Could not load this section");
  });
});

describe("Swing trading page: Run scan now", () => {
  it("starts the scan once, then shows it running with progress and disables the button", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Run scan now" }));
    expect(runCalls).toBe(1);
    expect(await screen.findByTestId("scan-progress")).toHaveTextContent("Running now: Downloading prices (312 of 803)");
    expect(screen.getByRole("button", { name: "Scan running…" })).toBeDisabled();
    expect(screen.getByText(/Scan started\. This page follows its progress/)).toBeInTheDocument();
  });

  it("cannot be pressed while a scan is already running, and says what it is doing", async () => {
    const base = paperView();
    mount(swingReport(), paperView({ status: { ...base.status, running: true, progress: RUNNING } }));
    expect(await screen.findByTestId("scan-progress")).toHaveTextContent("Downloading prices (312 of 803)");
    expect(screen.getByRole("button", { name: "Scan running…" })).toBeDisabled();
    expect(runCalls).toBe(0);
  });

  it("explains a refused start instead of failing silently", async () => {
    mount(swingReport(), paperView(), { code: "forbidden_origin", http: 403 });
    await userEvent.click(await screen.findByRole("button", { name: "Run scan now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start the scan");
    expect(screen.getByRole("button", { name: "Run scan now" })).toBeEnabled();
  });

  it("shows the last result in plain words", async () => {
    const base = paperView();
    mount(swingReport(), paperView({ status: { ...base.status, last_result: "up_to_date" } }));
    expect(await screen.findByText("Already up to date with the latest finished session")).toBeInTheDocument();
  });
});

