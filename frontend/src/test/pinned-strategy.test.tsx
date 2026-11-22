// The running strategy pinned on the Home page under the market summary: its P&L from the server and its mark-to-market chart.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../pages/Home";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const leg = (o: object) => ({ id: "a", expiry: "2026-11-24", strike: 25800, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", key: "k1", enteredAt: "2026-11-20T03:50:00.000Z", ...o });
const pnl = (o: object = {}) => ({ at: "2026-11-23T05:00:00Z", running: true, live: true, name: "short straddle", booked: 0, open: 650, total: 650, missing: [], ...o });
const run = (legs: object[], mult = 1) => ({ doc: { rev: 3, auto: true, lotSize: 65, mult, expiry: "2026-11-24", name: "short straddle", loaded: "short straddle", legs }, checking: { live: true, last_check_at: null, error: null } });

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    return routes[url] === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(routes[url]), { status: 200 });
  }));
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Home /></MemoryRouter></QueryClientProvider>);
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("running strategy pinned on Home", () => {
  it("shows the strategy, its P&L from the server and the MTM chart area, under the market summary", async () => {
    stub({ "/api/strategies/running": run([leg({}), leg({ id: "b", type: "PE", key: "k2" })]), "/api/strategies/running/pnl": pnl() });
    mount();
    const card = await screen.findByTestId("pinned-strategy");
    expect(within(card).getByText(/Running strategy · short straddle/)).toBeInTheDocument();
    expect(within(card).getByTestId("pinned-pnl")).toHaveTextContent("+₹650");
    expect(within(card).getByTestId("pinned-split")).toHaveTextContent("booked ₹0 · open +₹650");
    expect(within(card).getByTestId("pinned-legs")).toHaveTextContent("2 open legs: −1× 25800 CE, −1× 25800 PE");
    expect(within(card).getByRole("link", { name: /Open in the Strategy Builder/ })).toHaveAttribute("href", "/strategy");
    // below the market summary (its unavailable note here) and above the rest of the page
    const intel = await screen.findByTestId("home-no-intel");
    expect(intel.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a loss is red and says so; a missing live price shows no number and names the leg", async () => {
    stub({ "/api/strategies/running": run([leg({})]), "/api/strategies/running/pnl": pnl({ total: -1300, open: -1300 }) });
    mount();
    expect(await screen.findByTestId("pinned-pnl")).toHaveTextContent("−₹1,300");
    expect(screen.getByTestId("pinned-pnl").className).toContain("text-down");
  });
  it("no live price: no total, and the leg that lacks it is named instead of a guess", async () => {
    stub({ "/api/strategies/running": run([leg({})]), "/api/strategies/running/pnl": pnl({ total: null, open: null, missing: ["NIFTY future"] }) });
    mount();
    expect(await screen.findByTestId("pinned-pnl")).toHaveTextContent("—");
    expect(screen.getByTestId("pinned-split")).toHaveTextContent("no live price for NIFTY future");
  });
  it("outside the session it says the prices are the last ones", async () => {
    stub({ "/api/strategies/running": run([leg({})]), "/api/strategies/running/pnl": pnl({ live: false }) });
    mount();
    expect(await screen.findByTestId("pinned-split")).toHaveTextContent("market closed: last prices");
  });
  it("is not there when nothing is running (everything closed, or no strategy)", async () => {
    stub({ "/api/strategies/running": run([leg({ exitPrice: 90, realised: 650 })]), "/api/strategies/running/pnl": pnl({ running: false }) });
    mount();
    await screen.findByTestId("home-no-intel");
    expect(screen.queryByTestId("pinned-strategy")).toBeNull();
  });
});
