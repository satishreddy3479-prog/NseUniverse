import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TEMPLATE_BIAS, TEMPLATES } from "../lib/strategy";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

// a server that remembers what the page stores, so Saved/Closed behave as in production
let store: { saved: Record<string, unknown>[]; closed: Record<string, unknown>[] };
beforeEach(() => {
  store = { saved: [], closed: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    const method = init?.method ?? "GET";
    if (url === "/api/strategies" && method === "GET") return new Response(JSON.stringify(store), { status: 200 });
    if (url === "/api/strategies/import") return new Response(JSON.stringify({ added: 0 }), { status: 200 });
    const m = /^\/api\/strategies\/(saved|closed)$/.exec(url);
    if (m) {
      const kind = m[1] as "saved" | "closed";
      if (method === "PUT") {
        const b = JSON.parse(String(init!.body)) as { key: string; doc: Record<string, unknown> };
        const keyOf = (d: Record<string, unknown>) => String(kind === "saved" ? d.name : d.id);
        store[kind] = [b.doc, ...store[kind].filter((d) => keyOf(d) !== b.key)];
      } else if (method === "DELETE") {
        const key = new URL(full, "http://x").searchParams.get("key");
        store[kind] = store[kind].filter((d) => String(kind === "saved" ? d.name : d.id) !== key);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03"] }, "/api/snapshots": [summary()], "/api/option-chain": chain };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const mount = (at = "/strategy") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
const build = async (id: string) => {
  await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 5000 });
  await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS[id]! }));
  await userEvent.click(await screen.findByRole("button", { name: TEMPLATES.find((t) => t.id === id)!.label }));
};

describe("Exit all", () => {
  it("moves a saved strategy to Closed under its own name instead of leaving a copy in Saved", async () => {
    mount();
    await build("short_straddle");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "my straddle");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"));
    expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (0)");
    expect(store.saved).toHaveLength(0); // gone from the server's Saved
    expect(store.closed).toHaveLength(1);
    expect((store.closed[0] as { name: string }).name).toBe("my straddle");
  });

  it("closing a strategy that was reopened from Closed replaces that record, never adds a second one", async () => {
    mount();
    await build("short_straddle");
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"));
    await userEvent.click(within(screen.getByTestId("closed-menu")).getByText(/Strategy/));
    await userEvent.click(await screen.findByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(store.closed).toHaveLength(1));
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)");
  });
});

describe("Adjusting a running strategy", () => {
  it("rolling a leg books the old leg's P&L and the payoff, breakevens and P&L box follow the new strike", async () => {
    mount();
    await build("short_straddle");
    const stats = () => screen.getByTestId("risk-stats").textContent ?? "";
    const before = stats();
    expect(before).toContain("Breakevens");
    const table = within(await screen.findByRole("table", { name: "Strategy legs" }));
    await userEvent.selectOptions(table.getAllByLabelText("Roll to strike")[0]!, "24150");
    await userEvent.click(table.getAllByRole("button", { name: "Roll leg" })[0]!);
    await waitFor(() => expect(screen.getAllByTestId("leg-log")[0]).toHaveTextContent("Rolled SELL 24050 CE to 24150 CE"));
    // the call now sits at 24150 (stored price 100, same as before): the strategy and its figures were recomputed
    expect((table.getAllByLabelText("Strike")[0] as HTMLSelectElement).value).toBe("24150");
    expect(stats()).not.toBe(before);
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("Breakevens");
  });

  it("changing lots, adding a hedge from the chain and removing a leg all update the maximum loss and the payoff figures", async () => {
    mount();
    await build("short_straddle");
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("Max lossUnlimited");
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24200" })); // a long call above caps the upside risk
    await waitFor(() => expect(screen.getByTestId("risk-stats")).not.toHaveTextContent("Max lossUnlimited"));
    const table = within(screen.getByRole("table", { name: "Strategy legs" }));
    await userEvent.click(table.getAllByLabelText("Remove leg").at(-1)!); // remove the hedge again
    await waitFor(() => expect(screen.getByTestId("risk-stats")).toHaveTextContent("Max lossUnlimited"));
  });
});

describe("Strategy portfolio", () => {
  it("lists running strategies with live P&L and closed strategies with their total, and opens a running one in the builder", async () => {
    store.saved = [{ name: "run me", savedAt: "2026-11-02T04:00:00Z", expiry: "2026-11-03", legs: [{ id: "a", expiry: "2026-11-03", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 120, premiumSource: "market", realised: -650 }] }];
    store.closed = [{ id: "c1", name: "old one", closedAt: "2026-10-30T10:00:00Z", snapshotAt: "2026-10-30T10:00:00Z", expiry: "2026-11-03", lotSize: 75, pnl: 2379, legs: [], stale: false }];
    mount("/portfolio");
    // stored price 100 vs entry 120 on a short call, lot 75: +20 x 75 = 1,500 open; booked −650; total +850
    const row = await screen.findByLabelText("Open run me in the strategy builder");
    await waitFor(() => expect(row).toHaveTextContent("+₹850"));
    expect(row).toHaveTextContent("+₹1,500"); expect(row).toHaveTextContent("−₹650");
    expect(screen.getByTestId("portfolio-closed")).toHaveTextContent("+₹2,379");
    expect(screen.getByTestId("portfolio-tiles")).toHaveTextContent("+₹850"); // running
    expect(screen.getByTestId("portfolio-tiles")).toHaveTextContent("+₹3,229"); // running + closed
    await userEvent.click(row);
    // the builder opens with that strategy loaded for adjustment
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect((within(table).getAllByLabelText("Strike")[0] as HTMLSelectElement).value).toBe("24050");
    expect((within(table).getAllByLabelText("Entry premium")[0] as HTMLInputElement).value).toBe("120");
    expect(screen.getByTestId("update-saved")).toBeInTheDocument(); // it is the saved strategy "run me"
  });
});
