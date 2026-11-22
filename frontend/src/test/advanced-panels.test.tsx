import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdvancedPanels } from "../components/risk/AdvancedPanels";
import { buildPosition } from "../lib/builderPosition";
import { black76, expiryEnd } from "../lib/optionModel";
import type { Leg } from "../lib/strategy";

const EXP = "2026-12-29", S = 25300, now = Date.UTC(2026, 10, 23, 5, 0, 0), r = 0.06, c = 0.06, iv = 0.16;
const T = (expiryEnd(EXP) - now) / (365 * 86_400_000);
const P = (type: "CE" | "PE", k: number) => Math.round(black76(type, S * Math.exp(c * T), k, T, iv, r) * 100) / 100;
const strikes = Array.from({ length: 21 }, (_, i) => 24300 + i * 100);
const rows = strikes.map((k) => ({ strike: k, call: { ltp: P("CE", k), oi: 100_000 } as never, put: { ltp: P("PE", k), oi: 100_000 } as never }));
const leg = (o: Partial<Leg>): Leg => ({ id: "x", expiry: EXP, strike: 25300, type: "CE", action: "SELL", lots: 1, premium: 400, premiumSource: "market", ...o }) as Leg;
const doc = [leg({ id: "c" }), leg({ id: "p", type: "PE" }), leg({ id: "f", type: "FUT", strike: 0, action: "BUY", premium: 25300 }), leg({ id: "gone", strike: 25500, exitPrice: 10 }), leg({ id: "off", strike: 25600, enabled: false })];

describe("the Builder's strategy as a position", () => {
  const pos = buildPosition(doc, [{ expiry: EXP, rows, spot: S }], now, r, 65, 2);
  it("keeps the open ticked legs only, signs quantity (sold lots x multiplier x lot size negative) and reads each option's own volatility from its stored price", () => {
    expect(pos.legs.map((l) => l.id)).toEqual(["c", "p", "f"]);
    expect(pos.legs.map((l) => l.qty)).toEqual([-130, -130, 130]);
    expect(pos.legs[0]!.iv).toBeCloseTo(iv, 2);
    expect(pos.legs[2]!.iv).toBeNull();
    expect(pos.unvalued).toEqual([]);
  });
  it("without a lot size there is no position, not a guessed one", () => {
    expect(buildPosition(doc, [{ expiry: EXP, rows, spot: S }], now, r, null).legs).toEqual([]);
  });
  it("a strike with no stored price keeps iv null and is named", () => {
    const p = buildPosition([leg({ strike: 30000 })], [{ expiry: EXP, rows, spot: S }], now, r, 65);
    expect(p.legs[0]!.iv).toBeNull(); expect(p.unvalued).toEqual(["30000 CE 2026-12-29"]);
  });
});

describe("Advanced panels", () => {
  const pos = buildPosition(doc, [{ expiry: EXP, rows, spot: S }], now, r, 65, 1);
  const closes = Array.from({ length: 22 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, close: 25000 * (1 + 0.004 * Math.sin(i)) }));
  const props = { pos, nowMs: now, rate: r, lotSize: 65, rows: { [EXP]: rows as never }, closes, entryLevel: () => null, nowPrice: () => null };
  it("renders every section for a short straddle with a long future, with the model's labels", () => {
    render(<AdvancedPanels {...props} />);
    for (const id of ["adv-ladder", "adv-hedge", "adv-breakeven", "adv-greeks", "adv-vega", "adv-attribution", "adv-smile", "adv-implied-realised", "adv-exposure", "adv-var", "adv-stress", "adv-unavailable"]) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.getByTestId("adv-assumptions")).toHaveTextContent("Black-76");
    expect(within(screen.getByTestId("adv-var")).getByText(/not a forecast/)).toBeInTheDocument();
    expect(screen.getByTestId("adv-reverse")).toBeInTheDocument();
    expect(screen.getByTestId("adv-replay")).toBeInTheDocument();
  });
  it("the ladder's centre row has zero P&L and the hedge now equals minus net delta over the lot", () => {
    render(<AdvancedPanels {...props} />);
    const centre = within(screen.getByTestId("adv-ladder")).getAllByRole("row").find((x) => x.textContent?.startsWith("0 %"))!;
    expect(centre).toHaveTextContent("0 %");
    expect(within(centre).getAllByRole("cell")[2]).toHaveTextContent("0");
  });
  it("with no closes, realised volatility and the replay say they are unavailable; attribution names legs it cannot do", () => {
    render(<AdvancedPanels {...props} closes={null} />);
    expect(screen.getByTestId("adv-implied-realised")).toHaveTextContent("not available");
    expect(screen.getByTestId("adv-attr-skipped")).toHaveTextContent("no entry price or no stored index level");
  });
  it("an empty strategy and a missing index level each say so", () => {
    const { unmount } = render(<AdvancedPanels {...props} pos={{ ...pos, legs: [] }} />);
    expect(screen.getByTestId("adv-empty")).toBeInTheDocument(); unmount();
    render(<AdvancedPanels {...props} pos={{ ...pos, spot: null }} />);
    expect(screen.getByTestId("adv-nospot")).toBeInTheDocument();
  });
});
