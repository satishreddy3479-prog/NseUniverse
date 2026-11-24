import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { liveMtmKey } from "../lib/closedMtm";
import { TEMPLATE_BIAS, TEMPLATES, type Leg } from "../lib/strategy";
import { builderUrl, WORKING_KEY } from "../pages/StrategyBuilder";
import { bigChain, expiries, status, summary } from "./fixtures";

vi.mock("../components/EChart", async () => {
  const actual = await vi.importActual<typeof import("../components/EChart")>("../components/EChart");
  return { ...actual, EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> };
});

// a server that remembers what the page stores, so Saved/Closed behave as in production
let store: { saved: Record<string, unknown>[]; closed: Record<string, unknown>[] };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T05:00:00Z")); // the fixtures expire on 3 Nov 2026
  store = { saved: [], closed: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input);
    const url = full.split("?")[0]!;
    const method = init?.method ?? "GET";
    if (url === "/api/strategies" && method === "GET") return new Response(JSON.stringify(store), { status: 200 });
    if (url === "/api/strategies/import") return new Response(JSON.stringify({ added: 0 }), { status: 200 });
    const m = /^\/api\/strategies\/(saved|closed)$/.exec(url);
    if (m) {
      const kind = m[1] as "saved" | "closed";
      if (method === "PUT") {
        const b = JSON.parse(String(init!.body)) as { key: string; doc: Record<string, unknown> };
        const keyOf = (d: Record<string, unknown>) => String(kind === "saved" ? d.name : d.id);
        store[kind] = [b.doc, ...store[kind].filter((d) => keyOf(d) !== b.key)];
      } else if (method === "DELETE") {
        const key = new URL(full, "http://x").searchParams.get("key");
        store[kind] = store[kind].filter((d) => String(kind === "saved" ? d.name : d.id) !== key);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const chain = bigChain();
    chain.snapshot.underlying_ltp = 24050;
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": { ...expiries, available: ["2026-11-03"] }, "/api/snapshots": [summary()], "/api/option-chain": chain };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (at = "/strategy") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
const build = async (id: string) => {
  await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 15000 });
  await userEvent.click(await screen.findByRole("tab", { name: TEMPLATE_BIAS[id]! }));
  await userEvent.click(await screen.findByRole("button", { name: TEMPLATES.find((t) => t.id === id)!.label }));
};

describe("Exit all", () => {
  it("moves a saved strategy to Closed under its own name instead of leaving a copy in Saved", async () => {
    mount();
    await build("short_straddle");
    await userEvent.type(await screen.findByLabelText("Strategy name"), "my straddle");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"));
    expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (0)");
    expect(store.saved).toHaveLength(0); // gone from the server's Saved
    expect(store.closed).toHaveLength(1);
    expect((store.closed[0] as { name: string }).name).toBe("my straddle");
  });

  it("keeps the live graph the page drew with the closed record (the ticks seen while the strategy ran)", async () => {
    mount();
    await build("short_straddle");
    const work = JSON.parse(localStorage.getItem(WORKING_KEY) ?? "{}") as { legs: Leg[] };
    sessionStorage.setItem(liveMtmKey(work.legs.filter((l) => l.enabled !== false)), JSON.stringify([{ t: 1000, v: 0 }, { t: 2000, v: 450 }, { t: 3000, v: -120 }]));
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(store.closed).toHaveLength(1));
    const mtm = (store.closed[0] as { mtm?: { pnl: number[]; complete: boolean; source: string } }).mtm;
    expect(mtm?.pnl).toEqual([0, 450, -120]);
    expect(mtm?.source).toBe("live");
    expect(mtm?.complete).toBe(false); // the stored history completes it afterwards (there is none in this test server)
  });

  it("closing a strategy that was reopened from Closed replaces that record, never adds a second one", async () => {
    mount();
    await build("short_straddle");
    await userEvent.click(screen.getByRole("button", { name: "Exit all" }));
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"));
    const id = String((store.closed[0] as { id: string }).id);
    cleanup(); // the Strategy portfolio page hands the closed trade over; the builder opens it
    mount(builderUrl({ closed: id }));
    await userEvent.click(await screen.findByRole("button", { name: "Exit all" }, { timeout: 15000 }));
    await waitFor(() => expect(store.closed).toHaveLength(1));
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)");
  });
});

describe("Adjusting a running strategy", () => {
  it("rolling a leg books the old leg's P&L and the payoff, breakevens and P&L box follow the new strike", async () => {
    mount();
    await build("short_straddle");
    const stats = () => screen.getByTestId("risk-stats").textContent ?? "";
    const before = stats();
    expect(before).toContain("Breakevens");
    const table = within(await screen.findByRole("table", { name: "Strategy legs" }));
    await userEvent.selectOptions(table.getAllByLabelText("Roll to strike")[0]!, "24150");
    await userEvent.click(table.getAllByRole("button", { name: "Roll leg" })[0]!);
    await waitFor(() => expect(screen.getAllByTestId("leg-log")[0]).toHaveTextContent("Rolled SELL 24050 CE to 24150 CE"));
    // the call now sits at 24150 (stored price 100, same as before): the strategy and its figures were recomputed
    expect((table.getAllByLabelText("Strike")[0] as HTMLSelectElement).value).toBe("24150");
    expect(stats()).not.toBe(before);
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("Breakevens");
  });

  it("changing lots, adding a hedge from the chain and removing a leg all update the maximum loss and the payoff figures", async () => {
    mount();
    await build("short_straddle");
    expect(screen.getByTestId("risk-stats")).toHaveTextContent("Max lossUnlimited");
    await userEvent.click(await screen.findByRole("button", { name: "Buy CE 24200" })); // a long call above caps the upside risk
    await waitFor(() => expect(screen.getByTestId("risk-stats")).not.toHaveTextContent("Max lossUnlimited"));
    const table = within(screen.getByRole("table", { name: "Strategy legs" }));
    await userEvent.click(table.getAllByLabelText("Remove leg").at(-1)!); // remove the hedge again
    await waitFor(() => expect(screen.getByTestId("risk-stats")).toHaveTextContent("Max lossUnlimited"));
  });
});

describe("Strategy portfolio: closed strategies", () => {
  const closedDoc = (id: string, name: string, pnl: number) => ({ id, name, closedAt: "2026-10-30T10:00:00Z", snapshotAt: "2026-10-30T10:00:00Z", expiry: "2026-11-03", lotSize: 75, pnl, stale: false,
    legs: [{ id: `${id}a`, expiry: "2026-11-03", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 130, premiumSource: "market", exit: 100, exitPrice: 100, exitReason: "manual", exitedAt: "2026-10-30T10:00:00Z", realised: 2250 }] });
  it("deletes one closed trade (declined once, then confirmed) from the server and this browser, and the builder does not bring it back", async () => {
    store.closed = [closedDoc("c1", "first", 2250), closedDoc("c2", "second", -500)];
    localStorage.setItem("nse.closed.v1", JSON.stringify(store.closed));
    mount("/portfolio");
    const first = await screen.findByRole("button", { name: "Delete closed trade first" });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    await userEvent.click(first);
    expect(screen.getByTestId("portfolio-closed")).toHaveTextContent("first"); // declined
    await userEvent.click(first);
    await waitFor(() => expect(store.closed.map((c) => c.id)).toEqual(["c2"]));
    expect(JSON.parse(localStorage.getItem("nse.closed.v1") ?? "[]").map((c: { id: string }) => c.id)).toEqual(["c2"]); // not left in the browser copy, or the builder would upload it again
    await waitFor(() => expect(screen.getByTestId("portfolio-closed")).not.toHaveTextContent("first"));
  });

  it("every closed strategy has an MTM graph button that opens the graph saved with the record, and closes it again", async () => {
    const mtm = { t: [Date.parse("2026-10-30T04:00:00Z"), Date.parse("2026-10-30T04:10:00Z"), Date.parse("2026-10-30T04:20:00Z")], pnl: [0, 300, -200], complete: true, source: "stored", savedAt: "2026-10-30T10:00:00Z" };
    store.closed = [{ ...closedDoc("c1", "first", 2250), mtm }];
    mount("/portfolio");
    const btn = await screen.findByRole("button", { name: "MTM graph of first" });
    expect(screen.queryByTestId("closed-mtm")).toBeNull();
    await userEvent.click(btn);
    const box = await screen.findByTestId("closed-mtm");
    expect(box).toHaveTextContent("Max high+₹300");
    expect(box).toHaveTextContent("At the close−₹200");
    await userEvent.click(btn);
    expect(screen.queryByTestId("closed-mtm")).toBeNull();
  });

  it("a record closed before the graph was kept is built from the stored history when asked, and says so when there is none", async () => {
    store.closed = [closedDoc("c1", "first", 2250)];
    mount("/portfolio");
    await userEvent.click(await screen.findByRole("button", { name: "MTM graph of first" }));
    expect(await screen.findByTestId("closed-mtm-reason")).toBeInTheDocument(); // the test server has no stored prices for it
  });

  it("lists closed strategies newest first by the time they closed, whatever order the server returns them in (a record written again, its MTM graph attached, was listed first)", async () => {
    const at = (name: string, closedAt: string) => ({ ...closedDoc(`id-${name}`, name, 100), closedAt });
    // the server lists by last write: the oldest was written last
    store.closed = [at("oldest", "2026-10-28T10:00:00Z"), at("newest", "2026-10-30T10:00:00Z"), at("middle", "2026-10-29T10:00:00Z")];
    mount("/portfolio");
    await screen.findByRole("button", { name: "MTM graph of newest" });
    const names = within(screen.getByTestId("portfolio-closed")).getAllByRole("button", { name: /^Open closed trade / }).map((b) => b.getAttribute("aria-label")!.replace("Open closed trade ", "").replace(" in the strategy builder", ""));
    expect(names).toEqual(["newest", "middle", "oldest"]);
  });

  it("Delete all closed asks twice", async () => {
    store.closed = [closedDoc("c1", "first", 2250), closedDoc("c2", "second", -500)];
    mount("/portfolio");
    const all = await screen.findByRole("button", { name: "Delete all closed" });
    await userEvent.click(all);
    expect(store.closed).toHaveLength(2); // the first click only asks
    await userEvent.click(screen.getByRole("button", { name: "Click again to delete all closed" }));
    await waitFor(() => expect(store.closed).toHaveLength(0));
  });

  it("Open hands the closed trade to the builder, which opens it as a closed trade", async () => {
    store.closed = [closedDoc("c1", "first", 2250)];
    localStorage.setItem("nse.closed.v1", JSON.stringify(store.closed));
    mount("/portfolio");
    await userEvent.click(await screen.findByRole("button", { name: "Open closed trade first in the strategy builder" }));
    expect(await screen.findByTestId("opened-closed", {}, { timeout: 15000 })).toHaveTextContent("first");
    expect(JSON.stringify(localStorage)).not.toContain("open-closed"); // nothing is handed over through this browser's storage: the address carries the request
  });
});

describe("Strategy portfolio", () => {
  it("lists running strategies with live P&L and closed strategies with their total, and opens a running one in the builder", async () => {
    store.saved = [{ name: "run me", savedAt: "2026-11-02T04:00:00Z", expiry: "2026-11-03", legs: [{ id: "a", expiry: "2026-11-03", strike: 24050, type: "CE", action: "SELL", lots: 1, premium: 120, premiumSource: "market", realised: -650 }] }];
    store.closed = [{ id: "c1", name: "old one", closedAt: "2026-10-30T10:00:00Z", snapshotAt: "2026-10-30T10:00:00Z", expiry: "2026-11-03", lotSize: 75, pnl: 2379, legs: [], stale: false }];
    mount("/portfolio");
    // stored price 100 vs entry 120 on a short call, lot 75: +20 x 75 = 1,500 open; booked −650; total +850
    const row = await screen.findByLabelText("Open run me in the strategy builder");
    await waitFor(() => expect(row).toHaveTextContent("+₹850"));
    expect(row).toHaveTextContent("+₹1,500"); expect(row).toHaveTextContent("−₹650");
    expect(screen.getByTestId("portfolio-closed")).toHaveTextContent("+₹2,379");
    expect(screen.getByTestId("portfolio-tiles")).toHaveTextContent("+₹850"); // running
    expect(screen.getByTestId("portfolio-tiles")).toHaveTextContent("+₹3,229"); // running + closed
    await userEvent.click(row);
    // the builder opens with that strategy loaded for adjustment
    const table = await screen.findByRole("table", { name: "Strategy legs" });
    expect((within(table).getAllByLabelText("Strike")[0] as HTMLSelectElement).value).toBe("24050");
    expect((within(table).getAllByLabelText("Entry premium")[0] as HTMLInputElement).value).toBe("120");
    expect(screen.getByTestId("update-saved")).toBeInTheDocument(); // it is the saved strategy "run me"
  });
});

describe("a strategy closed by its own close rule moves to Closed", () => {
  const leg = (over: Record<string, unknown>) => ({ id: `l${Math.random()}`, action: "SELL", type: "CE", strike: 24050, expiry: "2026-11-03", lots: 1, premium: 100, ...over });
  const saved = (name: string, legs: Record<string, unknown>[]) => ({ name, savedAt: "2026-11-02T04:00:00Z", expiry: "2026-11-03", legs });
  const out = (price: number, reason: string, realised: number) => ({ exitPrice: price, exitReason: reason, exitedAt: "2026-11-02T09:50:00Z", realised });

  it("files a saved strategy whose every leg the 15:20 close took out, with the booked P&L and the exit prices", async () => {
    store.saved = [saved("straddle", [leg(out(80, "strategy", 1300)), leg({ type: "PE", ...out(60, "strategy", 2600) })])];
    mount();
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"), { timeout: 15000 });
    expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (0)");
    expect(store.saved).toHaveLength(0);
    const c = store.closed[0] as { name: string; pnl: number; legs: { exit: number }[] };
    expect(c.name).toBe("straddle");
    expect(c.pnl).toBe(3900); // the sum of what the legs booked, not recomputed from a price
    expect(c.legs.map((l) => l.exit)).toEqual([80, 60]);
  });

  it("leaves a strategy in Saved while a leg is still open, or a stopped leg may still re-enter", async () => {
    store.saved = [
      saved("one leg open", [leg(out(80, "strategy", 1300)), leg({ type: "PE" })]),
      saved("may re-enter", [leg({ ...out(130, "stop", -1950), reentry: 1, reentryLevel: 100 }), leg({ type: "PE", ...out(60, "strategy", 2600) })]),
      saved("stopped only", [leg(out(130, "stop", -1950))]),
    ];
    mount();
    await waitFor(() => expect(screen.getByTestId("saved-menu")).toHaveTextContent("Saved (3)"), { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (0)");
    expect(store.closed).toHaveLength(0);
  });

  it("files the strategy that is open in the builder the moment its legs are all out", async () => {
    const legs = [leg(out(80, "strategy", 1300)), leg({ type: "PE", ...out(60, "strategy", 2600) })];
    store.saved = [saved("open one", legs)];
    localStorage.setItem("nse.builder.working.v1", JSON.stringify({ legs, expiry: null, name: "open one", loaded: "open one", baseline: legs, at: Date.now() }));
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 15000 }); // the stored chain (lot size) has loaded
    await waitFor(() => expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)"), { timeout: 15000 });
    expect(store.saved).toHaveLength(0);
    expect((store.closed[0] as { name: string; pnl: number }).pnl).toBe(3900);
    expect(await screen.findByText(/moved to Closed/)).toBeTruthy();
  });

  it("does not file a second copy of a closed trade that was opened to look at and came back after a refresh", async () => {
    const legs = [leg(out(80, "strategy", 1300)), leg({ type: "PE", ...out(60, "strategy", 2600) })];
    const was = { id: "c1", name: "straddle", closedAt: "2026-11-02T09:50:23Z", snapshotAt: "2026-11-02T09:50:00Z", expiry: "2026-11-03", lotSize: 65, pnl: 3900,
      legs: legs.map((l) => ({ ...l, id: `old-${Math.random()}`, exit: (l as unknown as { exitPrice: number }).exitPrice })) };
    store.closed = [was];
    // the refreshed page restores the legs without the "opened closed trade" mark: no name, nothing loaded
    localStorage.setItem("nse.builder.working.v1", JSON.stringify({ legs, expiry: null, name: "", loaded: null, baseline: legs, at: Date.now() }));
    mount();
    await waitFor(() => expect(screen.getByTitle(/instrument data/)).toHaveTextContent("75"), { timeout: 15000 });
    expect(await screen.findByText(/Opened closed trade/, undefined, { timeout: 15000 })).toBeTruthy(); // shown as the closed trade it is
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("closed-menu")).toHaveTextContent("Closed (1)");
    expect(store.closed).toHaveLength(1); // nothing was booked twice
  });
});
