import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

// 17 Nov 2026: the server stopped the call at 10:17:15 IST (122.05, entry 60.85) and moved the put's stop to cost; its intraday close at 15:20:00 IST then closed the put at 0.60
// (entry 51.15). The page was opened at 15:56 and filed the finished strategy: it must be closed at 15:20, not at 15:56, and not "at stale prices".
const ce = { id: "c", expiry: "2026-11-10", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 60.85, premiumSource: "market", stop: 85.2, exitPrice: 122.05, exitReason: "stop", exitedAt: "2026-11-05T04:47:15.042774+00:00", realised: -3978.25, reentry: 0 };
const pe = { id: "p", expiry: "2026-11-10", strike: 24050, type: "PE", action: "SELL", lots: 1, premium: 51.15, premiumSource: "market", stop: 51.15, exitPrice: 0.6, exitReason: "strategy", exitedAt: "2026-11-05T09:50:00.917359+00:00", realised: 3286.25, reentry: 0 };
type Call = { url: string; method: string; body: { doc?: { closedAt: string; snapshotAt: string; stale: boolean; pnl: number } } | null };
let calls: Call[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T10:26:00Z")); // 15:56 IST
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/strategies/running") {
      if (method === "PUT") return new Response(JSON.stringify({ ok: true, rev: 8 }), { status: 200 });
      return new Response(JSON.stringify({ doc: { rev: 7, auto: true, lotSize: 65, mult: 1, expiry: "2026-11-10", name: "Straddle score 79", hold: { mode: "intraday", closeAt: "15:20" }, legs: [ce, pe] }, checking: { live: false, last_check_at: null, error: null } }), { status: 200 });
    }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    chain.stale = true; // the market has been closed for 26 minutes: the stored chain is stale
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, weekly: "2026-11-10", monthly: "2026-11-24", available: ["2026-11-10", "2026-11-24"] }, "/api/snapshots": [summary()],
      "/api/option-chain": chain, "/api/strategies": { saved: [], closed: [] },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("a strategy the server closed at 15:20 and the page files later", () => {
  it("is closed when its last leg closed, with the P&L its exits booked, and is not marked as closed at stale prices", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/strategy"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/strategies/closed") && c.method === "PUT")).toBe(true), { timeout: 4000 });
    const put = calls.find((c) => c.url.startsWith("/api/strategies/closed") && c.method === "PUT")!;
    const doc = put.body!.doc!;
    expect(doc.closedAt).toBe("2026-11-05T09:50:00.917Z"); // 15:20:00 IST, the later of the two exits, not the 15:56 the page filed it
    expect(doc.snapshotAt).toBe("2026-11-05T09:50:00.917359+00:00");
    expect(doc.stale).toBe(false);
    expect(doc.pnl).toBeCloseTo(-691.99, 1); // -3,978.25 + 3,286.25 as the exits booked
  });
});
