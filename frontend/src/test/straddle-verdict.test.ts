// The plain-language reading at the top of the Straddle page: written only from fields the summary carries. Fixtures are hand-built, not market data.
import { describe, expect, it } from "vitest";
import type { StraddleDecay } from "../lib/straddleDecay";
import { straddleReading } from "../lib/straddleVerdict";

const stat = (open: number | null, current: number | null) => ({ open, current, change: open == null || current == null ? null : current - open, change_pct: null });
const make = (o: Partial<Record<string, unknown>> = {}): StraddleDecay => ({
  status: "ok",
  tracker: { fixed: { strike: 25300, ce: stat(100, 90), pe: stat(100, 95), straddle: stat(200, 185) }, rolling: { ce: stat(100, 90), pe: stat(100, 95), straddle: stat(200, 190), rolls: 2, adjusted_change: -4.5 }, opening_at: "x", atm_now: 25350 },
  environment: {
    seller: { score: 68, class: "Favourable", capped_by_flags: null, coverage: 0.9, components: [], flags: [{ id: "f1", text: "IV is rising fast" }], note: "" },
    buyer: { score: 34, class: "Neutral", coverage: 0.9, components: [], types: {}, direction: { value: null, label: "x", parts: [] }, premium_check: { iv_rising_but_not_justified: false, text: "" }, note: "" },
    invalidation: ["a one-way move above 25400", "IV rising 1 point", "a break of the gamma flip", "a fourth line"], proxies: [], weights_note: "", sources: { seller_inputs: [], buyer_inputs: [] },
    comparison: { verdict: "seller", text: "Conditions favour option sellers.", seller_score: 68, buyer_score: 34, same_sign_in_both: [], conflicting_seller: [], conflicting_buyer: [], top_seller: [], top_buyer: [] },
  },
  environment_trend: { seller: { now: 68, m15: 60, m30: 55 }, buyer: { now: 34, m15: 36, m30: null } },
  quality: { last_sample_at: "x", age_minutes: 1, stale: false, live: true, steps_skipped_fixed: 0, steps_skipped_rolling: 0, forward_fallbacks: 0, estimated: [], stride_note: "" },
  climate: { label: "favourable", tally: 2, because: [], window: "since open", note: "" }, retention: { side: "put", text: "The put kept more of its premium." },
  interpretation: [],
  ...o,
} as unknown as StraddleDecay);

describe("straddleReading", () => {
  it("takes the headline from the service comparison and reports each side's move over 15 minutes", () => {
    const r = straddleReading(make());
    expect(r.headline).toBe("Conditions favour option sellers.");
    expect(r.seller).toEqual({ score: 68, label: "Favourable", move15: 8 });
    expect(r.buyer).toEqual({ score: 34, label: "Neutral", move15: -2 });
    expect(straddleReading(make({ environment_trend: null })).seller?.move15).toBeNull(); // not recorded: no move, not zero
  });

  it("describes both followed straddles from their opening and current premiums, in words", () => {
    const [fx, rl] = straddleReading(make()).positions;
    expect(fx).toEqual({ name: "Fixed 25300", open: 200, now: 185, change: -15, words: "the premium has fallen (decayed): a seller is ahead" });
    expect(rl).toEqual({ name: "Rolling ATM (now 25350)", open: 200, now: 190, change: -4.5, words: "the premium has fallen (decayed): a seller is ahead" }); // the roll-adjusted change, not now minus open
    const up = straddleReading(make({ tracker: { ...make().tracker, fixed: { strike: 25300, ce: stat(100, 110), pe: stat(100, 100), straddle: stat(200, 210) } } })).positions[0]!;
    expect(up.words).toBe("the premium has risen: a seller is behind");
    expect(straddleReading(make({ tracker: { ...make().tracker, fixed: { strike: 1, ce: stat(null, null), pe: stat(null, null), straddle: stat(null, null) } } })).positions[0]!.words).toBe("not enough data yet");
  });

  it("lists what holds the scores back: flags, a capped label, stale or stored data", () => {
    expect(straddleReading(make()).cautions).toEqual(["IV is rising fast"]);
    const d = make();
    const env = d.environment!;
    const r = straddleReading({ ...d, environment: { ...env, seller: { ...env.seller, capped_by_flags: "Neutral" } }, quality: { ...d.quality!, stale: true, age_minutes: 62, live: false } });
    expect(r.cautions).toEqual(["IV is rising fast", 'The seller label is held at "Neutral" by the flags above, whatever the score says.', "Stale: the last sample is 62 min old.", "A stored session, not live data."]);
  });

  it("shows at most three things that would change the picture, and the climate with its retention line", () => {
    const r = straddleReading(make());
    expect(r.invalidation).toEqual(["a one-way move above 25400", "IV rising 1 point", "a break of the gamma flip"]);
    expect(r.climate).toEqual({ label: "favourable", text: "The put kept more of its premium." });
  });

  it("invents nothing when there is no environment", () => {
    const r = straddleReading(make({ environment: null, environment_note: "Computed for the live session only.", climate: undefined }));
    expect(r.headline).toBe("Computed for the live session only.");
    expect(r.seller).toBeNull();
    expect(r.buyer).toBeNull();
    expect(r.invalidation).toEqual([]);
    expect(r.climate).toBeNull();
  });
});
