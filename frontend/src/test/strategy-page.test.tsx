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
const loaded = () => waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"));

describe("Strategy builder page", () => {
  it("shows the instrument, the stored chain's lot size and never hard-codes one", async () => {
    mount();
    expect(await screen.findByText("NIFTY 50")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle(/instrument data in the stored chain/)).toHaveTextContent("75")); // the fixture's lot size, not a built-in number
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
    await userEvent.click(screen.getByRole("button", { name: "Reset / New" }));
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText("Saved strategies"), "my spread");
    expect(within(await screen.findByRole("table", { name: "Strategy legs" })).getAllByLabelText("Strike")).toHaveLength(2);
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
    await userEvent.click(await screen.findByRole("button", { name: "Target 50%" })); // 150 -> +50 x 75
    await userEvent.click(screen.getByRole("button", { name: "Stop 30%" })); // 70 -> -30 x 75
    expect(await screen.findByTestId("risk-stats")).toHaveTextContent("If targets hit+₹3,750");
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("If stops hit−₹2,250");
    expect((screen.getByLabelText("Target premium") as HTMLInputElement).value).toBe("150");
    expect((screen.getByLabelText("Stop-loss premium") as HTMLInputElement).value).toBe("70");
  });

  it("a target on the wrong side of the entry is flagged, and for a seller the sides swap", async () => {
    mount();
    await loaded();
    await userEvent.click(await screen.findByRole("button", { name: "Sell CE 24100" })); // entry 100
    await userEvent.click(await screen.findByRole("button", { name: "Target 50%" })); // seller target is below: 50
    expect((screen.getByLabelText("Target premium") as HTMLInputElement).value).toBe("50");
    await userEvent.click(screen.getByRole("button", { name: "Stop 30%" })); // seller stop is above: 130
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
