// Market Structure page: figures come from the section endpoints, the regime only combines them. Numbers are formula checks, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketStructureBody } from "../components/MarketStructure";
import { toolById } from "../lib/tools";

afterEach(() => vi.unstubAllGlobals());

const b = (ce_change: number | null, pe_change: number | null) => ({ ce_now: 14, ce_then: 13, ce_change, pe_now: 15, pe_then: 14.5, pe_change, momentum: ce_change != null && pe_change != null ? ce_change - pe_change : null });
const emptyB = { ce_now: null, ce_then: null, ce_change: null, pe_now: null, pe_then: null, pe_change: null, momentum: null };
const skew = { status: "ok", expiry: "2026-11-10", at: "2026-11-09T09:30:00+05:30", age_seconds: 20, spot: 24000, forward: 24010, atm_strike: 24000, atm_iv: 15, days: 1,
  cards: { skew_25d: -0.5, skew_10d: 1, call_minus_put_25d: 0.5, call_minus_put_10d: -1, butterfly_25d: 0.4, butterfly_10d: 0.8, slope_per_pct: -1, put_25d_iv: 15, call_25d_iv: 15.5, put_10d_iv: 16, call_10d_iv: 15, term_slope_per_30d: 1.2 },
  smile: [], term: [], term_structure: { slope_per_30d: 1.2, shape: "contango", near: null, far: null, pairs: [], left_out: [] } };
const mom = { status: "ok", expiry: "2026-11-10", session: "2026-11-09", tf_minutes: 1, samples_in_session: 20, previous_session: null, latest_at: "2026-11-09T09:30:00+05:30", age_seconds: 20, excluded: 0,
  table: { now: "x", periods: { "15": { from: "y", spot_change: 72, spot_change_pct: 0.3, atm: b(0.7, 0.5), d25: b(0.7, 0.2), d10: emptyB } }, previous_close: null }, series: [], model: "", rate_assumed: 0.065 };
const pos = { status: "ok", expiry: "2026-11-10", at: "x", then_at: "y", age_seconds: 20, spot: 24000, spot_then: 23928, spot_change_pct: 0.3, atm_strike: 24000, atm_strike_then: 24000, samples_in_session: 20, note: null, rows: [], baskets: [],
  demand: [{ side: "CE", group: "otm", label: "Upside speculation", evidence: { label: "Upside speculation", met: [], unmet: [], score: 4, of: 5 }, summary: { strikes: 5, oi: 1, oi_change: 1, oi_pct: 4, premium_pct: 12, iv_change: 0.8, volume_change: 10, missing: 0 } }] };
const chart = { window: 21, dates: ["2026-11-06", "2026-11-09"], close: [24000, 24010], iv: [14, 15], hv: [10, 11], rv: [9, 10], nifty_bars: 2, vix_bars: 2, days: 2, iv_source: "vix", method: "" };

describe("Market Structure", () => {
  it("is a ready page tool", () => expect(toolById("market-structure")?.page).toBe("marketstructure"));
  it("combines the section figures into a regime with supporting evidence, and reports what could not be evaluated", async () => {
    const routes: Record<string, unknown> = { "/api/intraday/iv-skew": skew, "/api/intraday/iv-momentum": mom, "/api/intraday/strike-positioning": pos, "/api/intraday/iv-chart": chart };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { const u = String(input); const hit = Object.entries(routes).find(([k]) => u.startsWith(k)); return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 }); }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MarketStructureBody expiry="2026-11-10" /></QueryClientProvider>);
    // bull: spot_up, mom_up, skew_call (-0.5 <= 0), ce_spec = 4; bear 0; ATM IV change (0.7 + 0.5) / 2 = +0.6 -> expanding
    expect((await screen.findByTestId("ms-regime")).textContent).toBe("Bullish volatility expansion");
    expect(screen.getByTestId("ms-support").textContent).toContain("NIFTY up more than 0.1%");
    expect(screen.getByTestId("ms-unavail").textContent).toContain("net GEX");
    expect(screen.getByTestId("ms-warnings").textContent).toContain("GEX needs the option chain");
    expect(screen.getByTestId("ms-confidence").textContent).toContain("not a probability");
    expect(screen.getByTestId("ms-demand").textContent).toContain("Upside speculation");
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
    const cards = screen.getAllByTestId("ms-card").map((c) => c.textContent).join("|");
    expect(cards).toContain("India VIX15.00%");
    expect(cards).toContain("HV 1M11.00%");
  });
});
