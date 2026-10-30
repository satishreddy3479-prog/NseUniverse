import { describe, expect, it } from "vitest";
import { readingLines } from "../components/PredictionViz";

const base = { horizon: "T1" as const, model: "ensemble", target: "2026-10-30", close: 22936.75, q: { "0.05": -0.02, "0.25": -0.005, "0.75": 0.006, "0.95": 0.018 }, events: [] as string[] };

describe("readingLines writes the statement from the forecast's own numbers", () => {
  it("a lean down with disagreeing models and no call (hand calculation: 48.7 vs 52.9 is 4.2 points below)", () => {
    const l = readingLines({ ...base, p: 0.487, base: 0.529, models: [{ name: "logit", p: 0.47 }, { name: "gbm", p: 0.55 }], call: { call: null, reason: "signal too close to the base rate" } });
    expect(l[0]).toBe("ensemble puts the chance of a higher close on 2026-10-30 at 48.7%, 4.2 points below the historical up-frequency of 52.9%. That is a lean towards down.");
    expect(l[1]).toContain("range from 47.0% to 55.0%");
    expect(l[1]).toContain("disagree on direction");
    expect(l[2]).toBe("No call is made: signal too close to the base rate.");
    expect(l[3]).toContain("half of outcomes land between ₹22,822 and ₹23,074"); // 22936.75 x 0.995 and x 1.006
  });
  it("a lean up with every model above the base rate and an issued call", () => {
    const l = readingLines({ ...base, p: 0.62, base: 0.55, models: [{ name: "a", p: 0.6 }, { name: "b", p: 0.64 }], call: { call: "up", reason: "models agree" } });
    expect(l[0]).toContain("7.0 points above");
    expect(l[0]).toContain("lean towards up");
    expect(l[1]).toContain("all of them sit above the base rate");
    expect(l[2]).toBe("A confident call was issued: UP (models agree).");
  });
  it("within three points it says it carries almost no information, and lists event risk only when there is some", () => {
    const l = readingLines({ ...base, horizon: "T5", p: 0.577, base: 0.566, models: [{ name: "x", p: 0.577 }], call: null, events: ["US midterm elections"], q: null });
    expect(l[0]).toContain("inside the band where it says almost nothing");
    expect(l).toHaveLength(2); // one model, no call, no range: nothing invented
    expect(l[1]).toBe("Event risk before the target close: US midterm elections.");
  });
});

import { chanceText } from "../pages/Prediction";
describe("chanceText follows the forecast", () => {
  it("a lean down is stated as the chance of NOT closing above the last close, for the target date (51.3% = 100 - 48.7)", () => {
    const c = chanceText("T1", 0.487, 0.529, 22936.75, "2026-10-30", "ensemble");
    expect(c.number).toBe("51.3%");
    expect(c.text).toBe("chance NIFTY 50 does not close above ₹22,937 on Fri 30 Oct · ensemble (calibrated) · history says 52.9% of the time it rises · close to a coin flip");
  });
  it("a lean up for five sessions names the target date and carries no coin-flip remark when far from 50%", () => {
    const c = chanceText("T5", 0.65, 0.566, 22936.75, "2026-11-05", "logit core");
    expect(c.number).toBe("65.0%");
    expect(c.text).toContain("closes above ₹22,937 on Thu 5 Nov");
    expect(c.text).not.toContain("coin flip");
  });
  it("without a target date it still says which horizon", () => {
    expect(chanceText("T1", 0.6, 0.5, 100, null, "m").text).toContain("next session");
    expect(chanceText("T5", 0.6, 0.5, 100, null, "m").text).toContain("in 5 sessions");
  });
});
