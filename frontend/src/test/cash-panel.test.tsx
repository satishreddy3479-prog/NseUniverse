import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CashPanel } from "../components/CashPanel";

vi.mock("../components/FlowsUpdate", () => ({ FlowsUpdateLoader: () => null }));
vi.mock("../components/EChart", () => ({ EChart: () => <div />, useChartColors: () => ({ info: "#0af", brass: "#fa0", muted: "#999", rule: "#333", text: "#eee" }) }));

const rows = [
  { session: "2026-11-18", category: "FII", buy: 17913, sell: 12046, net: 5867 },
  { session: "2026-11-18", category: "DII", buy: 0, sell: 0, net: -3160 },
  { session: "2026-11-18", category: "FPI equity (stock exchange route)", buy: 0, sell: 0, net: 5915 },
  { session: "2026-11-17", category: "FII", buy: 19931, sell: 15736, net: 4195 },
];
afterEach(() => vi.unstubAllGlobals());

describe("FII / DII cash panel on a phone", () => {
  it("gives every session a card with the same figures as the table, and a missing one stays a dash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes("cash") ? { rows, window_sessions: 7 } : { cash_gaps: [], coverage: {} }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><CashPanel /></QueryClientProvider>);
    const list = await screen.findByRole("list", { name: "FII DII cash by session" });
    const d18 = within(within(list).getByTestId("cash-card-2026-11-18"));
    expect(d18.getByText("Wed, 18 Nov")).toBeInTheDocument();
    expect(d18.getByText("Total 2,707")).toBeInTheDocument(); // 5,867 - 3,160
    expect(d18.getByText("FII net").nextSibling).toHaveTextContent("5,867");
    expect(d18.getByText("FPI equity (NSDL)").nextSibling).toHaveTextContent("5,915");
    const d17 = within(within(list).getByTestId("cash-card-2026-11-17"));
    expect(d17.getByText("Total —")).toBeInTheDocument(); // no DII row: no total
    expect(d17.getByText("DII net").nextSibling).toHaveTextContent("—");
  });
});
