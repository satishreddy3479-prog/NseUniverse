// Same scenarios as backend/tests/unit/test_strategy_hold.py: the browser and the server must close at the same moments.
import { describe, expect, it } from "vitest";
import { applyHold, holdMoment, holdProblem, type HoldRule } from "../lib/strategy";
import type { Leg } from "../lib/strategy";

const ist = (d: string, h: number, m: number) => Date.parse(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);
const iso = (ms: number) => new Date(ms).toISOString();
const leg = (o: Partial<Leg> = {}): Leg => ({ id: "a", expiry: "2026-11-12", strike: 24900, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "manual", reentry: 1, ...o });
const INTRADAY: HoldRule = { mode: "intraday", closeAt: "15:20" };
const OVERNIGHT: HoldRule = { mode: "overnight", closeAt: "15:20" };

describe("holding rule", () => {
  it("intraday closes the open leg at the set time, at the live price, once", () => {
    const held = iso(ist("2026-11-10", 10, 0));
    const early = applyHold([leg()], INTRADAY, held, () => 80, 65, iso(ist("2026-11-10", 15, 19)));
    expect(early.events).toEqual([]);
    const r = applyHold([leg()], INTRADAY, held, () => 80, 65, iso(ist("2026-11-10", 15, 20)));
    expect(r.events).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ exitPrice: 80, exitReason: "strategy", reentry: 0, realised: 20 * 65 });
    expect(applyHold(r.legs, INTRADAY, held, () => 70, 65, iso(ist("2026-11-10", 15, 25))).events).toEqual([]);
  });
  it("intraday armed after the close time waits for the next trading day (Friday evening: Monday)", () => {
    expect(holdMoment(INTRADAY, ist("2026-11-10", 15, 30), null)).toBe(ist("2026-11-11", 15, 20));
    expect(holdMoment(INTRADAY, ist("2026-11-13", 16, 0), null)).toBe(ist("2026-11-16", 15, 20));
  });
  it("overnight holds to the expiry day's close time, and leaves a strategy armed after it to settle", () => {
    const held = iso(ist("2026-11-10", 10, 0));
    expect(applyHold([leg()], OVERNIGHT, held, () => 80, 65, iso(ist("2026-11-10", 15, 25))).events).toEqual([]);
    expect(applyHold([leg()], OVERNIGHT, held, () => 80, 65, iso(ist("2026-11-12", 15, 20))).events).toHaveLength(1);
    expect(holdMoment(OVERNIGHT, ist("2026-11-12", 15, 30), "2026-11-12")).toBeNull();
  });
  it("a leg without a live price stays open; manual never closes; bad times are refused", () => {
    const held = iso(ist("2026-11-10", 10, 0));
    expect(applyHold([leg()], INTRADAY, held, () => null, 65, iso(ist("2026-11-10", 15, 30))).events).toEqual([]);
    expect(applyHold([leg()], { mode: "manual", closeAt: "15:20" }, held, () => 80, 65, iso(ist("2026-11-12", 15, 30))).events).toEqual([]);
    expect(holdProblem(INTRADAY)).toBeNull();
    expect(holdProblem({ mode: "intraday", closeAt: "16:00" })).not.toBeNull();
    expect(holdProblem({ mode: "intraday", closeAt: "9:15" })).not.toBeNull();
  });
});
