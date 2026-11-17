import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { TEMP_KEY, WORKING_KEY } from "../pages/StrategyBuilder";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

// The user's own strategy (held by the server and in this browser) and a forward-test position shown for a moment.
const mine = { id: "M1", expiry: "2026-11-10", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", stop: 130, target: 50 };
const forwardLeg = (type: string, premium: number, stop: number) => ({ id: `F-${type}`, expiry: "2026-11-10", strike: 24100, type, action: "SELL", lots: 1, premium, premiumSource: "market", stop, target: null, enteredAt: "2026-11-05T04:00:00.000Z", stopSetAt: "2026-11-05T04:00:00.000Z" });
const tempDoc = { name: "Forward weekly straddle #1, 5 Nov 09:30", expiry: "2026-11-10", legs: [forwardLeg("CE", 74.4, 104.15), forwardLeg("PE", 48.95, 68.55)], rules: { sl: null, target: null, lockAt: null, lockProfit: null, trailEvery: null, trailBy: null }, moveToCost: false, holdFrom: "2026-11-05T04:00:00.000Z" };
type Call = { url: string; method: string };
let calls: Call[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T05:00:00Z"));
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0]!;
    calls.push({ url, method: init?.method ?? "GET" });
    if (url === "/api/strategies/running") return new Response(JSON.stringify({ doc: { rev: 4, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", name: "my own", legs: [mine] }, checking: { live: true, last_check_at: null, error: null } }), { status: 200 });
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": { ...expiries, weekly: "2026-11-10", monthly: "2026-11-24", available: ["2026-11-10", "2026-11-24"] }, "/api/snapshots": [summary()], "/api/option-chain": chain, "/api/strategies": { saved: [], closed: [] } };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [mine], expiry: "2026-11-10", name: "my own", loaded: null, baseline: [mine], at: Date.now() }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (path: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);

describe("a strategy shown temporarily in the builder", () => {
  it("shows the handed-over legs with their stops and times instead of the user's own strategy, says it is temporary, and touches nothing of the user's", async () => {
    sessionStorage.setItem(TEMP_KEY, JSON.stringify(tempDoc));
    mount("/strategy?temp=forward");
    expect(await screen.findByTestId("temp-banner")).toHaveTextContent("Temporary view of Forward weekly straddle #1, 5 Nov 09:30");
    expect(screen.getByTestId("temp-banner")).toHaveTextContent("your own strategy is exactly as you left it");
    const stops = await screen.findAllByLabelText("Stop-loss premium");
    expect(stops).toHaveLength(2); // two legs: the forward position, not the user's one leg
    expect((stops[0] as HTMLInputElement).value).toBe("104.15");
    expect((stops[1] as HTMLInputElement).value).toBe("68.55");
    expect(screen.getByLabelText("Strategy name")).toHaveValue("Forward weekly straddle #1, 5 Nov 09:30");
    const times = screen.getAllByTestId("leg-times");
    expect(times[0]).toHaveTextContent("Entered 05 Nov, 09:30:00");
    expect(times[0]).toHaveTextContent("Stop set 104.15");
    expect(screen.getByTestId("sync-state")).toHaveTextContent("Temporary view: not saved");
    await new Promise((r) => setTimeout(r, 50));
    // nothing was read from or sent to the server's running strategy, and the user's working copy in this browser is unchanged
    expect(calls.filter((c) => c.url === "/api/strategies/running")).toEqual([]);
    expect(JSON.parse(localStorage.getItem(WORKING_KEY)!).legs).toEqual([mine]);
    expect(JSON.parse(localStorage.getItem(WORKING_KEY)!).name).toBe("my own");
  });

  it("edits made in the temporary view are not saved anywhere", async () => {
    sessionStorage.setItem(TEMP_KEY, JSON.stringify(tempDoc));
    mount("/strategy?temp=forward");
    const stop = (await screen.findAllByLabelText("Stop-loss premium"))[0]!;
    fireEvent.change(stop, { target: { value: "110" } });
    await waitFor(() => expect((screen.getAllByLabelText("Stop-loss premium")[0] as HTMLInputElement).value).toBe("110"));
    await new Promise((r) => setTimeout(r, 900)); // longer than the pause before a send
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(JSON.parse(localStorage.getItem(WORKING_KEY)!).legs).toEqual([mine]);
  });

  it("without the temporary flag, or with nothing handed over, the builder is the user's own as before", async () => {
    sessionStorage.setItem(TEMP_KEY, JSON.stringify(tempDoc));
    mount("/strategy"); // no ?temp: the handed-over document is ignored
    expect(await screen.findAllByLabelText("Stop-loss premium")).toHaveLength(1); // the user's own single leg (the server's copy)
    expect(screen.queryByTestId("temp-banner")).toBeNull();
    expect(calls.some((c) => c.url === "/api/strategies/running")).toBe(true);
  });
});
