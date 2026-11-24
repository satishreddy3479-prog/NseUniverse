import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { liveStore } from "../lib/liveStore";
import { TEMPLATE_BIAS, TEMPLATES } from "../lib/strategy";
import { bigChain, expiries, liveTick, status, streamStatus, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return {
    ...actual,
    EChart: ({ option, ariaLabel }: { option: { series?: { name?: string }[] }; ariaLabel: string }) => (
      <div role="img" aria-label={ariaLabel} data-series={(option.series ?? []).map((s) => s.name).join("|")} />
    ),
  };
});

// the NIFTY future of the chart's expiry (3 Nov 2026) at 24 060, next month 29 Dec at 24 150
const NOW = "2026-11-02T05:00:00.000Z";
const FUT = {
  current: { role: "current", symbol: "NIFTY26NOVFUT", key: "nse_fo|99", expiry: "2026-11-03", ltp: 24060, as_of: NOW, fresh: true, note: null },
  next: { role: "next", symbol: "NIFTY26DECFUT", key: "nse_fo|98", expiry: "2026-12-29", ltp: 24150, as_of: NOW, fresh: true, note: null },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T05:00:00Z")); // the fixtures expire on 3 Nov 2026
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/futures/contracts": FUT, "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-29"] }, "/api/snapshots": [summary()], "/api/option-chain": chain, "/api/option-chain/on-demand": { ...chain, snapshot: { ...chain.snapshot, expiry: "2026-12-29" } },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); liveStore.reset(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/strategy"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
const pick = async (id: string) => {
  const t = TEMPLATES.find((x) => x.id === id)!;
  await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS[id]! }));
  await userEvent.click(await screen.findByRole("button", { name: t.label }));
};
const loaded = () => waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 15000 });

describe("NIFTY future in the Strategy builder", () => {
  it("shows the contract and its live price, and adds a sold future at that price", async () => {
    mount();
    await loaded();
    expect(await screen.findByTestId("future-quote")).toHaveTextContent("NIFTY26NOVFUT · expires 03 Nov · 24,060");
    await userEvent.click(screen.getByRole("button", { name: "Sell future" }));
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    const row = within(table).getByTestId(/^leg-future-/);
    expect(row).toHaveTextContent("NIFTY future");
    expect(row).toHaveTextContent("NIFTY26NOVFUT");
    expect(within(table).getByLabelText("Entry premium")).toHaveValue(24060);
    expect(within(table).queryByLabelText("Strike")).toBeNull(); // a future has no strike to pick
  });

  it("the future's price follows the stream tick by tick, like the index, between the 5-second polls of the contract", async () => {
    mount();
    await loaded();
    expect(await screen.findByTestId("future-quote")).toHaveTextContent("24,060"); // the polled quote
    act(() => {
      liveStore.setConn("open");
      liveStore.apply({
        type: "hello", status: streamStatus({ state: "streaming", effective_state: "streaming" }),
        ticks: [liveTick({ key: "nse_fo|99", kind: "scrip", ltp: 24071.5, received_at: "2026-11-02T05:00:01.000Z", seq: 1 })],
      });
    });
    await waitFor(() => expect(screen.getByTestId("future-quote")).toHaveTextContent("24,071.50"));
    act(() => { liveStore.apply({ type: "ticks", ticks: [liveTick({ key: "nse_fo|99", kind: "scrip", ltp: 24073.0, received_at: "2026-11-02T05:00:02.000Z", seq: 2 })] }); });
    await waitFor(() => expect(screen.getByTestId("future-quote")).toHaveTextContent("24,073.00"));
    // a future added now enters at the live price, not the polled one
    await userEvent.click(screen.getByRole("button", { name: "Buy future" }));
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(table).getByLabelText("Entry premium")).toHaveValue(24073);
  });

  it("a delta-hedged straddle: short future 24060 + long 24050 straddle (100 + 100), lot 75, hand-calculated payoff", async () => {
    mount();
    await loaded();
    await pick("long_straddle");
    await userEvent.click(await screen.findByRole("button", { name: "Sell future" }));
    const stats = await screen.findByTestId("risk-stats");
    // above 24050: (S-24050-200)*75 + (24060-S)*75 = -190 * 75; the call's gain cancels the short future's loss
    await waitFor(() => expect(stats).toHaveTextContent("Max loss−₹14,250"));
    expect(stats).not.toHaveTextContent("Max profitUnlimited"); // slope above the strike is +1 -1 = 0
    expect(stats).toHaveTextContent("23,955"); // below 24050: 47910 - 2S = 0
    expect(stats).toHaveTextContent("−₹15,000 debit"); // net premium counts the options only: the future has no premium
  });

  it("rolls the future into the next month: the old contract's P&L is booked and the leg moves to the 29 Dec contract", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy future" }));
    await userEvent.click(await screen.findByRole("button", { name: "Roll future to next month" }));
    const row = await screen.findByTestId(/^leg-future-/);
    expect(row).toHaveTextContent("NIFTY26DECFUT");
    expect(within(await screen.findByRole("table", { name: "Strategy legs" })).getByLabelText("Entry premium")).toHaveValue(24150);
  });

  it("the MTM tab opens for a strategy with a future and says what is missing instead of drawing nothing", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy future" }));
    await userEvent.click(await screen.findByRole("button", { name: "MTM" }));
    const msg = await screen.findByTestId(/^mtm-/, undefined, { timeout: 10000 });
    expect(msg.textContent ?? "").not.toBe(""); // the stored one-minute prices are not part of this fixture: the tab explains it
  });

  it("the Scenarios tab carries the surface what-if for the strategy, and says the future is included", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell future" }));
    await userEvent.click(await screen.findByRole("button", { name: "Scenarios" }));
    const box = await screen.findByTestId("builder-whatif", undefined, { timeout: 10000 });
    expect(box).toHaveTextContent("What-if on the volatility surface");
    expect(within(box).getByTestId("whatif-futures-note")).toHaveTextContent("−₹75 per index point"); // one sold lot of 75 in this fixture
  });

  it("with no contract resolved the buttons are off and nothing is invented", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/api/futures/contracts") ? new Response("{}", { status: 503 }) : new Response("{}", { status: 404 }))));
    mount();
    expect(await screen.findByRole("button", { name: "Buy future" })).toBeDisabled();
  });
});
