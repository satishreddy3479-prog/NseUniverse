import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { dayChange, sumOi } from "../components/ChainTable";
import { bigChain, chain, expiries, status } from "./fixtures";

function setup(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input);
    calls.push(`${init?.method ?? "GET"} ${full}`);
    const key = full.split("?")[0]!;
    const h = routes[key];
    return h ? h() : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/option-chain"]}><AppRoutes /></MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const base = {
  "/api/status": ok(status()),
  "/api/expiries": ok(expiries),
  "/api/snapshots": ok([]),
};

afterEach(() => vi.unstubAllGlobals());

describe("dayChange", () => {
  it("is defined only with both prices and positive previous close", () => {
    const q = bigChain().snapshot.rows[0]!.call!;
    expect(dayChange({ ...q, ltp: 110, prev_close: 100 })).toEqual({ abs: 10, pct: 10 });
    expect(dayChange({ ...q, ltp: null })).toBeNull();
    expect(dayChange({ ...q, prev_close: 0 })).toBeNull();
    expect(dayChange(null)).toBeNull();
  });
});

describe("sumOi", () => {
  const rows = bigChain().snapshot.rows;
  it("adds OI and OI change per side", () => {
    expect(sumOi(rows, "call")).toEqual({ oi: 7000, oiChange: 700, missingOi: 0, missingChange: 0 });
    expect(sumOi(rows, "put")).toEqual({ oi: 7000, oiChange: 700, missingOi: 0, missingChange: 0 });
  });
  it("skips missing values and counts them instead of treating them as zero", () => {
    const r = structuredClone(rows);
    r[0]!.call!.oi = null;
    r[1]!.call!.oi_change = null;
    expect(sumOi(r, "call")).toEqual({ oi: 6000, oiChange: 600, missingOi: 1, missingChange: 1 });
  });
  it("is null when nothing has a value", () => {
    const r = structuredClone(rows);
    for (const x of r) { x.call!.oi = null; x.call!.oi_change = null; }
    expect(sumOi(r, "call")).toMatchObject({ oi: null, oiChange: null });
    expect(sumOi([], "put")).toMatchObject({ oi: null, oiChange: null });
  });
});

describe("Live option chain page", () => {
  it("renders strikes, marks ATM, and shows missing values as dashes", async () => {
    setup({ ...base, "/api/option-chain": ok(bigChain()) });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    expect(within(table).getByText("ATM")).toBeInTheDocument();
    expect(within(table).getByText("24,050")).toBeInTheDocument();
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText(/Base snapshot retrieved/)).toBeInTheDocument();
    expect(screen.getByText(/Exchange timestamp is not provided/)).toBeInTheDocument();
  });

  it("limits strikes around ATM and can show all", async () => {
    setup({ ...base, "/api/option-chain": ok(bigChain()) });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    expect(within(table).getByText("23,900")).toBeInTheDocument(); // ±10 covers all 7 rows
    await userEvent.selectOptions(screen.getByLabelText("Strike range"), "5");
    expect(within(table).getByText("23,900")).toBeInTheDocument(); // ±5 still covers 7 rows
    expect(screen.getByText(/7 of 7 strikes shown/)).toBeInTheDocument();
  });

  it("filters by strike text and hides calls or puts", async () => {
    setup({ ...base, "/api/option-chain": ok(bigChain()) });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    await userEvent.type(screen.getByLabelText("Filter strikes"), "241");
    expect(within(table).queryByText("23,900")).not.toBeInTheDocument();
    expect(within(table).getByText("24,100")).toBeInTheDocument();
    expect(screen.getByText(/hidden by filters/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Calls"));
    expect(within(table).queryByText("Calls (CE)")).not.toBeInTheDocument();
    expect(within(table).getByText("Puts (PE)")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Puts"));
    expect(await screen.findByText("Calls and puts are both hidden")).toBeInTheDocument();
  });

  it("shows total OI and OI change for calls and puts, and for all strikes when filtered", async () => {
    setup({ ...base, "/api/option-chain": ok(bigChain()) });
    const table = await screen.findByRole("table", { name: /Option chain/ });
    const foot = () => within(table).getAllByRole("row").filter((r) => r.textContent?.includes("Total"));
    expect(foot()).toHaveLength(1);
    expect(foot()[0]!.textContent).toContain("7,000");
    expect(foot()[0]!.textContent).toContain("+700");
    await userEvent.type(screen.getByLabelText("Filter strikes"), "241");
    const rowsNow = foot();
    expect(rowsNow).toHaveLength(2);
    expect(rowsNow[0]!.textContent).toContain("Total, 2 shown");
    expect(rowsNow[0]!.textContent).toContain("2,000");
    expect(rowsNow[0]!.textContent).toContain("+200");
    expect(rowsNow[1]!.textContent).toContain("Total, all 7");
    expect(rowsNow[1]!.textContent).toContain("7,000");
  });

  it("offers a fetch button when no snapshot exists, and fetches only that expiry", async () => {
    const calls = setup({
      ...base,
      "/api/option-chain": () => new Response(JSON.stringify({ detail: { code: "no_snapshot", message: "none" } }), { status: 404 }),
      "/api/snapshots/capture": ok([]),
    });
    await screen.findByText("No snapshot for this expiry yet");
    await userEvent.click(screen.getByRole("button", { name: "Fetch option chain" }));
    expect(calls.some((c) => c.startsWith("POST /api/snapshots/capture?expiry=2026-11-03"))).toBe(true);
  });

  it("switches between weekly and monthly expiries", async () => {
    const calls = setup({ ...base, "/api/option-chain": ok(chain()) });
    await screen.findByRole("table", { name: /Option chain/ });
    await userEvent.click(screen.getByRole("button", { name: /Monthly/ }));
    expect(calls.some((c) => c.includes("/api/option-chain?expiry=2026-11-24"))).toBe(true);
    expect(screen.getByRole("button", { name: /Monthly/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("flags stored and stale snapshots instead of calling them live", async () => {
    setup({ ...base, "/api/option-chain": ok({ ...bigChain(), display_source: "stored" }) });
    expect(await screen.findByText(/not current prices/)).toBeInTheDocument();
  });

});
