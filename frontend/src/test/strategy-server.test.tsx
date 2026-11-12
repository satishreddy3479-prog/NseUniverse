import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { WORKING_KEY } from "../pages/StrategyBuilder";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

const leg = (over: Record<string, unknown> = {}) => ({
  id: "L1", expiry: "2026-11-10", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", stop: 130, target: 50, ...over,
});
type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let running: { doc: unknown } = { doc: null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T05:00:00Z"));
  calls = [];
  running = { doc: null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input), url = full.split("?")[0]!, method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/strategies/running") {
      if (method === "PUT") return new Response(JSON.stringify({ ok: true, rev: 7 }), { status: 200 });
      return new Response(JSON.stringify({ ...running, checking: { live: true, last_check_at: null, error: null } }), { status: 200 });
    }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, weekly: "2026-11-10", monthly: "2026-11-24", available: ["2026-11-10", "2026-11-24"] }, "/api/snapshots": [summary()],
      "/api/option-chain": chain, "/api/strategies": { saved: [], closed: [] },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/strategy"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);

describe("Strategy builder with the server keeping the stops and targets", () => {
  it("takes the server's copy of the running strategy, including a leg the server already closed", async () => {
    running = { doc: { rev: 4, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", name: "x", legs: [leg({ exitPrice: 131, exitReason: "stop", exitedAt: "2026-11-05T04:00:00Z", realised: -2325 })], serverEvents: [{ at: "2026-11-05T04:00:00Z", text: "09:30:00 Stop: SELL 24050 CE closed at 131.00 [server]" }] } };
    mount();
    expect(await screen.findByTestId("leg-exited")).toHaveTextContent("Exited at 131.00 (stop)");
    expect(await screen.findByTestId("auto-state")).toHaveTextContent(/server/);
  });

  it("sends the strategy to the server with the contract's live key, and the revision it last saw", async () => {
    running = { doc: { rev: 4, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", legs: [leg()] } };
    mount();
    await screen.findAllByLabelText("Stop-loss premium");
    // an edit made here is sent after a short pause
    const stop = (await screen.findAllByLabelText("Stop-loss premium"))[0]!;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(stop, { target: { value: "140" } });
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(true), { timeout: 3000 });
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/strategies/running")!.body as { base_rev: number; doc: { legs: { key: string; stop: number }[]; auto: boolean } };
    expect(put.base_rev).toBe(4);
    expect(put.doc.legs[0]!.stop).toBe(140);
    expect(put.doc.legs[0]!.key).toMatch(/^nse_fo\|/);
    expect(put.doc.auto).toBe(true);
  });

  it("takes the Move SL to cost switch from the server's copy and sends a change of it back, so the server applies it with no page open", async () => {
    running = { doc: { rev: 4, auto: true, moveToCost: true, lotSize: 75, mult: 1, expiry: "2026-11-10", legs: [leg()] } };
    mount();
    const toggle = await screen.findByRole("checkbox", { name: "Move other legs' stop to cost" });
    await waitFor(() => expect(toggle).toBeChecked()); // the server's copy says it is on
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(true), { timeout: 3000 });
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/strategies/running")!.body as { doc: { moveToCost: boolean } };
    expect(put.doc.moveToCost).toBe(false); // switched off here and sent up
    expect(JSON.parse(localStorage.getItem(WORKING_KEY) ?? "{}").moveToCost).toBe(false); // and kept across a refresh
  });

  it("moves a working strategy of an expired expiry to the latest weekly expiry instead of staying on it", async () => {
    localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [leg({ expiry: "2026-11-03" })], expiry: "2026-11-03", name: "old", loaded: null, baseline: [], at: Date.now() }));
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /10 Nov/ })).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByText(/which has expired and is no longer listed/)).toBeInTheDocument();
    expect(localStorage.getItem("nse.builder.expired.v1")).toContain("2026-11-03"); // a copy is kept
  });
});
