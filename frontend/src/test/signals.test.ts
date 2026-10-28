import { describe, expect, it } from "vitest";
import { deriveSignals } from "../lib/signals";
import { status, streamStatus, summary } from "./fixtures";

const T = Date.parse("2026-10-28T09:00:00Z");

describe("deriveSignals", () => {
  it("reports backend offline on every segment instead of guessing", () => {
    const s = deriveSignals(undefined, true, undefined, T);
    expect(s[0]?.value).toBe("Backend offline");
    expect(s).toHaveLength(5);
    expect(s.slice(1).every((x) => x.value === "Unknown")).toBe(true);
  });

  it("shows each broker auth state", () => {
    const mk = (state: "not_attempted" | "authenticating" | "authenticated" | "failed") =>
      deriveSignals(status({ auth: { state, last_attempt_at: null, last_success_at: null, last_error: null } }), false, undefined, T)[0];
    expect(mk("not_attempted")).toMatchObject({ value: "Not signed in", tone: "idle" });
    expect(mk("authenticating")).toMatchObject({ value: "Signing in", tone: "pending" });
    expect(mk("authenticated")).toMatchObject({ value: "Signed in", tone: "ok" });
    expect(mk("failed")).toMatchObject({ value: "Sign-in failed", tone: "bad" });
  });

  it("does not treat a signed-in broker as fresh data", () => {
    const st = status({
      auth: { state: "authenticated", last_attempt_at: null, last_success_at: null, last_error: null } });
    const s = deriveSignals(st, false, undefined, T);
    expect(s[0]).toMatchObject({ value: "Signed in", tone: "ok" });
    expect(s[4]).toMatchObject({ value: "No data", tone: "idle" });
  });

  it("marks old snapshots stale using the backend threshold", () => {
    const st = status({ snapshot_stale_after_seconds: 60 });
    const old = summary({ retrieved_at: "2026-10-28T08:55:00Z" });
    expect(deriveSignals(st, false, old, T)[4]).toMatchObject({ value: "Stale", tone: "warn" });
    const fresh = summary({ retrieved_at: "2026-10-28T08:59:30Z" });
    expect(deriveSignals(st, false, fresh, T)[4]?.value).toBe("Fresh snapshot");
  });

  it("reports auth and snapshot failures", () => {
    const st = status({
      auth: { state: "failed", last_attempt_at: null, last_success_at: null, last_error: "bad MPIN" },
      snapshots: { last_attempt_at: null, last_success_at: null, last_error: "rate limit", in_progress: false, captured_count: 0 } });
    const s = deriveSignals(st, false, undefined, T);
    expect(s[0]).toMatchObject({ value: "Sign-in failed", tone: "bad", detail: "bad MPIN" });
    expect(s[1]).toMatchObject({ value: "Last fetch failed", tone: "bad" });
    expect(s[2]?.value).toBe("Not started");
  });

  const live = (over: Parameters<typeof streamStatus>[0], linkOpen = true) => ({
    stream: streamStatus({ data_source: "live", ...over }), linkOpen,
  });
  const liveStatus = () => status();

  it("streaming and fresh is the only state that shows live data", () => {
    const s = deriveSignals(liveStatus(), false, summary(), T,
      live({ state: "streaming", effective_state: "streaming", freshness: "fresh", data_age_seconds: 2 }));
    expect(s[2]).toMatchObject({ value: "Streaming", tone: "ok" });
    expect(s[4]).toMatchObject({ value: "Live data", tone: "ok" });
  });

  it("a connected but silent feed is stale, not green", () => {
    const s = deriveSignals(liveStatus(), false, summary(), T,
      live({ state: "streaming", effective_state: "stale", freshness: "stale", data_age_seconds: 75 }));
    expect(s[2]).toMatchObject({ value: "Stale", tone: "warn" });
    expect(s[4]).toMatchObject({ value: "Stale", tone: "warn" });
  });

  it("market closed is reported from the exchange feed and old data is labelled last session", () => {
    const market = { state: "closed" as const, code: 2, text: "Market closed", exchange_segment: "nse_fo",
      received_at: null, source: "exchange_feed" as const };
    const s = deriveSignals(liveStatus(), false, summary(), T,
      live({ state: "waiting_for_data", effective_state: "market_closed", market }));
    expect(s[2]).toMatchObject({ value: "Subscribed, market closed", tone: "idle" });
    expect(s[3]).toMatchObject({ value: "Closed" });
    expect(s[4]).toMatchObject({ value: "Last session", tone: "idle" });
  });

  it("market status is unknown until the exchange feed says otherwise (hours are not assumed)", () => {
    const s = deriveSignals(liveStatus(), false, summary(), T, live({ state: "stopped" }));
    expect(s[3]).toMatchObject({ value: "Unknown", tone: "idle" });
  });

  it("reconnecting, auth failure and exhausted retries are distinct", () => {
    expect(deriveSignals(liveStatus(), false, undefined, T, live({ state: "reconnecting", reconnect_count: 2 }))[2])
      .toMatchObject({ value: "Reconnecting", tone: "warn" });
    expect(deriveSignals(liveStatus(), false, undefined, T, live({ state: "auth_failed" }))[2])
      .toMatchObject({ value: "Sign-in failed", tone: "bad" });
    expect(deriveSignals(liveStatus(), false, undefined, T, live({ state: "failed" }))[2])
      .toMatchObject({ value: "Stopped after retries", tone: "bad" });
  });

  it("warns when the browser link to the backend stream is not open", () => {
    const s = deriveSignals(liveStatus(), false, summary(), T,
      live({ state: "streaming", effective_state: "streaming", freshness: "fresh" }, false));
    expect(s[2]).toMatchObject({ value: "Streaming", tone: "warn" });
  });
});

describe("older backend without streaming support", () => {
  it("shows a restart hint instead of crashing, and keeps the other signals", () => {
    const old = { ...status(), stream: { implemented: false, state: "not_implemented", note: "old" } } as never;
    const s = deriveSignals(old, false, summary(), T, { stream: undefined, linkOpen: false });
    expect(s).toHaveLength(5);
    expect(s[2]).toMatchObject({ value: "Backend needs restart", tone: "warn" });
    expect(s[3]).toMatchObject({ value: "Unknown" });
  });
});
