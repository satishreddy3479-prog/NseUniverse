// Portfolio statistics, worked by hand on one set of closed strategies (rupees).
import { describe, expect, it } from "vitest";
import { portfolioStats } from "../lib/portfolioStats";

const c = (id: string, closedAt: string, pnl: number) => ({ id, name: id, closedAt, pnl });
// in time order: +1000 (3 Nov), +500 (3 Nov), -2000 (4 Nov), -300 (5 Nov), -700 (5 Nov), +4000 (6 Nov), 0 (6 Nov flat)
const SET = [
  c("g", "2026-11-06T05:00:00Z", 4000), c("a", "2026-11-03T05:00:00Z", 1000), c("b", "2026-11-03T06:00:00Z", 500), c("d", "2026-11-04T05:00:00Z", -2000),
  c("e", "2026-11-05T05:00:00Z", -300), c("f", "2026-11-05T06:00:00Z", -700), c("h", "2026-11-06T06:00:00Z", 0),
];

describe("portfolio statistics", () => {
  const s = portfolioStats(SET);
  it("counts and totals", () => {
    expect(s.count).toBe(7);
    expect(s.wins).toBe(3);
    expect(s.losses).toBe(3);
    expect(s.flat).toBe(1);
    expect(s.total).toBe(2500); // 1000 + 500 - 2000 - 300 - 700 + 4000 + 0
    expect(s.winRate).toBeCloseTo((3 / 7) * 100, 6);
    expect(s.grossProfit).toBe(5500);
    expect(s.grossLoss).toBe(-3000);
  });
  it("averages, payoff, profit factor and expectancy", () => {
    expect(s.avgWin).toBeCloseTo(5500 / 3, 6); // 1833.33
    expect(s.avgLoss).toBe(-1000); // -3000 / 3
    expect(s.payoff).toBeCloseTo(1.83333, 4);
    expect(s.profitFactor).toBeCloseTo(5500 / 3000, 6);
    expect(s.expectancy).toBeCloseTo(2500 / 7, 6); // 357.14 per closed strategy
    // the same figure from win rate x average win + loss rate x average loss over all 7 trades: (3/7)(1833.33) + (3/7)(-1000) + 0
    expect((3 / 7) * (5500 / 3) + (3 / 7) * -1000).toBeCloseTo(s.expectancy!, 6);
  });
  it("best and worst, streaks and the current streak", () => {
    expect(s.best?.pnl).toBe(4000);
    expect(s.worst?.pnl).toBe(-2000);
    expect(s.longestWin).toBe(2); // +1000, +500
    expect(s.longestLoss).toBe(3); // -2000, -300, -700 are three in a row
    expect(s.current).toBeNull(); // the last one is flat
    expect(s.bestDay).toEqual({ day: "2026-11-06", pnl: 4000 });
    expect(s.worstDay).toEqual({ day: "2026-11-04", pnl: -2000 });
  });
  it("equity curve and drawdown from the highest point", () => {
    // cumulative: 1000, 1500, -500, -800, -1500, 2500, 2500; peak 1500 -> trough -1500
    expect(s.curve.map((p) => p.cum)).toEqual([1000, 1500, -500, -800, -1500, 2500, 2500]);
    expect(s.maxDrawdown).toBe(3000); // 1500 - (-1500)
    expect(s.maxDrawdownPct).toBeNull(); // no capital given: no percentage
    const withCap = portfolioStats(SET, 100000);
    expect(withCap.maxDrawdownPct).toBeCloseTo(3, 6); // 3 000 of 1 00 000
    expect(withCap.returnPct).toBeCloseTo(2.5, 6); // 2 500 of 1 00 000
    expect(s.currentDrawdown).toBe(0);
    expect(s.drawdownTrades).toBe(3); // -500, -800, -1500 are the three closes spent under the 1 500 peak
    expect(s.recoveryFactor).toBeCloseTo(2500 / 3000, 6);
  });
  it("leaves a measure missing when it cannot be formed", () => {
    const wins = portfolioStats([c("a", "2026-11-03T05:00:00Z", 100)]);
    expect(wins.profitFactor).toBeNull();
    expect(wins.avgLoss).toBeNull();
    expect(wins.payoff).toBeNull();
    expect(wins.worst).toBeNull();
    expect(wins.recoveryFactor).toBeNull();
    expect(wins.current).toEqual({ kind: "win", length: 1 });
    const none = portfolioStats([]);
    expect(none.winRate).toBeNull();
    expect(none.expectancy).toBeNull();
    expect(none.maxDrawdownPct).toBeNull();
  });
});
