import { describe, expect, it } from "vitest";
import { isRefiled, type Closed } from "../pages/StrategyBuilder";
import type { Leg } from "../lib/strategy";

const leg = (id: string, type: "CE" | "PE", strike: number, premium: number, extra: Partial<Leg> = {}): Leg =>
  ({ id, action: "SELL", type, strike, expiry: "2026-11-24", premium, lots: 1, enabled: true, ...extra }) as Leg;

// The real case: closed on 20 Nov (+422.5), brought back as running legs, closed again on 22 Nov at stale prices
const closed20: Closed = {
  id: "leg-mwouykdh-0", name: "straddle", closedAt: "2026-11-20T09:50:00Z", snapshotAt: "2026-11-20T09:50:00Z", expiry: "2026-11-24", lotSize: 65, pnl: 422.5,
  legs: [{ ...leg("leg-mwoiiaau-1d8", "CE", 25800, 160.0), exit: 209.85 }, { ...leg("leg-mwoiiaau-1d9", "PE", 25800, 90.0), exit: 40.1 }],
};

describe("a closed trade brought back as running legs is not filed twice", () => {
  it("recognises the same leg ids and entry premiums, whatever the new exit prices", () => {
    const back = [leg("leg-mwoiiaau-1d8", "CE", 25800, 160.0, { exitPrice: 262.3 }), leg("leg-mwoiiaau-1d9", "PE", 25800, 90.0, { exitPrice: 41.35 })];
    expect(isRefiled([closed20], back)).toBe(closed20);
  });
  it("a different position (new ids) is a new trade", () => {
    expect(isRefiled([closed20], [leg("leg-new-1", "CE", 25800, 160.0), leg("leg-new-2", "PE", 25800, 90.0)])).toBeUndefined();
  });
  it("same ids but another entry premium is not the same trade", () => {
    expect(isRefiled([closed20], [leg("leg-mwoiiaau-1d8", "CE", 25800, 175.0)])).toBeUndefined();
  });
  it("no legs is never a match", () => { expect(isRefiled([closed20], [])).toBeUndefined(); });
});
