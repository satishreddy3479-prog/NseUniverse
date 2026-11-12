// The browser's automatic stop, target, trail, re-entry and strategy rules must give exactly what the server's give:
// backend/tests/fixtures/strategy_parity.json holds 300 generated strategies with the server's result.
import { describe, expect, it } from "vitest";
import fixture from "../../../backend/tests/fixtures/strategy_parity.json";
import { applyAutomation, applyStrategyRules, type Leg, type RulesState, type StrategyRules } from "../lib/strategy";

const FIELDS = ["premium", "stop", "stopBase", "stopTrailed", "target", "exitPrice", "exitReason", "realised", "reentry", "reentryLevel", "cycles", "stopPct", "targetPct", "costMoved"] as const;
const AT = "2026-11-06T05:00:00.000Z";
const norm = (v: unknown) => (v === undefined ? null : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);

describe("browser rules equal the server's", () => {
  it("agree on 300 generated strategies", () => {
    const diffs: string[] = [];
    (fixture as unknown as { moveToCost: boolean; legs: Leg[]; prices: Record<string, number | null>; rules: StrategyRules; state: RulesState; mult: number; expected: { legs: Record<string, unknown>[]; events: number; state: { floor: number | null; done: string | null } } }[]).forEach((c, i) => {
      const price = (strike: number, type: string) => c.prices[`${strike}${type}`] ?? null;
      const r1 = applyAutomation(c.legs, price, 65, AT, c.mult, c.moveToCost);
      const r2 = applyStrategyRules(r1.legs, { ...c.rules } as StrategyRules, c.state, price, 65, AT, c.mult);
      const got = r2.legs.map((l) => Object.fromEntries(FIELDS.map((f) => [f, norm((l as unknown as Record<string, unknown>)[f])])));
      const want = c.expected.legs.map((l) => Object.fromEntries(FIELDS.map((f) => [f, norm(l[f])])));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        const k = want.findIndex((w, j) => JSON.stringify(w) !== JSON.stringify(got[j]));
        const f = FIELDS.find((x) => JSON.stringify((want[k] as Record<string, unknown>)[x]) !== JSON.stringify((got[k] as Record<string, unknown>)[x]));
        diffs.push(`case ${i} leg ${k} field ${f}: server ${JSON.stringify((want[k] as Record<string, unknown>)[f!])} browser ${JSON.stringify((got[k] as Record<string, unknown>)[f!])}`);
      }
      if (r1.events.length + r2.events.length !== c.expected.events) diffs.push(`case ${i} events: server ${c.expected.events} browser ${r1.events.length + r2.events.length}`);
      if (norm(r2.state.floor) !== norm(c.expected.state.floor) || (r2.state.done ?? null) !== c.expected.state.done) diffs.push(`case ${i} state: server ${JSON.stringify(c.expected.state)} browser ${JSON.stringify({ floor: r2.state.floor, done: r2.state.done })}`);
    });
    expect(diffs.slice(0, 12)).toEqual([]);
  });
});
