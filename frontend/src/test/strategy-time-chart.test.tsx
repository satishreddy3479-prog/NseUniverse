// The strategy price chart component: what it asks for, what it shows, and its empty states.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrategyTimeChart } from "../components/StrategyTimeChart";
import { NO_RULES } from "../lib/strategy";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} />;
  },
}));
afterEach(() => vi.unstubAllGlobals());

const times = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 10, 11, 3, 45 + i)).toISOString());
const ce = times.map((_, i) => 200 + (i % 5));
const pe = times.map((_, i) => 100 - (i % 3));
const body = { underlying: "NIFTY", expiry: "2026-11-17", strikes: [25000], atm_strike: 25000, times, spot: times.map((_, i) => 25000 + i), ce_price: { "25000": ce }, pe_price: { "25000": pe }, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {}, ce_volume: { "25000": times.map((_, i) => 100 * (i + 1)) }, pe_volume: { "25000": times.map((_, i) => 50 * (i + 1)) }, stride: 1, warnings: [], definitions: {} };
const fut = { day: "2026-11-11", contract: "NIFTY", expiry: "2026-11-24", rate_assumed: 6, times, future: times.map((_, i) => 25050 + i), spot: [], spot_source: [], basis: [], basis_pct: [], carry_pct: [], fair_basis: [], vs_fair: [], oi: [], oi_change: [], oi_per_min: [], volume: [], volume_per_min: times.map(() => 1000), oi_baseline: null, latest: null, warnings: [], definitions: {} };

type L = { strike: number; type: "CE" | "PE"; action: "BUY" | "SELL"; lots: number; premium: number | null; expiry: string };
function mount(legs: L[] = [{ strike: 25000, type: "CE", action: "SELL", lots: 1, premium: 200, expiry: "2026-11-17" }, { strike: 25000, type: "PE", action: "SELL", lots: 1, premium: 100, expiry: "2026-11-17" }], seen: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    seen.push(String(u));
    const json = String(u).includes("strike-series") ? body : fut;
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StrategyTimeChart legs={legs} expiry="2026-11-17" lotSize={65} modelDelta={-3} rules={{ ...NO_RULES, sl: 5000 }} /></QueryClientProvider>);
}

describe("StrategyTimeChart", () => {
  it("asks for exactly the strikes of the legs and draws the strategy with its overlays", async () => {
    const seen: string[] = [];
    mount(undefined, seen);
    const main = await screen.findByRole("img", { name: /Strategy price against NIFTY spot and future/ });
    expect(main.getAttribute("data-series")).toContain("Cost to close|NIFTY spot|NIFTY future|Future VWAP|Strategy VWAP");
    expect(seen.some((u) => u.includes("strike-series") && u.includes("strikes=25000"))).toBe(true);
    const sum = screen.getByLabelText("Strategy summary");
    expect(within(sum).getByText("Now")).toBeInTheDocument();
    expect(screen.getByTestId("stl-note")).toHaveTextContent("−1×25,000CE");
    expect(screen.getByTestId("stl-note")).toHaveTextContent("Strategy VWAP combines each leg");
  });
  it("switches to P&L", async () => {
    mount();
    await screen.findByTestId("stl-main");
    await userEvent.click(screen.getByRole("button", { name: "P&L ₹" }));
    expect(await screen.findByRole("img", { name: /Strategy P&L against NIFTY spot and future/ })).toBeInTheDocument();
  });
  it("says so with no legs of the selected expiry", () => {
    mount([{ strike: 25000, type: "CE", action: "BUY", lots: 1, premium: 1, expiry: "2026-11-24" }]);
    expect(screen.getByTestId("stl-empty")).toBeInTheDocument();
  });
});
