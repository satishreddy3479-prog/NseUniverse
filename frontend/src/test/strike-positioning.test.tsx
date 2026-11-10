// Strike Positioning page renders what the backend computed; numbers are hand arithmetic, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basketExample, demandExample, positioningExample, StrikePositioningBody } from "../components/StrikePositioning";
import { toolById } from "../lib/tools";
import type { PositioningBasket, PremiumBaskets, PositioningQuote, StrikePositioning } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

const quote = (o: Partial<PositioningQuote> = {}): PositioningQuote => ({
  premium: null, premium_then: null, premium_change: null, premium_pct: null, oi: null, oi_then: null, oi_change: null, oi_pct: null, oi_session_change: null, oi_session_pct: null,
  volume: null, volume_change: null, iv: null, iv_then: null, iv_change: null, delta: null, class: "insufficient data", ...o,
});
const ce24000 = quote({ premium: 120, premium_then: 100, premium_change: 20, premium_pct: 20, oi: 110_000, oi_then: 100_000, oi_change: 10_000, oi_pct: 10, delta: 0.52, class: "potential long buildup" });
const basket = (kind: "fixed" | "dynamic", ratio: number | null): PositioningBasket => ({
  window: 10, kind, strikes: 21,
  ce: { now: 52, then: 46, change: 6, pct: 13.04, ratio: 1.13, strikes: 21 }, pe: { now: 16, then: 25, change: -9, pct: -36, ratio: 0.64, strikes: 21 },
  asymmetry: { ratio, note: ratio == null ? "missing" : null },
});
const data: StrikePositioning = {
  status: "ok", expiry: "2026-11-10", session: "2026-11-09", window: "15", at: "2026-11-09T09:30:00+05:30", then_at: "2026-11-09T09:15:00+05:30", age_seconds: 30, spot: 24010, spot_then: 24000, spot_change_pct: 0.0417,
  atm_strike: 24000, atm_strike_then: 24000, samples_in_session: 16, note: null,
  rows: [{ strike: 24000, ce: ce24000, pe: quote({ premium: 80, premium_then: 100, premium_pct: -20, oi: 90_000, oi_then: 95_000, oi_pct: -5.26, delta: -0.48, class: "potential long unwinding" }) }],
  baskets: [basket("fixed", 1.5), basket("dynamic", null)],
  demand: [{ side: "CE", group: "otm", label: "INSUFFICIENT EVIDENCE", evidence: null, summary: { strikes: 0, oi: 0, oi_change: 0, oi_pct: null, premium_pct: null, iv_change: null, volume_change: null, missing: 0 } }],
};

const P = (at: string, spot: number, ce: number, pe: number, o: object = {}) => ({ at, spot, strikes: 21, ce, pe, ce_n: 21, pe_n: 21, ce_mean: ce / 21, pe_mean: pe / 21, ce_idx: null, pe_idx: null, ce_change: null, pe_change: null, ce_pct: null, pe_pct: null, asymmetry: { ratio: null, note: "first snapshot" }, ...o });
const prem: PremiumBaskets = {
  status: "ok", expiry: "2026-11-10", session: "2026-11-09", kind: "fixed", window: 10, snapshots: 2, age_seconds: 20, latest_at: "2026-11-09T09:30:00+05:30", basket: "ATM ±10 fixed at the first snapshot ATM",
  points: [P("2026-11-09T09:15:00+05:30", 24000, 46, 25, { ce_idx: 100, pe_idx: 100, ce_change: 0, pe_change: 0, ce_pct: 0, pe_pct: 0 }),
    P("2026-11-09T09:30:00+05:30", 24030, 52, 16, { ce_idx: 113.04, pe_idx: 64, ce_change: 6, pe_change: -9, ce_pct: 13.04, pe_pct: -36, asymmetry: { ratio: 1.5, note: null } })],
};
const routed = (url: string) => new Response(JSON.stringify(url.includes("/premium-baskets") ? prem : data), { status: 200 });

describe("Strike Positioning", () => {
  it("is a ready page tool", () => expect(toolById("strike-positioning")?.page).toBe("strikepos"));
  it("worked examples are built from the figures shown", () => {
    expect(positioningExample(data).join("\n")).toContain("24000 CE: premium 100.00 → 120.00: change = +20.00, % = (120.00 / 100.00 − 1) × 100 = +20.00%");
    expect(positioningExample(data).join("\n")).toContain("→ potential long buildup");
    expect(basketExample(data.baskets).join("\n")).toContain("Asymmetry = 9.00 / 6.00 = 1.5000");
    expect(demandExample(data.demand).join("\n")).toContain("INSUFFICIENT EVIDENCE");
  });
  it("shows the strike table, both baskets with a missing ratio left missing, INSUFFICIENT EVIDENCE and closed methodology panels", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => routed(String(input))));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StrikePositioningBody expiry="2026-11-10" /></QueryClientProvider>);
    const table = await screen.findByTestId("pos-table");
    expect(table.textContent).toContain("24,000 ATM");
    expect(table.textContent).toContain("long buildup");
    const rows = within(screen.getByTestId("basket-table")).getAllByTestId("basket-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("fixed");
    expect(rows[0]!.textContent).toContain("1.50");
    expect(rows[1]!.textContent).toContain("—");
    expect(screen.getByTestId("demand-card").textContent).toContain("INSUFFICIENT EVIDENCE");
    for (const d of screen.getAllByTestId("methodology")) expect((d as HTMLDetailsElement).open).toBe(false);
    expect(screen.getAllByTestId("methodology").length).toBeGreaterThanOrEqual(3);
    expect((await screen.findByTestId("prem-cards")).textContent).toContain("+13.04%"); // CE % change
    expect(screen.getByTestId("prem-cards").textContent).toContain("1.50"); // asymmetry 9 / 6
    expect(screen.getByTestId("prem-kind").textContent).toContain("fixed");
    expect(screen.getByTestId("prem-chart")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dynamic (recentred)" }));
    await screen.findByTestId("prem-chart");
    expect(screen.getAllByTestId("methodology").length).toBeGreaterThanOrEqual(4);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("pos-table")).toBeTruthy();
  });
});
