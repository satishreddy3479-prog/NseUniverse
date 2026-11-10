import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconLabel, SwingLedgerPanel } from "../components/swing/SwingLedgerPanel";
import type { LedgerFill, SwingLedger } from "../lib/types";

afterEach(() => vi.unstubAllGlobals());

const fill = (o: Partial<LedgerFill>): LedgerFill => ({
  id: 1, session: "2026-11-09", order_id: 7, symbol: "KRISHANA", filled_at: "2026-11-09T04:15:01Z", price: 253.77, shares: 120, evidence: "price through the trigger; ltp 254.1",
  status: "open", last_price: 255.0, exit_price: null, exit_at: null, exit_reason: null, pnl: null, recon: "pending", recon_reason: null, official_fill: null, official_shares: null,
  price_gap: null, unrealised: 147.6, ...o,
});
const base: SwingLedger = { capital: 1_000_000, cash: 969_000, equity: 1_000_150, open: 1, closed: 1, realised_pnl: -310, enabled: true, reconciliation: { pending: 1, confirmed: 0, rejected: 1 }, fills: [] };
const view = (d: Partial<SwingLedger>) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...base, ...d }), { status: 200 })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SwingLedgerPanel /></QueryClientProvider>);
};

describe("live paper ledger panel", () => {
  it("words each reconciliation outcome", () => {
    expect(reconLabel(fill({}))).toBe("Awaiting tonight's official decision");
    expect(reconLabel(fill({ recon: "confirmed", official_fill: 253.5, official_shares: 110, price_gap: 0.27 }))).toContain("Confirmed: official fill 253.50 × 110 (price gap +0.27)");
    expect(reconLabel(fill({ recon: "rejected", recon_reason: "official book skipped it: volume 700,000 below the minimum 1,000,000" }))).toContain("volume 700,000 below the minimum");
  });
  it("says it is separate from the official book, shows an open fill awaiting reconciliation and a voided rejected one", async () => {
    view({ fills: [fill({}), fill({ id: 2, symbol: "MACPOWER", status: "closed", exit_price: 2410, exit_reason: "void: official book skipped it (volume short)", pnl: -310, unrealised: null, recon: "rejected", recon_reason: "official book skipped it: volume short" })] });
    expect((await screen.findByTestId("ledger-note")).textContent).toContain("never changed by anything on this panel");
    const rows = within(await screen.findByTestId("ledger-table")).getAllByTestId("ledger-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("MACPOWER"); // newest first
    expect(rows[0]!.textContent).toContain("void: official book skipped it");
    expect(rows[1]!.textContent).toContain("KRISHANA");
    expect(rows[1]!.textContent).toContain("(open)");
    expect(rows[1]!.textContent).toContain("Awaiting tonight's official decision");
    expect(screen.getByTestId("ledger-stats").textContent).toContain("0 confirmed · 1 rejected · 1 awaiting");
  });
  it("explains an empty ledger and a switched-off setting", async () => {
    view({ fills: [], enabled: false, open: 0, closed: 0, realised_pnl: 0, reconciliation: { pending: 0, confirmed: 0, rejected: 0 } });
    expect((await screen.findByTestId("ledger-empty")).textContent).toContain("fresh price");
    expect(screen.getByTestId("ledger-off").textContent).toContain("swing_live_fills_enabled");
  });
  it("shows an error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code: "ledger_unavailable", message: "the live paper ledger is not running" } }), { status: 503 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SwingLedgerPanel /></QueryClientProvider>);
    expect((await screen.findByTestId("ledger-error")).textContent).toContain("Could not read the live ledger");
  });
});
