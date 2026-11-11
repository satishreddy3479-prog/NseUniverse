// The Rules tab documents every rule of the swing strategy and takes its numbers from the engine's own parameters.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SwingRules } from "../components/swing/SwingRules";
import type { SwingLiveParams, SwingParams, SwingReport } from "../lib/types";

const report = {
  caveats: ["Universe is today's Chartink list."],
  meta: { universe_fetched_at_utc: "2026-11-05T10:00:00Z", universe_size: 300, stocks_with_data: 290, generated_at_utc: "2026-11-05T11:00:00Z", data_through: "2026-11-05", period_start: "2023-01-02", price_basis: "adjusted", scan_clause: "( {cash} ( ... ) )" },
} as unknown as SwingReport;

const params: SwingParams = {
  capital: 1_000_000, slots: 5, risk_pct: 0.02, min_score: 65, trigger_buf: 1.003, vol_mult: 2.0, max_open_gap: 1.025, atr_sl_mult: 1.5, max_risk_frac: 0.945,
  be_r: 1.8, trail_r: 2.5, be_buf: 1.002, chand_mult: 2.5, cooldown: 3, cost_per_side: 0.0015, dist_min: -4.0, dist_max: 0.8, min_fetch_ratio: 0.9,
};
const live: SwingLiveParams = { entry_from_min: 570, entry_until_min: 900, day1_check_min: 920, chase_cap: 1.01, wick_fraction: 0.35, straight_line_judge_min: 585, poll_seconds: 2, stale_after_seconds: 120 };

describe("Swing rules tab", () => {
  it("has every section of the strategy", () => {
    render(<SwingRules report={report} />);
    for (const t of ["A trading day, step by step", "1 · Universe, data and safeguards", "2 · Which stocks qualify", "3 · Score 0-100, minimum 65", "4 · The order queued for the next session",
      "5 · Sizing, slots and costs", "6 · Exits (official daily book)", "7 · The live layers (research only, no orders)", "Rule version history", "Terms", "Limits of this test", "Where the data comes from"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    // the exact score points and gate tolerances
    const squeeze = screen.getByRole("region", { name: "Squeeze pillar" });
    expect(within(squeeze).getByText(/Bollinger Bands inside Keltner Channels: 12/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Trend template" })).getByText(/0\.80 × the 252-day high/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Day 1" })).getByText(/bottom 35%/)).toBeInTheDocument();
    expect(screen.getByText("Universe is today's Chartink list.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Engine parameters" })).toBeNull(); // no parameters reported: no table, no invented numbers
  });

  it("states the 2x volume requirement and shows the parameter table from the engine's values", () => {
    render(<SwingRules report={report} config={{ rule_version: "swing-v2", params, live }} />);
    expect(within(screen.getByRole("region", { name: "Order levels" })).getByText(/Minimum volume: 2 × the 20-day average/)).toBeInTheDocument();
    const t = screen.getByRole("table", { name: "Engine parameters" });
    expect(within(t).getByText("2 × 20-day average")).toBeInTheDocument();
    expect(within(t).getByText("pivot × 1.003")).toBeInTheDocument();
    expect(within(t).getByText("pivot × 1.025")).toBeInTheDocument();
    expect(within(t).getByText("-4% to +0.8%")).toBeInTheDocument();
    expect(within(t).getByText("0.15%")).toBeInTheDocument();
    expect(within(t).getByText("09:30-15:00")).toBeInTheDocument();
    expect(within(t).getByText("15:20")).toBeInTheDocument();
    expect(screen.getByText(/Every parameter \(rule version swing-v2\)/)).toBeInTheDocument();
  });

  it("follows a changed parameter instead of a hard-coded number", () => {
    render(<SwingRules report={report} config={{ rule_version: "swing-v3", params: { ...params, vol_mult: 3, slots: 4 }, live }} />);
    expect(within(screen.getByRole("region", { name: "Order levels" })).getByText(/Minimum volume: 3 × the 20-day average/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Engine parameters" })).getByText("3 × 20-day average")).toBeInTheDocument();
  });
});
