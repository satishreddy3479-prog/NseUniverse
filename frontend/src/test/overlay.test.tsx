import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { INDEX_KEY, liveStore } from "../lib/liveStore";
import type { StreamStatus } from "../lib/types";
import { bigChain, expiries, liveTick, status, streamStatus } from "./fixtures";

class IdleSocket {
  onopen = null; onmessage = null; onclose = null; onerror = null;
  close() {}
}

function renderChain(stream: Partial<StreamStatus>) {
  const ok = (b: unknown) => () => new Response(JSON.stringify(b), { status: 200 });
  const routes: Record<string, () => Response> = {
    "/api/status": ok(status({ stream: streamStatus(stream) })),
    "/api/expiries": ok(expiries),
    "/api/snapshots": ok([]),
    "/api/option-chain": ok(bigChain()),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const h = routes[String(input).split("?")[0]!];
    return h ? h() : new Response("{}", { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/option-chain"]}><AppRoutes /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const streaming: Partial<StreamStatus> = {
  state: "streaming", effective_state: "streaming", freshness: "fresh", data_source: "live",
  data_age_seconds: 1, market: { state: "open", code: 1, text: "Market open", exchange_segment: null, received_at: null, source: "exchange_feed" },
};

beforeEach(() => vi.stubGlobal("WebSocket", IdleSocket));
afterEach(() => {
  liveStore.reset();
  vi.unstubAllGlobals();
});

const atmRow = (table: HTMLElement) => within(table).getByText("ATM").closest("tr")!;

describe("option chain live overlay", () => {
  it("shows streamed LTP and volume for the instrument and recomputes LTP change from the snapshot's previous close", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    expect(within(atmRow(table)).queryByText("123.45")).not.toBeInTheDocument();
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", ltp: 123.45, volume: 650, prev_close: 80, seq: 1 }),
    ] }));
    const row = atmRow(table);
    expect(within(row).getByText("123.45")).toBeInTheDocument();
    expect(within(row).getByText("650")).toBeInTheDocument();
    expect(within(row).getByText("+54.31%")).toBeInTheDocument(); // (123.45 - 80) / 80, previous close from the snapshot
    expect(screen.getByText(/Live: LTP, volume, OI, OI change, totals and the ATM strike update from the stream/)).toBeInTheDocument();
  });

  it("applies streamed OI and recomputes OI change from the snapshot's previous-day OI", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", oi: 1500, seq: 1 }),
    ] }));
    const row = atmRow(table);
    expect(within(row).getByText("1,500")).toBeInTheDocument(); // live OI
    expect(within(row).getByText("+600")).toBeInTheDocument(); // 1500 - snapshot previous OI 900, not the source's change
  });

  it("does not let a streamed OI of 0 replace a positive snapshot OI", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", oi: 0, seq: 1 }),
    ] }));
    expect(within(atmRow(table)).getAllByText("1,000").length).toBeGreaterThan(0);
  });

  it("totals follow the stream", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    const total = () => within(table).getAllByRole("row").find((r) => r.textContent?.includes("Total"))!.textContent!;
    expect(total()).toContain("7,000");
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", oi: 2000, seq: 1 }),
    ] }));
    expect(total()).toContain("8,000"); // six strikes at 1,000 plus the live 2,000
  });

  it("moves the ATM marker to the strike nearest the live NIFTY price", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    expect(atmRow(table).textContent).toContain("24,050"); // broker label from the snapshot
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: INDEX_KEY, kind: "index", exchange_segment: "nse_cm", instrument_token: "Nifty 50", ltp: 23960, seq: 1 }),
    ] }));
    expect(within(table).getAllByText("ATM")).toHaveLength(1);
    expect(atmRow(table).textContent).toContain("23,950");
    expect(atmRow(table).textContent).not.toContain("24,050");
  });

  it("keeps the broker ATM when the stream is stale", async () => {
    renderChain({ ...streaming, effective_state: "stale", freshness: "stale" });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: INDEX_KEY, kind: "index", exchange_segment: "nse_cm", instrument_token: "Nifty 50", ltp: 23960, seq: 1 }),
    ] }));
    expect(atmRow(table).textContent).toContain("24,050");
  });

  it("only the row whose instrument ticked changes", async () => {
    renderChain(streaming);
    const table = await screen.findByRole("table", { name: /Option chain/ });
    const before = within(table).getByText("24,000").closest("tr")!.innerHTML;
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", ltp: 150, seq: 1 }),
    ] }));
    expect(within(table).getByText("24,000").closest("tr")!.innerHTML).toBe(before);
  });

  it("dims live cells and warns when the stream is stale", async () => {
    renderChain({ ...streaming, effective_state: "stale", freshness: "stale", data_age_seconds: 90 });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", ltp: 123.45, seq: 1 }),
    ] }));
    expect(screen.getByText(/live cells are dimmed and may be out of date/)).toBeInTheDocument();
    expect(within(atmRow(table)).getByText("123.45").className).toContain("opacity-60");
  });

  it("does not overlay anything when the stream is stopped", async () => {
    renderChain({ state: "stopped" });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    act(() => liveStore.apply({ type: "ticks", ticks: [
      liveTick({ key: "nse_fo|24050CE", instrument_token: "24050CE", ltp: 123.45, seq: 1 }),
    ] }));
    expect(within(table).queryByText("123.45")).not.toBeInTheDocument();
    expect(screen.queryByText(/Live: LTP, volume, OI/)).not.toBeInTheDocument();
  });

  it("start and stop buttons reflect the stream state", async () => {
    renderChain(streaming);
    await screen.findByRole("table", { name: /Option chain/ });
    expect(screen.getByRole("button", { name: "Start stream" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop stream" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop stream" }));
  });
});
