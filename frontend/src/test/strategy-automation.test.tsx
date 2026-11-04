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
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});
// the stream is reported as live, so the automatic rules run; the prices come from ticks pushed into the live store
vi.mock("../lib/useLive", async () => {
  const actual = await vi.importActual<typeof import("../lib/useLive")>("../lib/useLive");
  return { ...actual, useStreamStatus: () => ({ stream: streamStatus({ state: "streaming", effective_state: "streaming" } as never), linkOpen: true, outdated: false }) };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T05:00:00Z")); // fixtures expire on 3 Nov 2026
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03"] }, "/api/snapshots": [summary()], "/api/option-chain": chain };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
  liveStore.reset();
});
afterEach(() => { vi.unstubAllGlobals(); liveStore.reset(); vi.useRealTimers(); });

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/strategy"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
let seq = 1;
const tick = (key: string, ltp: number) => act(() => { liveStore.apply({ type: "ticks", ticks: [liveTick({ key, instrument_token: key.split("|")[1]!, ltp, seq: ++seq })] } as never); });

describe("automatic stop, target and re-entry through the page", () => {
  it("closes a sold leg at its stop on a live price, then enters it again when the premium falls back to its entry", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 5000 });
    await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS.short_straddle! }));
    await userEvent.click(await screen.findByRole("button", { name: TEMPLATES.find((t) => t.id === "short_straddle")!.label }));
    const table = within(await screen.findByRole("table", { name: "Strategy legs" }));
    // stored entry 100 for both legs; stop at +30 %, one re-entry on the first leg
    await userEvent.type(table.getAllByLabelText("Stop percent of entry premium")[0]!, "30");
    const re = table.getAllByLabelText("Re-entries after a stop")[0]!;
    await userEvent.clear(re); await userEvent.type(re, "1");
    expect(await screen.findByTestId("auto-state")).toHaveTextContent("watching live prices");

    tick("nse_fo|24050CE", 125); // below the stop of 130: nothing happens
    await waitFor(() => expect(table.getAllByLabelText("Exit price")).toHaveLength(2));
    tick("nse_fo|24050CE", 133); // the stop is reached: the leg is closed at the live price 133 (a loss of 33 x 75)
    await waitFor(() => expect(screen.getByTestId("leg-exited")).toHaveTextContent("Exited at 133.00 (stop)"), { timeout: 4000 }); // typing settles for 1.5 s before a new level is checked
    expect(screen.getByTestId("leg-exited")).toHaveTextContent("−₹2,475");
    expect(screen.getByTestId("reentry-armed")).toHaveTextContent("back at or below 100.00");
    expect(screen.getByTestId("auto-note")).toHaveTextContent("Stop: SELL 24050 CE closed at 133.00");
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("booked −₹2,475");

    tick("nse_fo|24050CE", 110); // still above its entry: stays out
    expect(screen.getByTestId("leg-exited")).toBeInTheDocument();
    tick("nse_fo|24050CE", 98); // back below 100: entered again at the live price 98, stop 30 % above that
    await waitFor(() => expect(screen.queryByTestId("leg-exited")).not.toBeInTheDocument());
    expect((table.getAllByLabelText("Entry premium")[0] as HTMLInputElement).value).toBe("98");
    expect((table.getAllByLabelText("Stop-loss premium")[0] as HTMLInputElement).value).toBe("127.4"); // 98 x 1.3
    expect((table.getAllByLabelText("Re-entries after a stop")[0] as HTMLInputElement).value).toBe("0"); // the one re-entry is used
  });

  it("a leg can be exited by hand at the live price or at a typed price, and entered again", async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 5000 });
    await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS.short_straddle! }));
    await userEvent.click(await screen.findByRole("button", { name: TEMPLATES.find((t) => t.id === "short_straddle")!.label }));
    const table = within(await screen.findByRole("table", { name: "Strategy legs" }));
    tick("nse_fo|24050PE", 90);
    await userEvent.type(table.getAllByLabelText("Exit price")[1]!, "92.5");
    await userEvent.click(table.getAllByRole("button", { name: "Exit leg" })[1]!);
    await waitFor(() => expect(screen.getByTestId("leg-exited")).toHaveTextContent("Exited at 92.50 (manual)"));
    expect(screen.getByTestId("leg-exited")).toHaveTextContent("+₹563"); // sold at 100, bought back at 92.5: 7.5 x 75 = 562.5 (the fixture lot is 75)
    await waitFor(() => expect(table.getAllByText("90.00").length).toBeGreaterThan(0)); // the live price has reached the table
    await userEvent.click(screen.getByRole("button", { name: "Enter leg again" }));
    await waitFor(() => expect(screen.queryByTestId("leg-exited")).not.toBeInTheDocument());
    expect((table.getAllByLabelText("Entry premium")[1] as HTMLInputElement).value).toBe("90");
  });
});

describe("strategy rules and the percentage trailing stop through the page", () => {
  const setup = async () => {
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 5000 });
    await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS.short_straddle! }));
    await userEvent.click(await screen.findByRole("button", { name: TEMPLATES.find((t) => t.id === "short_straddle")!.label }));
    return within(await screen.findByRole("table", { name: "Strategy legs" }));
  };

  it("trails the stop 5 % of the entry for every 10 % the sold leg falls (entry 100, stop 130, price 90 gives 125)", async () => {
    const table = await setup();
    await userEvent.type(table.getAllByLabelText("Stop percent of entry premium")[0]!, "30");
    await userEvent.type(screen.getAllByLabelText("Trail every percent")[0]!, "10");
    await userEvent.type(screen.getAllByLabelText("Trail by percent")[0]!, "5{Enter}");
    tick("nse_fo|24050CE", 90);
    await waitFor(() => expect((table.getAllByLabelText("Stop-loss premium")[0] as HTMLInputElement).value).toBe("125"), { timeout: 4000 });
    expect(screen.getByTestId("stop-trailed")).toHaveTextContent("stop trailed from 130.00 to 125.00");
    expect(screen.getByTestId("auto-note")).toHaveTextContent("Trailing stop SELL 24050 CE: stop 130.00 → 125.00");
    tick("nse_fo|24050CE", 125); // back up to the trailed stop: closed there
    await waitFor(() => expect(screen.getByTestId("leg-exited")).toHaveTextContent("Exited at 125.00 (stop)"), { timeout: 4000 });
  });

  it("a strategy stop loss closes both legs when the P&L reaches it, and half-typed numbers arm nothing until committed", async () => {
    const table = await setup();
    await userEvent.click(screen.getByText(/Strategy stop loss, target and lock/));
    const sl = screen.getByLabelText("Stop loss ₹");
    await userEvent.type(sl, "1"); // typed but not committed: nothing armed
    tick("nse_fo|24050CE", 200);
    expect(table.getAllByLabelText("Exit price")).toHaveLength(2);
    await userEvent.clear(sl); await userEvent.type(sl, "1000{Enter}");
    // CE 114, PE stored 100: -(14 x 75) = -1,050 <= -1,000
    tick("nse_fo|24050CE", 114);
    await waitFor(() => expect(screen.getAllByTestId("leg-exited")).toHaveLength(2), { timeout: 4000 });
    expect(screen.getByTestId("strategy-rules")).toHaveTextContent("stop loss exit done");
    expect(screen.getByTestId("auto-note")).toHaveTextContent("Strategy stop loss (−₹1,000)");
    await userEvent.click(screen.getByTestId("rules-rearm"));
    expect(screen.queryByTestId("rules-rearm")).not.toBeInTheDocument();
  });

  it("flags a lock that cannot work and shows the floor the lock gives", async () => {
    await setup();
    await userEvent.click(screen.getByText(/Strategy stop loss, target and lock/));
    await userEvent.type(screen.getByLabelText("Lock when profit reaches ₹"), "1000{Enter}");
    expect(screen.getByTestId("rules-problem")).toHaveTextContent("Lock needs both"); // only one half typed
    await userEvent.type(screen.getByLabelText("Lock profit ₹"), "1000{Enter}");
    expect(screen.getByTestId("rules-problem")).toHaveTextContent("locked profit has to be below");
    await userEvent.clear(screen.getByLabelText("Lock profit ₹")); await userEvent.type(screen.getByLabelText("Lock profit ₹"), "500{Enter}");
    expect(screen.queryByTestId("rules-problem")).not.toBeInTheDocument();
  });
});
