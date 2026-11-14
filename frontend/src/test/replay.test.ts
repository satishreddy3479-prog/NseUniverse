import { describe, expect, it } from "vitest";
import { clipObservations, clipSeries, istDay, replayDays, replaySteps, stepAt } from "../lib/replay";

const mk = (iso: string) => ({ retrieved_at: iso });
// IST day boundaries: 18:29 UTC is 23:59 IST of the same date, 18:31 UTC is 00:01 IST of the next one (the last sample is on the 14th)
const obs = [mk("2026-11-12T03:50:00Z"), mk("2026-11-12T03:51:00Z"), mk("2026-11-12T18:29:00Z"), mk("2026-11-13T03:50:00Z"), mk("2026-11-13T03:52:00Z"), mk("2026-11-13T18:31:00Z")];

describe("replay helpers", () => {
  it("reads days in IST and lists them newest first", () => {
    expect(istDay("2026-11-12T18:29:00Z")).toBe("2026-11-12");
    expect(istDay("2026-11-12T18:31:00Z")).toBe("2026-11-13");
    expect(replayDays(obs)).toEqual(["2026-11-14", "2026-11-13", "2026-11-12"]);
    expect(replayDays(undefined)).toEqual([]);
  });
  it("the steps of a day are its stored samples, oldest first; a day with none has no steps", () => {
    expect(replaySteps(obs, "2026-11-13")).toEqual([Date.parse("2026-11-13T03:50:00Z"), Date.parse("2026-11-13T03:52:00Z")]);
    expect(replaySteps(obs, "2026-11-14")).toEqual([Date.parse("2026-11-13T18:31:00Z")]); // 00:01 IST belongs to the next day
    expect(replaySteps(obs, "2026-11-15")).toEqual([]);
    expect(replaySteps(obs, null)).toEqual([]);
  });
  it("finds the step at or before a time", () => {
    const st = [10, 20, 30];
    expect([stepAt(st, 5), stepAt(st, 10), stepAt(st, 25), stepAt(st, 99)]).toEqual([-1, 0, 1, 2]);
  });
  it("the history a replay may show is earlier days whole, the replayed day up to the cut, nothing later", () => {
    const cut = Date.parse("2026-11-13T03:51:00Z");
    expect(clipObservations(obs, cut).map((o) => o.retrieved_at)).toEqual(["2026-11-12T03:50:00Z", "2026-11-12T03:51:00Z", "2026-11-12T18:29:00Z", "2026-11-13T03:50:00Z"]);
    expect(clipObservations(obs, null)).toHaveLength(obs.length);
  });
  it("cuts every per-time array and record of arrays of a series at the replay time and leaves the rest alone", () => {
    const s = { times: ["2026-11-13T03:50:00Z", "2026-11-13T03:51:00Z", "2026-11-13T03:52:00Z"], spot: [1, 2, 3], ce_oi: { "24000": [10, 20, 30], "24050": [11, 21, 31] }, strikes: [24000, 24050], warnings: ["w"], stride: 1 };
    const c = clipSeries(s, Date.parse("2026-11-13T03:51:00Z"));
    expect(c.times).toHaveLength(2);
    expect(c.spot).toEqual([1, 2]);
    expect(c.ce_oi).toEqual({ "24000": [10, 20], "24050": [11, 21] });
    expect(c.strikes).toEqual([24000, 24050]); // strikes are not per time
    expect(c.warnings).toEqual(["w"]);
    expect(clipSeries(s, null)).toBe(s); // no replay: the very same object
    expect(clipSeries(s, Date.parse("2026-11-14T00:00:00Z"))).toBe(s); // cut after the last sample: nothing to cut
    expect(clipSeries(s, Date.parse("2026-11-13T03:40:00Z")).times).toEqual([]); // before the first sample: nothing shown, nothing invented
  });
});
