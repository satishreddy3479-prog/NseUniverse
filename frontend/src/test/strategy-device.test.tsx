// The Strategy portfolio page and the builder hand-over do not depend on the browser: what is running comes from the server, and opening a strategy travels in the address.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { builderUrl } from "../pages/StrategyBuilder";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

const leg = (over: Record<string, unknown> = {}) => ({ id: "L1", expiry: "2026-11-10", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", ...over });
let running: { doc: unknown };
let saved: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T05:00:00Z"));
  localStorage.clear(); sessionStorage.clear();
  running = { doc: null }; saved = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    if (url === "/api/strategies/running") return new Response(JSON.stringify({ ...running, checking: { live: true, last_check_at: null, error: null } }), { status: 200 });
    const chain = bigChain(); chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, weekly: "2026-11-10", monthly: "2026-11-24", available: ["2026-11-10", "2026-11-24"] }, "/api/snapshots": [summary()],
      "/api/option-chain": chain, "/api/strategies": { saved, closed: [] },
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const Where = () => { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; };
const mount = (at: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}><AppRoutes /><Where /></MemoryRouter></QueryClientProvider>);

describe("one owner, any device", () => {
  it("the Strategy portfolio page lists the strategy running on the server even when this browser has never opened the builder", async () => {
    running = { doc: { rev: 3, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", name: "", legs: [leg({ id: "srv" })] } };
    mount("/portfolio"); // a new browser: nothing in localStorage
    expect(await screen.findByLabelText(/Open Current strategy \(not saved\) in the strategy builder/, {}, { timeout: 15000 })).toBeInTheDocument();
  });

  it("with nothing running on the server it lists no running strategy, whatever an old copy in this browser says", async () => {
    localStorage.setItem("nse.builder.working.v1", JSON.stringify({ legs: [leg({ id: "old" })], expiry: "2026-11-10", name: "", loaded: null, baseline: [], at: Date.now() }));
    running = { doc: { rev: 9, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", legs: [] } };
    mount("/portfolio");
    await waitFor(() => expect(screen.getByTestId("portfolio-tiles")).toBeInTheDocument(), { timeout: 15000 });
    expect(screen.queryByLabelText(/Current strategy \(not saved\)/)).toBeNull();
  });

  it("opening a saved strategy from the portfolio goes through the address, not this browser's storage, and the address is cleaned once it is open", async () => {
    saved = [{ name: "straddle 30/10/2026", savedAt: "2026-11-04T04:00:00Z", expiry: "2026-11-10", legs: [leg({ id: "s1" }), leg({ id: "s2", type: "PE" })] }];
    mount("/portfolio");
    await userEvent.click(await screen.findByLabelText("Open straddle 30/10/2026 in the strategy builder", {}, { timeout: 15000 }));
    expect(await screen.findAllByLabelText("Stop-loss premium", {}, { timeout: 15000 })).toHaveLength(2);
    expect(localStorage.getItem("nse.builder.working.v1") ?? "").not.toContain("s1"); // nothing was handed over through the browser (the builder's own copy is written after the server answered)
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/strategy$/)); // the request is removed from the address
  });

  it("the address for a strategy with slashes and spaces in its name survives the trip", () => {
    expect(builderUrl({ open: "straddle 30/10/2026" })).toBe("/strategy?open=straddle%2030%2F10%2F2026");
    expect(builderUrl({ closed: "c1" })).toBe("/strategy?closed=c1");
    expect(builderUrl({})).toBe("/strategy");
  });
});
