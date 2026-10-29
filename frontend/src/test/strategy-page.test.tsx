import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import type { BacktestResult } from "../lib/types";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return {
    ...actual,
    EChart: ({ option, ariaLabel }: { option: { series?: { name?: string }[] }; ariaLabel: string }) => (
      <div role="img" aria-label={ariaLabel} data-series={(option.series ?? []).map((s) => s.name).join("|")} />
    ),
  };
});

const result = (): BacktestResult => ({
  config_hash: "abc123", data_fingerprint: "def456",
  data: { sessions_with_enough_samples: ["2026-10-28", "2026-10-29"], first: "2026-10-28", last: "2026-10-29", samples_per_session: { "2026-10-28": 375 }, price_source: "stored last traded prices", history_starts: "2026-10-28" },
  metrics: { trades: 2, wins: 1, losses: 1, win_rate: 50, gross_pnl: 1000, net_pnl: 800, avg_win: 1300, avg_loss: -500, avg_trade: 400, profit_factor: 2.6, max_drawdown: 500, largest_win: 1300, largest_loss: -500, avg_minutes_held: 30, sharpe_note: "not computed: 2 trades; a ratio needs at least 30 to mean anything" },
  trades: [{ session: "2026-10-28", expiry: "2026-11-03", entry_at: "2026-10-28T03:50:00Z", exit_at: "2026-10-28T04:20:00Z", entry_spot: 24050, exit_spot: 24060, legs: [{ type: "CE", action: "SELL", strike: 24050, lots: 1, entry: 100, exit: 80 }], gross: 1500, costs: 200, net: 1300, exit_reason: "time", minutes_held: 30, samples_skipped_missing_price: 0 }],
  equity_curve: [{ at: "2026-10-28T04:20:00Z", session: "2026-10-28", equity: 1300 }], monthly_net: { "2026-10": 800 }, yearly_net: { "2026": 800 },
  by_expiry_day: { "before expiry": { n: 2, net_pnl: 800, win_rate: 50, enough_data: false } }, by_day_direction: {}, regime_note: "described afterwards",
  skipped_sessions: [{ session: "2026-10-27", reason: "only 10 stored samples (needs 30)" }], unpriced_sessions: [],
  warnings: ["2 trades over 2 stored session(s): this shows the mechanics, not a durable edge. At least 30 trades are needed before any conclusion."],
});

let posted: unknown[] = [];
beforeEach(() => {
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    if (url === "/api/strategy/backtest" && init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(result()), { status: 200 }); }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/option-chain": chain,
      "/api/strategy/availability": { underlying: "NIFTY", sessions: [{ session: "2026-10-27", samples: 10, usable: false }, { session: "2026-10-28", samples: 375, usable: true }, { session: "2026-10-29", samples: 376, usable: true }], min_samples_per_session: 30, source: "Option chains this app stored itself" },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/strategy"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
const pick = async (id: string) => { await userEvent.selectOptions(await screen.findByLabelText("Template"), id); };

describe("Strategy builder page", () => {
  it("shows the instrument, the stored chain's lot size and never hard-codes one", async () => {
    mount();
    expect(await screen.findByText("NIFTY 50")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle(/instrument data in the stored chain/)).toHaveTextContent("75")); // the fixture's lot size, not a built-in number
    expect(screen.getByText(/BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX need their own contract master/)).toBeInTheDocument();
  });

  it("a long straddle template fills editable legs and shows hand-calculated risk (premium 100 + 100, lot 75)", async () => {
    mount();
    await screen.findByLabelText("Template");
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("long_straddle");
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(table).getAllByLabelText("Strike")).toHaveLength(2);
    const stats = await screen.findByTestId("risk-stats");
    expect(stats).toHaveTextContent("Max loss−₹15,000"); // 200 x 75
    expect(stats).toHaveTextContent("Max profitUnlimited");
    expect(stats).toHaveTextContent("23,850 · 24,250"); // 24050 -/+ 200
    expect(stats).toHaveTextContent("−₹15,000 debit");
    expect(screen.getByRole("img", { name: "Strategy payoff" })).toHaveAttribute("data-series", "At expiry");
    expect(screen.getByRole("table", { name: "P&L table" })).toBeInTheDocument();
  });

  it("every leg is editable: lots, duplicate, remove; bad input is explained", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("short_call");
    const lots = await screen.findByLabelText("Lots");
    await userEvent.clear(lots);
    await userEvent.type(lots, "0");
    expect(await screen.findByText("Lots must be a whole number of at least 1.")).toBeInTheDocument();
    expect(screen.getByText("Fix the highlighted legs to see the payoff.")).toBeInTheDocument();
    await userEvent.clear(lots);
    await userEvent.type(lots, "2");
    await userEvent.click(screen.getByRole("button", { name: "Duplicate leg" }));
    expect(screen.getAllByLabelText("Lots")).toHaveLength(2);
    await userEvent.click(screen.getAllByRole("button", { name: "Remove leg" })[0]!);
    expect(screen.getAllByLabelText("Lots")).toHaveLength(1);
  });

  it("a missing premium is asked for, never assumed", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("long_call");
    const prem = await screen.findByLabelText("Entry premium");
    await userEvent.clear(prem);
    expect(await screen.findByText("Enter the entry premium of every leg.")).toBeInTheDocument();
    await userEvent.type(prem, "120");
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("Max loss−₹9,000"); // 120 x 75
  });

  it("a multi-expiry template is built, but says there is no single expiry payoff and blocks the historical test", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("calendar");
    const legs = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(legs).getAllByLabelText("Leg expiry").map((s) => (s as HTMLSelectElement).value)).toEqual(["2026-11-03", "2026-11-24"]);
    expect(await screen.findByText(/Enter the entry premium of every leg|different dates/)).toBeInTheDocument();
    expect(screen.getByTestId("bt-blocker")).toHaveTextContent("one expiry per strategy");
  });

  it("saves a strategy by name and loads it back", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("bull_call_spread");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "my spread");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("No legs yet")).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText("Saved strategies"), "my spread");
    expect(within(await screen.findByRole("table", { name: "Strategy legs" })).getAllByLabelText("Strike")).toHaveLength(2);
  });
});

describe("Historical test panel", () => {
  it("states what history exists, runs on the stored data and shows results with their limits", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("bt-availability")).toHaveTextContent("2 usable sessions (2026-10-28 to 2026-10-29), 1 with too few samples"));
    expect(screen.getByTestId("bt-availability")).toHaveTextContent("multi-year results cannot be produced");
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled(); // nothing to test yet
    await pick("short_straddle");
    await userEvent.type(await screen.findByLabelText("Stop-loss"), "5000");
    await userEvent.click(screen.getByRole("button", { name: "Run test" }));
    const res = await screen.findByTestId("bt-result");
    expect(res).toHaveTextContent("not a durable edge");
    expect(within(res).getByTestId("bt-metrics")).toHaveTextContent("Net P&L (after costs)+₹800");
    expect(res).toHaveTextContent("too few trades to conclude");
    expect(res).toHaveTextContent("only 10 stored samples (needs 30)");
    expect(screen.getByTestId("bt-repro")).toHaveTextContent("configuration abc123, stored data def456");
    const sent = posted[0] as { legs: { type: string; action: string; offset_steps: number }[]; stop_loss: { mode: string; value: number }; entry_time: string };
    expect(sent.legs).toEqual([{ type: "CE", action: "SELL", lots: 1, offset_steps: 0 }, { type: "PE", action: "SELL", lots: 1, offset_steps: 0 }]); // ATM offsets, not absolute strikes
    expect(sent.stop_loss).toEqual({ mode: "rupees", value: 5000 });
    expect(sent.entry_time).toBe("09:20");
  });

  it("strike offsets are measured in listed strikes from the ATM", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("bear_put_spread");
    await userEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await screen.findByTestId("bt-result");
    expect((posted[0] as { legs: { offset_steps: number }[] }).legs.map((l) => l.offset_steps)).toEqual([0, -2]); // buy ATM put, sell the put two listed strikes below
  });
});
