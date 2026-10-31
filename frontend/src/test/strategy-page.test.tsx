import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TEMPLATE_BIAS, TEMPLATES } from "../lib/strategy";
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-29"] }, "/api/snapshots": [summary()], "/api/option-chain": chain,
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
const pick = async (id: string) => {
  const t = TEMPLATES.find((x) => x.id === id)!;
  await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS[id]! }));
  await userEvent.click(await screen.findByRole("button", { name: t.label }));
};
const loaded = () => waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 5000 });

describe("Strategy builder page", () => {
  it("shows the instrument, the stored chain's lot size and never hard-codes one", async () => {
    mount();
    expect(await screen.findByText("NIFTY 50")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle(/instrument data in the stored chain/)).toHaveTextContent("75"), { timeout: 5000 }); // the fixture's lot size, not a built-in number
  });

  it("a long straddle template fills editable legs and shows hand-calculated risk (premium 100 + 100, lot 75)", async () => {
    mount();
    await loaded();
    await pick("long_straddle");
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(table).getAllByLabelText("Strike")).toHaveLength(2);
    const stats = await screen.findByTestId("risk-stats");
    expect(stats).toHaveTextContent("Max loss−₹15,000"); // 200 x 75
    expect(stats).toHaveTextContent("Max profitUnlimited");
    expect(stats).toHaveTextContent("23,850 · 24,250"); // 24050 -/+ 200
    expect(stats).toHaveTextContent("−₹15,000 debit");
    expect(screen.getByRole("img", { name: "Strategy payoff" }).getAttribute("data-series")).toMatch(/Profit\|Loss.*Markers/);
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

  it("saves a strategy by name and loads it back", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("bull_call_spread");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "my spread");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "New strategy" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId("saved-menu")).getByText(/my spread/));
    expect(within(await screen.findByRole("table", { name: "Strategy legs" })).getAllByLabelText("Strike")).toHaveLength(2);
  });
});

describe("Payoff chart zoom", () => {
  it("opens on the profit zone, narrows with the + button around its centre, widens with − and fits again; no wheel zoom", async () => {
    mount();
    await loaded();
    await pick("short_straddle");
    const range = async () => { const t = (await screen.findByTestId("zoom-range")).textContent ?? ""; const [lo, hi] = t.replace(/,/g, "").split("–").map((x) => Number(x.trim())); return { lo: lo!, hi: hi! }; };
    const r0 = await range();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const r1 = await range();
    expect(r1.hi - r1.lo).toBeLessThan(r0.hi - r0.lo);
    expect((r1.lo + r1.hi) / 2).toBeCloseTo((r0.lo + r0.hi) / 2, -2); // same centre
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect((await range()).hi - (await range()).lo).toBeCloseTo(r0.hi - r0.lo, -1);
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Fit profit zone" }));
    expect(await range()).toEqual(r0);
  });
});

describe("Reset and New work independently", () => {
  it("Reset undoes edits but keeps the strategy; New clears it; each is disabled when it has nothing to do", async () => {
    mount();
    await loaded();
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New strategy" })).toBeDisabled();
    await pick("bull_call_spread");
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeDisabled(); // just built: nothing to undo
    expect(screen.getByRole("button", { name: "New strategy" })).toBeEnabled();
    const table = () => within(screen.getByRole("table", { name: "Strategy legs" }));
    await userEvent.click(table().getAllByLabelText("Increase lots")[0]!);
    expect((table().getAllByLabelText("Lots")[0] as HTMLInputElement).value).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "Reset strategy" }));
    expect((table().getAllByLabelText("Lots")[0] as HTMLInputElement).value).toBe("1"); // edit undone, legs still there
    expect(table().getAllByLabelText("Strike")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "New strategy" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New strategy" })).toBeDisabled();
  });
});

describe("Updating a saved strategy", () => {
  it("shows Update only for a loaded saved strategy, flags unsaved changes and overwrites the same entry", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("bull_call_spread");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "adjust me");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const update = await screen.findByTestId("update-saved");
    expect(update).toHaveTextContent("Update");
    expect(update).toBeDisabled();
    await userEvent.type(screen.getAllByLabelText("Stop percent of entry premium")[0]!, "30");
    expect(update).toBeEnabled();
    expect(update).toHaveTextContent("●"); // unsaved changes
    await userEvent.click(update);
    expect(update).toBeDisabled();
    expect(within(screen.getByTestId("saved-menu")).getAllByText(/adjust me/)).toHaveLength(1); // same entry, no copy
    const stored = JSON.parse(localStorage.getItem("nse.strategies.v1") ?? "[]") as { legs: { stop?: number | null }[] }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.legs.some((l) => l.stop != null)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "New strategy" }));
    expect(screen.queryByTestId("update-saved")).not.toBeInTheDocument();
  });
});

describe("Strategies kept on the server", () => {
  const sv = (name: string) => ({ name, savedAt: "2026-10-30T04:00:00Z", expiry: "2026-11-03", legs: [] });
  function serverFake(initial: unknown[]) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    let saved = [...initial] as { name: string }[];
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/strategies")) return base(input, init);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/strategies/import") {
        const add = Object.values(body.saved) as { name: string }[];
        saved = [...saved, ...add];
        return new Response(JSON.stringify({ added: add.length }), { status: 200 });
      }
      if (method === "DELETE") { saved = saved.filter((x) => `/api/strategies/saved?key=${encodeURIComponent(x.name)}` !== url); return new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200 }); }
      if (method === "PUT") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ saved, closed: [] }), { status: 200 });
    }));
    return calls;
  }

  it("lists what the server holds, moves browser-only strategies up once, and sends deletes to the server", async () => {
    localStorage.setItem("nse.strategies.v1", JSON.stringify([sv("only here")]));
    const calls = serverFake([sv("on server")]);
    mount();
    const menu = await screen.findByTestId("saved-menu");
    await waitFor(() => expect(menu).toHaveTextContent("Saved (2)"));
    expect(screen.getByTestId("sync-state")).toHaveTextContent("Stored on server");
    const imp = calls.find((c) => c.url === "/api/strategies/import")!;
    expect(Object.keys((imp.body as { saved: object }).saved)).toEqual(["only here"]); // not the one the server already had
    await userEvent.click(within(menu).getByRole("button", { name: "Delete saved strategy on server" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/strategies/saved?key=on%20server")).toBe(true));
    expect(menu).toHaveTextContent("Saved (1)");
  });

  it("saving and updating write to the server; an unreachable server is shown, not hidden", async () => {
    const calls = serverFake([]);
    mount();
    await waitFor(() => expect(screen.getByTestId("sync-state")).toHaveTextContent("Stored on server"));
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick("bull_call_spread");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "persist me");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/saved" && (c.body as { key: string }).key === "persist me")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as { doc: { name: string; legs: unknown[] } };
    expect(put.doc.name).toBe("persist me");
    expect(put.doc.legs).toHaveLength(2);
  });
});

describe("Option chain inside the builder", () => {
  it("offers only the weekly and monthly expiries we collect, however many dates the exchange lists", async () => {
    mount();
    const w = await screen.findByRole("button", { name: /03 Nov.*weekly/ });
    expect(w).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /24 Nov.*monthly/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /10 Nov|17 Nov|29 Dec/ })).toBeNull();
  });

  const row = (k: number) => screen.findByTestId(`chain-${k}`);
  const legTable = () => screen.findByRole("table", { name: "Strategy legs" });

  it("lists the stored chain with the ATM highlighted and quotes missing as dashes", async () => {
    mount();
    const atm = await row(24050);
    expect(atm).toHaveTextContent("24,050");
    expect(atm).toHaveTextContent("100.00"); // stored last traded price, not a made-up number
    expect(within(await row(24000)).getAllByText("—").length).toBeGreaterThan(0); // no call price stored for 24000
  });

  it("clicking B or S adds a leg priced at the stored quote; clicking again adds a lot", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    const t = await legTable();
    expect((within(t).getByLabelText("Entry premium") as HTMLInputElement).value).toBe("100");
    expect(within(t).getByText("stored quote")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Buy CE 24100" }));
    expect((within(t).getByLabelText("Lots") as HTMLInputElement).value).toBe("2"); // same leg, one more lot
    await userEvent.click(screen.getByRole("button", { name: "Sell PE 24000" }));
    expect(within(t).getAllByLabelText("Action").map((x) => (x as HTMLSelectElement).value)).toEqual(["BUY", "SELL"]);
    expect(screen.getByRole("button", { name: "Buy CE 24100" })).toHaveTextContent("B 2"); // the chain shows what is held
  });

  it("a contract without a stored quote is added with the premium left for you to enter", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24000" })); // the fixture has no call price at 24000
    const t = await legTable();
    expect((within(t).getByLabelText("Entry premium") as HTMLInputElement).value).toBe("");
    expect(within(t).getByText("missing")).toBeInTheDocument();
    expect(screen.getByTestId("payoff-empty")).toHaveTextContent("Enter the entry premium of every leg.");
    await userEvent.type(within(t).getByLabelText("Entry premium"), "90");
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("Max loss−₹6,750"); // 90 x 75
  });

  it("a hand-built bull call spread from the chain gives the hand-calculated payoff (buy 24000 call @90, sell 24100 call @100)", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24000" }));
    await userEvent.type(within(await legTable()).getByLabelText("Entry premium"), "130");
    await userEvent.click(screen.getByRole("button", { name: "Sell CE 24100" })); // stored price 100
    const stats = await screen.findByTestId("risk-stats");
    // net debit 30 per unit: max loss 30 x 75 = 2,250; width 100 so max profit (100 - 30) x 75 = 5,250; breakeven 24,030
    expect(stats).toHaveTextContent("Max loss−₹2,250");
    expect(stats).toHaveTextContent("Max profit+₹5,250");
    expect(stats).toHaveTextContent("24,030");
    expect(stats).toHaveTextContent("−₹2,250 debit");
  });

  it("the strikes shown can be narrowed", async () => {
    mount();
    await row(24050);
    await userEvent.click(screen.getByRole("button", { name: "±5" }));
    expect(screen.getAllByTestId(/^chain-/).length).toBeLessThanOrEqual(7);
  });

  it("changing the expiry clears the legs and says so", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: /24 Nov.*monthly/ }));
    expect(await screen.findByTestId("template-msg")).toHaveTextContent("The legs were cleared because the expiry changed.");
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
  });
});

describe("StockMojo-style layout", () => {
  it("shows a gallery of ready-made strategies by outlook when there are no legs", async () => {
    mount();
    await loaded();
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    for (const b of ["Bullish", "Bearish", "Neutral", "Other"]) expect(screen.getByRole("tab", { name: b })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iron Condor/i })).toBeInTheDocument();
  });

  it("the multiplier scales lots and total P&L and an unticked leg drops out of the payoff", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    await userEvent.type(within(await screen.findByRole("table", { name: "Strategy legs" })).getByLabelText("Entry premium"), "{backspace}{backspace}{backspace}90");
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("Max loss−₹6,750"); // 90 x 75
    await userEvent.click(screen.getByRole("button", { name: "Increase multiplier" }));
    expect(screen.getByTestId("mult")).toHaveTextContent("2");
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("Max loss−₹13,500");
    await userEvent.click(screen.getByLabelText("Include leg"));
    expect(await screen.findByTestId("payoff-empty")).toHaveTextContent("Tick at least one leg.");
  });

  it("the Greeks tab lists model values per leg and says they are model values", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Greeks" }));
    expect(await screen.findByTestId("greeks")).toHaveTextContent("Black-76 model values");
  });
});

describe("Target and stop-loss per leg", () => {
  it("a bought call at 100: 50% target and 30% stop give hand-calculated exit P&L and totals", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" })); // stored price 100, lot 75
    await userEvent.type(await screen.findByLabelText("Target percent of entry premium"), "50"); // 150 -> +50 x 75
    await userEvent.type(screen.getByLabelText("Stop percent of entry premium"), "30"); // 70 -> -30 x 75
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("If targets hit+₹3,750");
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("If stops hit−₹2,250");
    expect((screen.getByLabelText("Target premium") as HTMLInputElement).value).toBe("150");
    expect((screen.getByLabelText("Stop-loss premium") as HTMLInputElement).value).toBe("70");
  });

  it("a target on the wrong side of the entry is flagged, and for a seller the sides swap", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" })); // entry 100
    await userEvent.type(await screen.findByLabelText("Target percent of entry premium"), "50"); // seller target is below: 50
    expect((screen.getByLabelText("Target premium") as HTMLInputElement).value).toBe("50");
    await userEvent.type(screen.getByLabelText("Stop percent of entry premium"), "30"); // seller stop is above: 130
    expect((screen.getByLabelText("Stop-loss premium") as HTMLInputElement).value).toBe("130");
    await userEvent.clear(screen.getByLabelText("Target premium"));
    await userEvent.type(screen.getByLabelText("Target premium"), "120");
    expect(await screen.findByText("Target must be below the entry.")).toBeInTheDocument();
  });
});

describe("What-if, scenarios and model inputs", () => {
  it("the NIFTY what-if slider reports an exact expiry P&L at the chosen level (long 24100 call at 100, lot 75)", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    const slider = await screen.findByLabelText("NIFTY what-if");
    fireEvent.change(slider, { target: { value: "2" } }); // 24050 x 1.02 = 24531
    const out = await screen.findByTestId("whatif-readout");
    // exact: (24531 - 24100 - 100) x 75
    expect(out).toHaveTextContent("if held to expiry +₹24,825");
    expect(out).toHaveTextContent("(model)");
  });

  it("the Scenarios tab shows sigma rows with an exact expiry column", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Scenarios" }));
    const t = await screen.findByRole("table", { name: "Scenario P&L" });
    expect(t).toHaveTextContent("Expiry (exact)");
    expect(within(t).getAllByRole("row")).toHaveLength(8); // header + 7 sigma rows
    expect(t).toHaveTextContent("-2σ");
    expect(t).toHaveTextContent("+2σ");
  });

  it("says where the forward and the volatilities come from, never silently", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    const m = await screen.findByTestId("model-inputs");
    expect(m).toHaveTextContent("Forward:");
    expect(m).toHaveTextContent("Volatility:");
  });
});

describe("Greeks in the chain, highlighted legs and steppers", () => {
  it("rows that hold a leg are highlighted and tagged after a ready-made strategy, without hovering", async () => {
    mount();
    await loaded();
    await pick("long_straddle");
    const held = (await screen.findAllByTestId(/^held-/)).length;
    expect(held).toBeGreaterThanOrEqual(2); // a call tag and a put tag at the straddle strike
    const rows = screen.getAllByTestId(/^chain-/).filter((r) => r.getAttribute("data-held") === "true");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveTextContent("+1 lot");
  });

  it("every Greek can be shown as a chain column and is a number or a dash, never a made-up zero", async () => {
    mount();
    await loaded();
    const group = screen.getByRole("group", { name: "Greeks columns" });
    for (const k of ["Γ", "Θ", "Vega"]) await userEvent.click(within(group).getByLabelText(k));
    const head = within(screen.getByRole("table", { name: "Option chain" })).getAllByRole("columnheader").map((h) => h.textContent);
    for (const k of ["Δ", "Γ", "Θ", "Vega", "IV"]) expect(head).toContain(k);
    const atm = await screen.findByTestId("chain-24050");
    expect(within(atm).getAllByRole("cell").length).toBeGreaterThan(10);
  });

  it("lots and strike have steppers", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Increase lots" }));
    expect((screen.getByLabelText("Lots") as HTMLInputElement).value).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "Decrease lots" }));
    expect((screen.getByLabelText("Lots") as HTMLInputElement).value).toBe("1");
    expect(screen.getByRole("button", { name: "Decrease lots" })).toBeDisabled(); // never below one lot
    const before = Number((screen.getByLabelText("Strike") as HTMLSelectElement).value);
    await userEvent.click(screen.getByRole("button", { name: "Next strike" }));
    expect(Number((screen.getByLabelText("Strike") as HTMLSelectElement).value)).toBeGreaterThan(before);
    await userEvent.click(screen.getByRole("button", { name: "Previous strike" }));
    expect(Number((screen.getByLabelText("Strike") as HTMLSelectElement).value)).toBe(before);
  });

  it("the strategy-analysis panel is gone", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    expect(screen.queryByTestId("insights")).toBeNull();
  });
});

describe("Plus and minus on a held strike", () => {
  it("+ adds a lot in the held direction, - removes one and drops the leg with its last lot", async () => {
    mount();
    await loaded();
    expect(screen.queryByRole("button", { name: "Add one lot CE 24100" })).toBeNull(); // nothing held, no stepper
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Add one lot CE 24100" }));
    expect((screen.getByLabelText("Lots") as HTMLInputElement).value).toBe("2");
    expect(screen.getByTestId("held-24100")).toHaveTextContent("−2 lots");
    await userEvent.click(screen.getByRole("button", { name: "Remove one lot CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove one lot CE 24100" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument(); // the last lot took the leg with it
  });
});

describe("Exit all and closed strategies", () => {
  it("exit all closes every leg at its stored price, saves the realised P&L and clearing the builder; the closed trade can be reopened", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" })); // entry 100, stored 100
    await userEvent.clear(screen.getByLabelText("Entry premium"));
    await userEvent.type(screen.getByLabelText("Entry premium"), "130"); // sold at 130, stored LTP 100: +30 x 75
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    const menu = screen.getByTestId("closed-menu");
    expect(menu).toHaveTextContent("Closed (1)");
    expect(menu).toHaveTextContent("Realised +₹2,250");
    await userEvent.click(within(menu).getByText(/Realised/));
    expect(await screen.findByTestId("opened-closed")).toHaveTextContent("S 24100CE 130 → 100");
    expect(screen.getByRole("table", { name: "Strategy legs" })).toBeInTheDocument();
  });

  it("will not exit a leg that has no stored price: missing stays missing", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24000" })); // the fixture has no call price at 24000
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    expect(await screen.findByTestId("template-msg")).toHaveTextContent("Cannot exit");
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (0)");
  });
});

describe("Deleting saved and closed strategies", () => {
  it("deletes one saved strategy with its cross, and all of them only after a second click", async () => {
    mount();
    await loaded();
    await pick("bull_call_spread");
    for (const n of ["one", "two"]) {
      await userEvent.clear(screen.getByLabelText("Strategy name"));
      await userEvent.type(screen.getByLabelText("Strategy name"), n);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
    }
    const menu = screen.getByTestId("saved-menu");
    expect(menu).toHaveTextContent("Saved (2)");
    await userEvent.click(within(menu).getByRole("button", { name: "Delete saved strategy one" }));
    expect(menu).toHaveTextContent("Saved (1)");
    await userEvent.click(within(menu).getByText("Delete all saved"));
    expect(menu).toHaveTextContent("Saved (1)"); // one click is not enough
    await userEvent.click(within(menu).getByText("Click again to delete all saved strategies"));
    expect(menu).toHaveTextContent("Saved (0)");
  });

  it("deletes a closed trade", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    const menu = await screen.findByTestId("closed-menu");
    expect(menu).toHaveTextContent("Closed (1)");
    await userEvent.click(within(menu).getByRole("button", { name: /Delete closed trade/ }));
    expect(menu).toHaveTextContent("Closed (0)");
  });
});


describe("Typing a percentage for a target or stop", () => {
  it("keeps what you type (70, 7.5) even when the price it sets is rounded to the 0.05 tick", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    const entry = screen.getByLabelText("Entry premium");
    await userEvent.clear(entry);
    await userEvent.type(entry, "3.5");
    const pct = screen.getByLabelText("Stop percent of entry premium") as HTMLInputElement;
    await userEvent.type(pct, "70"); // seller stop: 3.5 x 1.7 = 5.95
    expect(pct.value).toBe("70");
    expect((screen.getByLabelText("Stop-loss premium") as HTMLInputElement).value).toBe("5.95");
    await userEvent.clear(pct);
    await userEvent.type(pct, "7.5"); // 3.5 x 1.075 = 3.7625 -> 3.75
    expect(pct.value).toBe("7.5");
    expect((screen.getByLabelText("Stop-loss premium") as HTMLInputElement).value).toBe("3.75");
  });
});

describe("Target and stop status against the market price", () => {
  it("a bought call (entry 100) with a target of 90 and a stop of 120 is flagged hit/away, and a sold one is the mirror image", async () => {
    const { hitOf } = await import("../lib/strategy");
    expect(hitOf({ action: "BUY", target: 150, stop: 70 }, "target", 150)).toBe(true);
    expect(hitOf({ action: "BUY", target: 150, stop: 70 }, "target", 149.95)).toBe(false);
    expect(hitOf({ action: "BUY", target: 150, stop: 70 }, "stop", 70)).toBe(true);
    expect(hitOf({ action: "BUY", target: 150, stop: 70 }, "stop", 71)).toBe(false);
    expect(hitOf({ action: "SELL", target: 50, stop: 130 }, "target", 50)).toBe(true); // a seller wins when the premium falls
    expect(hitOf({ action: "SELL", target: 50, stop: 130 }, "stop", 130)).toBe(true); // and is stopped out when it rises
    expect(hitOf({ action: "SELL", target: 50, stop: 130 }, "stop", 129)).toBe(false);
    expect(hitOf({ action: "SELL" }, "stop", 999)).toBe(false); // nothing set: never hit
  });

  it("shows the banner and the badge when the stored price has passed the stop, and the distance when it has not", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" })); // entry 100
    await userEvent.type(await screen.findByLabelText("Stop percent of entry premium"), "30"); // stop at 130, price 100: not hit
    expect(await screen.findByTestId("stop-away")).toHaveTextContent("30.00 away");
    expect(screen.queryByTestId("hit-banner")).not.toBeInTheDocument();
    // a sold call entered at 150 with a target of 120: the stored price (100) is already below the target
    const entry = screen.getByLabelText("Entry premium");
    await userEvent.clear(entry);
    await userEvent.type(entry, "150");
    await userEvent.type(screen.getByLabelText("Target premium"), "120");
    expect(await screen.findByTestId("target-hit")).toHaveTextContent("Target hit");
    expect(screen.getByTestId("hit-banner")).toHaveTextContent("Target reached on SELL 24,100 CE");
  });
});
