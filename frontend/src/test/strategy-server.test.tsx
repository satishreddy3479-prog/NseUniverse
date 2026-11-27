import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { builderUrl, WORKING_KEY } from "../pages/StrategyBuilder";
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
let serverDown = false;
let strategies: { saved: unknown[]; closed: unknown[] } = { saved: [], closed: [] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T05:00:00Z"));
  calls = [];
  running = { doc: null };
  serverDown = false;
  strategies = { saved: [], closed: [] };
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input), url = full.split("?")[0]!, method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (serverDown && url.startsWith("/api/strategies")) throw new TypeError("offline");
    if (url === "/api/strategies/running") {
      if (method === "PUT") return new Response(JSON.stringify({ ok: true, rev: 7 }), { status: 200 });
      return new Response(JSON.stringify({ ...running, checking: { live: true, last_check_at: null, error: null } }), { status: 200 });
    }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = {
      "/api/status": status(), "/api/expiries": { ...expiries, weekly: "2026-11-10", monthly: "2026-11-24", available: ["2026-11-10", "2026-11-24"] }, "/api/snapshots": [summary()],
      "/api/option-chain": chain, "/api/strategies": strategies,
    };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (at = "/strategy") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}><AppRoutes /></MemoryRouter></QueryClientProvider>);

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

  it("takes the managed straddle's distance from the server's copy, shows it, and sends a change of it back (the distance only)", async () => {
    running = { doc: { rev: 4, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", legs: [leg(), leg({ id: "L2", type: "PE" })], restrike: { points: 100 } } };
    mount();
    const box = await screen.findByTestId("restrike-box");
    expect(box).toHaveTextContent("re-strike when NIFTY is");
    const points = screen.getByLabelText("Re-strike distance in points") as HTMLInputElement;
    await waitFor(() => expect(points.value).toBe("100"));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(points, { target: { value: "150" } });
    fireEvent.blur(points);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(true), { timeout: 3000 });
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/strategies/running")!.body as { doc: { restrike: Record<string, unknown> | null } };
    expect(put.doc.restrike).toEqual({ points: 150 }); // the distance and nothing else: the index, the strikes and their keys are the server's
    fireEvent.click(screen.getByRole("button", { name: "200" })); // the quick choices
    await waitFor(() => expect((screen.getByLabelText("Re-strike distance in points") as HTMLInputElement).value).toBe("200"));
    expect(screen.getByRole("button", { name: "200" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("restrike-off"));
    await waitFor(() => expect(screen.queryByTestId("restrike-box")).toBeNull());
  });

  it("choosing the Managed straddle ready-made sells the ATM pair and turns the re-strike on at 100 points", async () => {
    mount();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(await screen.findByRole("tab", { name: "Neutral" }));
    fireEvent.click(await screen.findByRole("button", { name: "Managed straddle" }));
    expect(await screen.findByTestId("restrike-box")).toBeInTheDocument();
    expect((screen.getByLabelText("Re-strike distance in points") as HTMLInputElement).value).toBe("100");
    expect(await screen.findAllByLabelText("Stop-loss premium")).toHaveLength(2); // a sold CE and a sold PE
  });

  it("an old working copy kept in this browser is not written back when the server's running strategy is empty (20 and 23 Nov 2026: a closed straddle came back)", async () => {
    // the server closed and reset the strategy: nothing is running; this browser still holds the old straddle, saved only a day ago
    running = { doc: { rev: 9, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", legs: [] } };
    localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [leg({ id: "old1" }), leg({ id: "old2", type: "PE" })], expiry: "2026-11-10", name: "", loaded: "straddle s57", baseline: [], rules: { stopLoss: null, target: null, lock: null }, rearmAt: "2026-11-04T05:01:59.334Z", hold: { closeAt: "15:20", mode: "intraday" }, holdFrom: "2026-11-04T05:02:01Z", at: Date.parse("2026-11-04T10:00:00Z") }));
    mount();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/strategies/running" && c.method === "GET")).toBe(true));
    await new Promise((r) => setTimeout(r, 1500)); // longer than the page's pause before it sends an edit
    expect(screen.queryAllByLabelText("Stop-loss premium")).toHaveLength(0); // the old legs are not shown
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(false); // and nothing was sent
    expect(JSON.parse(localStorage.getItem(WORKING_KEY) ?? '{"legs":[]}').legs).toEqual([]);
  });

  it("opening a closed trade to look at it never replaces the running strategy on the server, and leaving the view brings the running strategy back", async () => {
    running = { doc: { rev: 6, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", name: "live", legs: [leg({ id: "live1" })] } };
    strategies = { saved: [], closed: [{ id: "c1", name: "yesterday", closedAt: "2026-11-04T10:00:00Z", snapshotAt: "2026-11-04T10:00:00Z", expiry: "2026-11-10", lotSize: 75, pnl: 500, legs: [{ ...leg({ id: "old", strike: 23900, exitPrice: 90, exitReason: "strategy", realised: 750 }), exit: 90 }] }] };
    mount(builderUrl({ closed: "c1" }));
    expect(await screen.findByTestId("opened-closed")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500)); // longer than the page's pause before it sends an edit
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(false); // the live strategy was not overwritten by the closed one
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "Reset strategy" })); // leave the view
    await waitFor(() => expect(screen.queryByTestId("opened-closed")).toBeNull());
    expect(await screen.findAllByLabelText("Stop-loss premium")).toHaveLength(1); // the running strategy is back
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(false); // and nothing was cleared on the server
  });

  it("with nothing on the server at all, the server is the truth: an old copy in this browser is not shown and nothing is sent", async () => {
    running = { doc: null };
    localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [leg({ id: "mine" })], expiry: "2026-11-10", name: "", loaded: null, baseline: [], rearmAt: null, holdFrom: null, at: Date.parse("2026-11-04T10:00:00Z") }));
    mount();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/strategies/running" && c.method === "GET")).toBe(true));
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.queryAllByLabelText("Stop-loss premium")).toHaveLength(0);
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/strategies/running")).toBe(false);
  });

  it("a second device with nothing stored shows the server's strategy, and whatever it sends back keeps the server's legs", async () => {
    running = { doc: { rev: 4, auto: true, lotSize: 75, mult: 1, expiry: "2026-11-10", name: "mine", legs: [leg({ id: "server-leg" })] } };
    mount(); // empty localStorage: a new browser
    expect(await screen.findAllByLabelText("Stop-loss premium")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1500));
    for (const c of calls.filter((x) => x.method === "PUT" && x.url === "/api/strategies/running")) expect((c.body as { doc: { legs: { id: string }[] } }).doc.legs.map((l) => l.id)).toEqual(["server-leg"]);
  });

  it("when the server cannot be reached the page keeps working from this browser's last copy", async () => {
    serverDown = true;
    localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [leg({ id: "mine" })], expiry: "2026-11-10", name: "", loaded: null, baseline: [], rearmAt: null, holdFrom: null, at: Date.now() }));
    mount();
    expect(await screen.findAllByLabelText("Stop-loss premium")).toHaveLength(1); // the browser's copy
  });

  it("opening a saved strategy from the Strategy portfolio page (through the address) loads it into the builder on any device", async () => {
    strategies = { saved: [{ name: "straddle 30/10/2026", savedAt: "2026-11-04T04:00:00Z", expiry: "2026-11-10", legs: [leg({ id: "s1" }), leg({ id: "s2", type: "PE" })] }], closed: [] };
    mount(builderUrl({ open: "straddle 30/10/2026" })); // a name with slashes travels in the query string
    expect(await screen.findAllByLabelText("Stop-loss premium", {}, { timeout: 15000 })).toHaveLength(2);
  });

  it("an expired working copy kept while the server was away moves to the latest weekly expiry and a copy goes to the Saved list on the server", async () => {
    serverDown = true;
    localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: [leg({ expiry: "2026-11-03" })], expiry: "2026-11-03", name: "old", loaded: null, baseline: [], at: Date.now() }));
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /10 Nov/ })).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByText(/which has expired and is no longer listed/)).toBeInTheDocument();
    expect(screen.getByText(/is in your Saved list/)).toBeInTheDocument();
    expect(localStorage.getItem("nse.strategies.v1")).toContain("old (expired 2026-11-03)");
  });
});
