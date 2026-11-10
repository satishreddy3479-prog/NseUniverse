// Strike Positioning page renders what the backend computed; numbers are hand arithmetic, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basketExample, demandExample, positioningExample, StrikePositioningBody } from "../components/StrikePositioning";
import { toolById } from "../lib/tools";
import type { PositioningBasket, PositioningQuote, StrikePositioning } from "../lib/types";

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

describe("Strike Positioning", () => {
  it("is a ready page tool", () => expect(toolById("strike-positioning")?.page).toBe("strikepos"));
  it("worked examples are built from the figures shown", () => {
    expect(positioningExample(data).join("\n")).toContain("24000 CE: premium 100.00 → 120.00: change = +20.00, % = (120.00 / 100.00 − 1) × 100 = +20.00%");
    expect(positioningExample(data).join("\n")).toContain("→ potential long buildup");
    expect(basketExample(data.baskets).join("\n")).toContain("Asymmetry = 9.00 / 6.00 = 1.5000");
    expect(demandExample(data.demand).join("\n")).toContain("INSUFFICIENT EVIDENCE");
  });
  it("shows the strike table, both baskets with a missing ratio left missing, INSUFFICIENT EVIDENCE and closed methodology panels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
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
    expect(screen.getAllByTestId("methodology")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("pos-table")).toBeTruthy();
  });
});
