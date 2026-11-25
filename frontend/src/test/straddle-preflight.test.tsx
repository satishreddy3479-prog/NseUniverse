// The pre-flight radar card: renders what the backend returned, says plainly what has no data, never turns a missing input into a pass.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StraddlePreflightCard } from "../components/intelligence/StraddlePreflightCard";
import type { PreflightRadar, StraddleDecay } from "../lib/straddleDecay";

const NOTE = "Thresholds are provisional working values, not validated on enough recorded days; the gamma flip is a modelled level. A description of the straddle right now, not a trade signal.";
const setup = { strike: 25500, spot: 25500, combined_premium: 271.5, ce_price: 130, pe_price: 141.5, stop_loss_pts: 320.4, stop_loss_pct: 18, re_strike_pts: 35 };
const SQUEEZE = { id: "ACTIVE_SHORT_SQUEEZE", severity: "high", message: "Short squeeze in progress: NIFTY +0.22% in 15 minutes while futures open interest shed 40,000 units (615 lots). Do not sell at-the-money calls or straddles." };
const radar = (over: Partial<PreflightRadar> = {}): PreflightRadar => ({
  verdict: "ALL_CLEAR_TO_SELL", badge: "GREEN", headline: "ALL CLEAR — PREMIUMS DECAYING (OK TO SELL MANUALLY)",
  summary: "Premiums are decaying, IV is calm, no squeeze or trend flag is on and spot is above the modelled gamma flip.",
  gates: {
    premium_decay: { status: "PASS", label: "Decaying (-2.0 pts)", val_15m: -2 }, volatility_shock: { status: "PASS", label: "Stable (+0.10 vol)", val_15m: 0.1 },
    regime_squeeze: { status: "PASS", label: "Mean-reverting box (opening range 0.30x the daily move)", flags: [] }, structure_flip: { status: "PASS", label: "Spot +100 pts from flip (25400)", flip: 25400, spot: 25500 },
  },
  reasons: [], unknown: [], regime: { label: "DECAY_FAVOURED", ib_ratio: 0.3, flags: [] }, trade_setup: setup, note: NOTE, ...over,
});
const show = (p: PreflightRadar | null | undefined) => render(<StraddlePreflightCard d={{ preflight: p } as unknown as StraddleDecay} />);

describe("pre-flight entry radar", () => {
  it("green: four gates pass, the banner is green, and the action box is in points and rupees a lot (by hand)", () => {
    show(radar());
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("ALL CLEAR — PREMIUMS DECAYING (OK TO SELL MANUALLY)");
    expect(screen.getByTestId("preflight-badge")).toHaveAttribute("data-badge", "GREEN");
    expect(screen.getByTestId("preflight-badge").className).toContain("border-up");
    for (const id of ["pf-premium", "pf-iv", "pf-regime", "pf-gamma"]) expect(screen.getByTestId(`${id}-status`)).toHaveTextContent("PASS");
    expect(screen.getByTestId("pf-premium")).toHaveTextContent("Premium momentum (15m)");
    expect(screen.getByTestId("pf-premium")).toHaveTextContent("−2.0 pts");
    expect(screen.getByTestId("pf-iv")).toHaveTextContent("Volatility velocity (15m)");
    expect(screen.getByTestId("pf-iv")).toHaveTextContent("+0.10 vol pts");
    expect(screen.getByTestId("pf-regime")).toHaveTextContent("09:45 regime / squeeze");
    expect(screen.getByTestId("pf-regime")).toHaveTextContent("IB 0.30× daily move");
    expect(screen.getByTestId("pf-gamma")).toHaveTextContent("Gamma flip distance");
    expect(screen.getByTestId("pf-gamma")).toHaveTextContent("+100 pts");
    expect(screen.getByTestId("pf-gamma-label")).toHaveTextContent("Spot +100 pts from flip (25400)");
    expect(screen.getByTestId("pf-strike")).toHaveTextContent("ATM strike 25,500 ATM");
    expect(screen.getByTestId("pf-premium-now")).toHaveTextContent("271.5 pts (₹17,648 a lot)"); // 271.5 x 65 = 17,647.5
    expect(screen.getByTestId("pf-stop")).toHaveTextContent("Hard stop (+18%) 320.4 pts");
    expect(screen.getByTestId("pf-stop")).toHaveTextContent("about ₹3,178 a lot lost"); // (320.4 - 271.5) x 65 = 3,178.5 (48.9 is 48.899... in floating point): shown as "about"
    expect(screen.getByTestId("pf-restrike")).toHaveTextContent("Re-strike alert if spot moves ±35 pts");
    expect(screen.getByTestId("preflight-trade")).toHaveTextContent("Reference levels · provisional");
    expect(screen.getByTestId("preflight-note")).toHaveTextContent("provisional working values");
    expect(screen.queryByTestId("preflight-flags")).toBeNull();
  });

  it("red: a short squeeze names itself in the banner, lists the regime flag and labels the levels as reference only", () => {
    show(radar({
      verdict: "BLOCKED", badge: "RED", headline: "DO NOT SELL — SHORT SQUEEZE & GAMMA CONVEXITY DETECTED", summary: "Short squeeze in progress. Realised convexity (+16.0 pts) is overwhelming theta (10.0 pts).",
      gates: { ...radar().gates, regime_squeeze: { status: "FAIL", label: "Active squeeze / trend", flags: ["ACTIVE_SHORT_SQUEEZE"] } },
      reasons: ["SHORT SQUEEZE", "GAMMA CONVEXITY"], regime: { label: "TREND_RISK", ib_ratio: null, flags: [SQUEEZE] },
    }));
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("DO NOT SELL — SHORT SQUEEZE & GAMMA CONVEXITY DETECTED");
    expect(screen.getByTestId("preflight-badge").className).toContain("border-down");
    expect(screen.getByTestId("pf-regime-status")).toHaveTextContent("FAIL");
    expect(screen.getByTestId("pf-regime-label")).toHaveTextContent("Active squeeze / trend");
    expect(screen.getByTestId("pf-regime")).toHaveTextContent("1 flag"); // no opening-range ratio: the flag count stands in
    expect(within(screen.getByTestId("preflight-flags")).getByText(/Short squeeze in progress: NIFTY \+0.22%/)).toBeTruthy();
    expect(screen.getByTestId("preflight-summary")).toHaveTextContent("overwhelming theta (10.0 pts)");
    expect(screen.getByTestId("preflight-trade")).toHaveTextContent("Reference levels (the radar says do not sell)");
  });

  it("red for a rising premium and an IV spike shows both gates failing with their numbers", () => {
    show(radar({
      verdict: "BLOCKED", badge: "RED", headline: "DO NOT SELL — PREMIUM EXPANSION & IV SPIKE DETECTED", summary: "Premiums are expanding (+4.9 pts in 15 min). ATM IV is spiking (+0.80 vol points in 15 min).",
      gates: { ...radar().gates, premium_decay: { status: "FAIL", label: "Expanding (+4.9 pts)", val_15m: 4.9 }, volatility_shock: { status: "FAIL", label: "IV spike (+0.80 vol)", val_15m: 0.8 } },
      reasons: ["PREMIUM EXPANSION", "IV SPIKE"],
    }));
    expect(screen.getByTestId("pf-premium-status")).toHaveTextContent("FAIL");
    expect(screen.getByTestId("pf-premium")).toHaveTextContent("+4.9 pts");
    expect(screen.getByTestId("pf-iv-status")).toHaveTextContent("FAIL");
    expect(screen.getByTestId("pf-iv")).toHaveTextContent("+0.80 vol pts");
  });

  it("yellow: below the gamma flip or a rising put floor is a warning, not a failure", () => {
    show(radar({
      verdict: "SELECTIVE", badge: "YELLOW", headline: "SELECTIVE / CAUTION", summary: "Spot is below the modelled gamma flip, where moves tend to amplify.",
      gates: { ...radar().gates, structure_flip: { status: "WARN", label: "Spot -20 pts from flip (25400)", flip: 25400, spot: 25380 } },
    }));
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("SELECTIVE / CAUTION");
    expect(screen.getByTestId("pf-gamma-status")).toHaveTextContent("WARN");
    expect(screen.getByTestId("pf-gamma")).toHaveTextContent("−20 pts");
    expect(screen.getByTestId("preflight-badge").className).toContain("border-brass");
  });

  it("grey: a gate with no data says so and shows a dash, and there is no all-clear", () => {
    show(radar({
      verdict: "INCOMPLETE", badge: "GREY", headline: "NO ALL-CLEAR — INCOMPLETE DATA", summary: "Nothing fails, but not every gate could be read (regime_squeeze, structure_flip): no all-clear.",
      unknown: ["regime_squeeze", "structure_flip"],
      gates: { ...radar().gates, regime_squeeze: { status: "UNKNOWN", label: "No squeeze or regime reading yet" }, structure_flip: { status: "UNKNOWN", label: "No modelled gamma flip", flip: null, spot: 25500 } },
      regime: { label: "NO_DATA", ib_ratio: null, flags: [] },
    }));
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("NO ALL-CLEAR — INCOMPLETE DATA");
    expect(screen.getByTestId("pf-regime-status")).toHaveTextContent("NO DATA");
    expect(screen.getByTestId("pf-gamma-status")).toHaveTextContent("NO DATA");
    expect(within(screen.getByTestId("pf-gamma")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("pf-regime")).getByText("—")).toBeTruthy();
    expect(screen.getByTestId("pf-gamma-label")).toHaveTextContent("No modelled gamma flip");
    expect(screen.getByTestId("preflight-title")).not.toHaveTextContent("ALL CLEAR —");
  });

  it("a stored or stale session shows no gates, only the reason and the reference levels", () => {
    show(radar({ verdict: "NO_LIVE_DATA", badge: "GREY", headline: "NO LIVE READING", summary: "No live reading: the newest stored sample is 377.0 minutes old.", gates: {} }));
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("NO LIVE READING");
    expect(screen.queryByTestId("preflight-gates")).toBeNull();
    expect(screen.getByTestId("preflight-summary")).toHaveTextContent("377.0 minutes old");
    expect(screen.getByTestId("pf-strike")).toHaveTextContent("25,500 ATM");
  });

  it("missing trade prices show dashes, and no card is drawn without a radar", () => {
    show(radar({ trade_setup: { ...setup, strike: null, combined_premium: null, stop_loss_pts: null } }));
    expect(screen.getByTestId("pf-strike")).toHaveTextContent("ATM strike —");
    expect(screen.getByTestId("pf-premium-now")).toHaveTextContent("Total premium —");
    expect(screen.getByTestId("pf-stop")).toHaveTextContent("Hard stop (+18%) —");
    expect(screen.getByTestId("pf-stop")).not.toHaveTextContent("lost");
  });

  it("draws nothing when there is no radar", () => {
    const none = show(null);
    expect(none.container.textContent).toBe("");
  });
});

describe("the seller environment tile", () => {
  it("shows the score, the class and what costs the most points when the card is yellow because of it", () => {
    show(radar({
      verdict: "SELECTIVE", badge: "YELLOW", headline: "SELECTIVE / CAUTION", summary: "The seller environment score is 36 (Unfavourable): Realised versus implied vol -6.4; Underlying movement vs break-even -5.3.",
      gates: { ...radar().gates, seller_environment: { status: "WARN", label: "Seller environment Unfavourable (36)", score: 35.5, top: ["Realised versus implied vol -6.4", "Underlying movement vs break-even -5.3"] } },
    }));
    expect(screen.getByTestId("preflight-badge")).toHaveAttribute("data-badge", "YELLOW");
    expect(screen.getByTestId("pf-seller-status")).toHaveTextContent("WARN");
    expect(screen.getByTestId("pf-seller")).toHaveTextContent("36 / 100");
    expect(screen.getByTestId("pf-seller-label")).toHaveTextContent("Unfavourable");
    expect(screen.getByTestId("pf-seller-top")).toHaveTextContent("Costs most: Realised versus implied vol -6.4; Underlying movement vs break-even -5.3");
  });

  it("an older payload without the gate shows the four tiles as before", () => {
    show(radar());
    expect(screen.queryByTestId("pf-seller")).toBeNull();
  });
});
