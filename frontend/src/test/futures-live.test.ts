// The live overlay of the NIFTY future: the stream's tick over the polled quote, only when it is streaming, fresh and not older than the poll.
import { describe, expect, it } from "vitest";
import { overlayLiveFutures, type FutureContracts } from "../lib/futures";
import type { LiveTick } from "../lib/types";

const NOW = Date.parse("2026-11-23T05:00:00Z");
const polled: FutureContracts = {
  current: { role: "current", symbol: "NIFTY26DECFUT", key: "nse_fo|111", expiry: "2026-12-29", ltp: 25400, as_of: "2026-11-23T04:59:56Z", fresh: true, note: null },
  next: { role: "next", symbol: "NIFTY27JANFUT", key: "nse_fo|222", expiry: "2027-01-26", ltp: null, as_of: null, fresh: false, note: "no price yet" },
};
const tick = (key: string, ltp: number | null, received_at: string): LiveTick => ({ key, kind: "scrip", exchange_segment: "nse_fo", instrument_token: key.split("|")[1]!, trading_symbol: null, ltp, open: null, high: null, low: null, prev_close: null, volume: null, oi: null, net_change: null, net_change_pct: null, last_trade_time_raw: null, last_update_time_raw: null, received_at, seq: 1, source: "live" });
const from = (ticks: LiveTick[]) => (k: string) => ticks.find((t) => t.key === k);

describe("overlayLiveFutures", () => {
  it("takes the streamed price when the stream is live and the tick is newer than the poll", () => {
    const out = overlayLiveFutures(polled, from([tick("nse_fo|111", 25412.5, "2026-11-23T04:59:59Z")]), true, NOW)!;
    expect(out.current).toMatchObject({ ltp: 25412.5, as_of: "2026-11-23T04:59:59Z", fresh: true, symbol: "NIFTY26DECFUT", expiry: "2026-12-29" });
  });
  it("a contract the poll had no price for gets one from the stream (the next month), and the other is untouched", () => {
    const out = overlayLiveFutures(polled, from([tick("nse_fo|222", 25500, "2026-11-23T04:59:58Z")]), true, NOW)!;
    expect(out.next).toMatchObject({ ltp: 25500, fresh: true, note: null });
    expect(out.current).toBe(polled.current);
  });
  it("keeps the polled quote when the stream is not streaming, has no tick, a missing price or a zero price", () => {
    expect(overlayLiveFutures(polled, from([tick("nse_fo|111", 25412.5, "2026-11-23T04:59:59Z")]), false, NOW)).toBe(polled);
    expect(overlayLiveFutures(polled, from([]), true, NOW)!.current).toBe(polled.current);
    expect(overlayLiveFutures(polled, from([tick("nse_fo|111", null, "2026-11-23T04:59:59Z")]), true, NOW)!.current).toBe(polled.current);
    expect(overlayLiveFutures(polled, from([tick("nse_fo|111", 0, "2026-11-23T04:59:59Z")]), true, NOW)!.current).toBe(polled.current);
  });
  it("does not use a tick older than the poll (the poll has a later quote) or older than 3 minutes", () => {
    expect(overlayLiveFutures(polled, from([tick("nse_fo|111", 25390, "2026-11-23T04:59:40Z")]), true, NOW)!.current).toBe(polled.current);
    const stalePoll: FutureContracts = { ...polled, current: { ...polled.current, as_of: null, ltp: null, fresh: false } };
    expect(overlayLiveFutures(stalePoll, from([tick("nse_fo|111", 25390, "2026-11-23T04:56:00Z")]), true, NOW)!.current).toBe(stalePoll.current); // 4 minutes old
  });
  it("passes an unresolved contract list through", () => {
    expect(overlayLiveFutures(undefined, from([]), true, NOW)).toBeUndefined();
  });
});
