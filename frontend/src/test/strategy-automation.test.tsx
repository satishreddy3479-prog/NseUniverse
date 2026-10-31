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
afterEach(() => { vi.unstubAllGlobals(); liveStore.reset(); });

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
    await waitFor(() => expect(screen.getByTestId("leg-exited")).toHaveTextContent("Exited at 133.00 (stop)"));
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
