import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T05:00:00Z")); // the fixtures expire on 3 Nov 2026
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-29"] }, "/api/snapshots": [summary()], "/api/option-chain": chain, "/api/option-chain/on-demand": { ...chain, snapshot: { ...chain.snapshot, expiry: "2026-12-29" } },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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

describe("Strategy builder page", () => {
  it("shows the instrument, the stored chain's lot size and never hard-codes one", async () => {
    mount();
    expect(await screen.findByText("NIFTY 50")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle(/instrument data in the stored chain/)).toHaveTextContent("75"), { timeout: 15000 }); // the fixture's lot size, not a built-in number
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

  it("each leg shows today's high and low from its stored quote, and a missing one stays a dash", async () => {
    mount();
    await loaded();
    await pick("long_straddle");
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    const ranges = within(table).getAllByTestId(/^leg-range-/).map((e) => e.textContent);
    expect(ranges).toHaveLength(2);
    expect(ranges).toContain("H 112.50 · L 91.00"); // the ATM call: high 112.5, low 91 in the stored quote
    expect(ranges).toContain("H — · L —"); // the ATM put's quote carries neither
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
    await userEvent.click(screen.getByRole("button", { name: "Reset strategy" }));
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

describe("Reset clears the page", () => {
  it("Reset removes every leg, checked or unsaved, and shows the default start page; there is no New button; it is disabled when there is nothing to clear", async () => {
    mount();
    await loaded();
    expect(screen.queryByRole("button", { name: "New strategy" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeDisabled();
    await pick("bull_call_spread");
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeEnabled();
    const table = () => within(screen.getByRole("table", { name: "Strategy legs" }));
    await userEvent.click(table().getAllByLabelText("Increase lots")[0]!); // an edit on top of the unsaved legs
    await userEvent.click(screen.getByRole("button", { name: "Reset strategy" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Strategy legs" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset strategy" })).toBeDisabled();
  });
  it("does not delete a saved strategy: it is still in Saved after a Reset", async () => {
    mount();
    await loaded();
    await pick("bull_call_spread");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "keep me");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset strategy" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    expect(within(screen.getByTestId("saved-menu")).getByText(/keep me/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Reset strategy" }));
    expect(screen.queryByTestId("update-saved")).not.toBeInTheDocument();
  });
});

describe("Update for every strategy, one leg or several, saved or not", () => {
  it.each([["short_call", 1], ["bull_call_spread", 2]])("%s (%i leg(s)) has Update before it is saved; Update saves it, and an edited stop then flags unsaved changes", async (id, n) => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await pick(id);
    expect(within(await screen.findByRole("table", { name: "Strategy legs" })).getAllByLabelText("Strike")).toHaveLength(n);
    const update = await screen.findByTestId("update-saved"); // the strategy was never saved: there is still an Update
    expect(update).toBeEnabled();
    await userEvent.click(update); // saves it under a dated name
    const saved = JSON.parse(localStorage.getItem("nse.strategies.v1") ?? "[]") as { name: string; legs: unknown[] }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^Strategy /);
    expect(saved[0]!.legs).toHaveLength(n);
    const again = await screen.findByTestId("update-saved");
    expect(again).toBeDisabled(); // now it matches the saved copy
    await userEvent.type(screen.getAllByLabelText("Stop percent of entry premium")[0]!, "30");
    expect(again).toBeEnabled();
    expect(again).toHaveTextContent("●");
    await userEvent.click(again);
    expect((JSON.parse(localStorage.getItem("nse.strategies.v1") ?? "[]") as { legs: { stop?: number | null }[] }[])[0]!.legs.some((l) => l.stop != null)).toBe(true);
    expect(JSON.parse(localStorage.getItem("nse.strategies.v1") ?? "[]")).toHaveLength(1); // the same entry, no copy
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
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(within(menu).getByRole("button", { name: "Delete saved strategy on server" }));
    expect(ask).toHaveBeenCalled();
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
    // the save the person asked for, not an earlier automatic draft save (which carries no name yet)
    const put = calls.find((c) => c.method === "PUT" && (c.body as { key?: string }).key === "persist me")!.body as { doc: { name: string; legs: unknown[] } };
    expect(put.doc.name).toBe("persist me");
    expect(put.doc.legs).toHaveLength(2);
  });
});

describe("Option chain inside the builder", () => {
  it("offers every listed expiry: the first four as buttons, the rest in a dropdown", async () => {
    mount();
    const w = await screen.findByRole("button", { name: /03 Nov.*weekly/ });
    expect(w).toBeInTheDocument();
    for (const n of [/10 Nov/, /17 Nov/, /24 Nov.*monthly/]) expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    const more = screen.getByRole("combobox", { name: "More expiries" });
    expect(within(more).getByRole("option", { name: /29 Dec/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /29 Dec/ })).toBeNull(); // beyond the first four: in the dropdown only
  });

  it("an expiry the sampler does not collect is fetched on demand, not from the stored chains, and says so", async () => {
    mount();
    await loaded();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "More expiries" }), "2026-12-29");
    expect(await screen.findByTestId("on-demand-note")).toHaveTextContent("not stored");
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/option-chain/on-demand?expiry=2026-12-29"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/option-chain?expiry=2026-12-29"))).toBe(false);
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
    expect(screen.getByRole("button", { name: "Buy CE 24100" })).toHaveTextContent(/Bs*2/); // the chain shows what is held
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

  it("changing the expiry keeps the legs: a strategy can hold legs of several expiries", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: /24 Nov.*monthly/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24100" }));
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(table).getAllByLabelText("Strike")).toHaveLength(2); // the 3 Nov leg stayed, the 24 Nov leg was added
    expect(screen.queryByTestId("gallery")).toBeNull();
    expect(await screen.findByTestId("multi-expiry-tag")).toHaveTextContent("legs on 2 expiries: 03 Nov · 24 Nov");
    // the chain shows only the legs of the expiry being shown: the 24 Nov chain holds the bought call, not the sold one
    expect(within(await screen.findByTestId("chain-24100")).getByText("+1 lot")).toBeInTheDocument();
  });

  it("a calendar spread is built from two expiries and its payoff is read at a chosen expiry, flagged as a model estimate", async () => {
    mount();
    await loaded();
    await pick("calendar_call");
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect(within(table).getAllByLabelText("Strike")).toHaveLength(2);
    expect(await screen.findByTestId("multi-expiry-tag")).toHaveTextContent("legs on 2 expiries");
    const note = await screen.findByTestId("multi-note");
    expect(note).toHaveTextContent("no single expiry payoff");
    expect(note).toHaveTextContent("model estimates"); // the far leg is still alive at the first expiry
    const at = screen.getByRole("group", { name: "Payoff at expiry" });
    expect(within(at).getAllByRole("button")).toHaveLength(2);
    await userEvent.click(within(at).getAllByRole("button")[1]!); // read at the far expiry: every leg has expired
    expect(await screen.findByTestId("multi-note")).toHaveTextContent("Every leg has expired by this date");
  });
});

describe("StockMojo-style layout", () => {
  it("shows a gallery of ready-made strategies by outlook when there are no legs", async () => {
    mount();
    await loaded();
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    for (const b of ["Bullish", "Bearish", "Neutral", "Calendar", "Other"]) expect(screen.getByRole("tab", { name: b })).toBeInTheDocument();
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
    expect(menu).toHaveAttribute("href", "/portfolio#closed"); // closed strategies live on the Strategy portfolio page
    const filed = JSON.parse(localStorage.getItem("nse.closed.v1") ?? "[]") as { id: string; pnl: number }[];
    expect(filed).toHaveLength(1);
    expect(filed[0]!.pnl).toBeCloseTo(2250, 2);
    // the portfolio page hands the record over by id: a fresh builder opens it as a closed trade
    cleanup();
    sessionStorage.setItem("nse.builder.open-closed.v1", filed[0]!.id);
    mount();
    expect(await screen.findByTestId("opened-closed", {}, { timeout: 15000 })).toHaveTextContent("S 24100CE 130 → 100");
    expect(screen.getByRole("table", { name: "Strategy legs" })).toBeInTheDocument();
  });

  it("a closed trade whose every leg was closed on the server opens as a booked result: no max profit in green for a loss, no -1.00 : 1, no 0 % chance, no stale-price warning", async () => {
    // the 17 Nov 2026 trade: short 24050 straddle, the call stopped at 122.05 (entry 60.85), the put closed at 15:20 at 0.60 (entry 51.15); filed before the page knew its exits were booked (stale: true)
    const leg = (type: "CE" | "PE", premium: number, exitPrice: number, realised: number) => ({ id: type, expiry: "2026-11-03", strike: 24050, type, action: "SELL", lots: 1, premium, premiumSource: "market", exitPrice, exitReason: "strategy", exitedAt: "2026-11-02T09:50:00.000Z", realised, reentry: 0, exit: exitPrice });
    const closed = { id: "c1", name: "Straddle score 79", closedAt: "2026-11-02T10:26:00.000Z", snapshotAt: "2026-11-02T10:09:03.000Z", expiry: "2026-11-03", lotSize: 65, pnl: -691.99, stale: true, legs: [leg("CE", 60.85, 122.05, -3978.25), leg("PE", 51.15, 0.6, 3286.25)] };
    localStorage.setItem("nse.closed.v1", JSON.stringify([closed]));
    sessionStorage.setItem("nse.builder.open-closed.v1", "c1");
    mount();
    await loaded();
    const banner = await screen.findByTestId("opened-closed");
    expect(banner).toHaveTextContent("Realised");
    expect(banner).not.toHaveTextContent("stale stored prices"); // every leg has its exit: nothing is marked at a stored price
    const stats = screen.getByTestId("risk-stats");
    expect(stats).toHaveTextContent("Realised P&L (all legs closed)");
    expect(stats).toHaveTextContent(/Max profit—/);
    expect(stats).toHaveTextContent(/Max loss—/);
    expect(stats).not.toHaveTextContent("-1.00");
    expect(stats).not.toHaveTextContent("POP (model estimate)0%");
    expect(await screen.findByRole("img", { name: "Strategy payoff" })).toBeInTheDocument(); // the payoff chart stays for a closed trade
  });

  it("Exit all on the same position twice files one closed record, not two (the page restored the legs after the first click on 18 Nov 2026)", async () => {
    mount();
    await loaded();
    const sellAt130 = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
      await userEvent.clear(screen.getByLabelText("Entry premium"));
      await userEvent.type(screen.getByLabelText("Entry premium"), "130");
    };
    await sellAt130();
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)");
    await sellAt130(); // the same position is back (what the server's copy did) and is exited again
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"); // replaced, not copied
    expect(JSON.parse(localStorage.getItem("nse.closed.v1") ?? "[]")).toHaveLength(1);
    // a different position is a second record
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24150" }));
    await userEvent.clear(screen.getByLabelText("Entry premium"));
    await userEvent.type(screen.getByLabelText("Entry premium"), "130");
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    expect(await screen.findByTestId("gallery")).toBeInTheDocument();
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (2)");
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
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    await userEvent.click(within(menu).getByRole("button", { name: "Delete saved strategy one" }));
    expect(menu).toHaveTextContent("Saved (2)"); // declined: nothing deleted
    await userEvent.click(within(menu).getByRole("button", { name: "Delete saved strategy one" }));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(menu).toHaveTextContent("Saved (1)");
    await userEvent.click(within(menu).getByText("Delete all saved"));
    expect(menu).toHaveTextContent("Saved (1)"); // one click is not enough
    await userEvent.click(within(menu).getByText("Click again to delete all saved strategies"));
    expect(menu).toHaveTextContent("Saved (0)");
  });

  it("the builder only links to the closed trades; deleting them is on the Strategy portfolio page", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" }));
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    const link = await screen.findByTestId("closed-menu");
    expect(link).toHaveTextContent("Closed (1)");
    expect(link.tagName).toBe("A"); // a link to /portfolio#closed, no pop-up list that can run off a phone screen
    expect(screen.queryByRole("button", { name: /Delete closed trade/ })).toBeNull();
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
    // levels on the wrong side of (or at) the entry never fire: a sold 114.6 with a stop typed as 0 %, or "1" on the way to 150
    expect(hitOf({ action: "SELL", premium: 114.6, stop: 114.6 }, "stop", 114.6)).toBe(false);
    expect(hitOf({ action: "SELL", premium: 114.6, stop: 1 }, "stop", 114.6)).toBe(false);
    expect(hitOf({ action: "SELL", premium: 114.6, stop: 149 }, "stop", 150)).toBe(true);
    expect(hitOf({ action: "SELL", premium: 114.6, stop: 149 }, "stop", 148)).toBe(false);
    expect(hitOf({ action: "BUY", premium: 100, target: 90 }, "target", 100)).toBe(false);
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
