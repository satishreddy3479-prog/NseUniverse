import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScoreChips } from "../components/ScoreChips";

const base = { available: true, session: "2026-11-16", at: "2026-11-16T05:04:00+00:00", age_s: 60, expiry: "2026-11-17", seller: 72.6, buyer: 38.4, regime: "volatility compression", seller_15m: 64.3, buyer_15m: 38.8 };
let payload: unknown;
function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ScoreChips /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("buyer and seller scores beside the NIFTY price", () => {
  it("shows the buyer score above the seller score, links to the straddle page, and explains itself in the tooltip", async () => {
    payload = base;
    mount();
    const chip = await screen.findByTestId("score-chips");
    expect(chip).toHaveAttribute("href", "/market-intelligence/straddle");
    const rows = chip.querySelectorAll(":scope > span");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("B38"); // buyer first
    expect(rows[1]).toHaveTextContent("S73"); // seller below it
    expect(within(chip).getByText("73")).toHaveClass("text-up"); // 60 or more
    expect(within(chip).getByText("38")).toHaveClass("text-muted"); // under 45
    expect(chip).toHaveAttribute("aria-label", "Buyer environment 38, seller environment 73: open the straddle intelligence");
    const title = chip.getAttribute("title")!;
    expect(title).toContain("Seller environment 73, up 8 in 15 min");
    expect(title).toContain("Buyer environment 38, down 0 in 15 min");
    expect(title).toContain("expiry 2026-11-17");
    expect(title).toContain("not a trade signal");
  });

  it("leaves the top bar as it was when there is no recent score", async () => {
    for (const p of [{ available: false }, { ...base, age_s: 20 * 60 }, { ...base, seller: undefined }]) {
      payload = p;
      const { container, unmount } = mount();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(container.querySelector("[data-testid=score-chips]")).toBeNull();
      unmount();
    }
  });

  it("says nothing about a change when the earlier score is missing", async () => {
    payload = { ...base, seller_15m: null, buyer_15m: null };
    mount();
    const chip = await screen.findByTestId("score-chips");
    expect(chip.getAttribute("title")).toContain("Seller environment 73\n");
    expect(chip.getAttribute("title")).not.toContain("in 15 min");
  });
});
