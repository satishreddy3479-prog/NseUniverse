import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { INDEX_KEY, liveStore, type LiveState } from "./liveStore";
import { startLiveSocket } from "./liveSocket";
import { isStreamStatus, type LiveTick, type StreamStatus } from "./types";
import { useStatus } from "./hooks";
import { closingSchedule } from "./session";

const LINK_GRACE_MS = 8000;
const noopSubscribe = () => () => {};
const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const istOf = (ms: number): { ymd: string; min: number; weekday: boolean } => { const d = new Date(ms + 330 * 60_000); return { ymd: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() >= 1 && d.getUTCDay() <= 5 }; };
/** Whether ``ms`` falls in the closing auction session's indicative window (15:20-15:30 until 4 Dec 2026, 15:31-15:40 from 7 Dec): the index then shows the exchange's indicative closing value, not a traded price. */
export function inIndicativeWindow(ms: number): boolean {
  const p = istOf(ms), sch = closingSchedule(p.ymd);
  return p.weekday && p.min >= toMin(sch.indicativeFrom) && p.min < toMin(sch.indexEnd);
}
/** The last index level traded in the continuous session of a day (seen before the auction began): what a broker keeps showing while the exchange publishes indicative values. */
let lastTraded: { ymd: string; ltp: number; prevClose: number | null; at: number } | null = null;
/**
 * The index reading to show for a live tick. In the indicative window the tick is an auction estimate (19 and 23 Nov 2026: 24,853 against a traded 25,366 for several minutes,
 * converging to the close), so it is returned as ``indicative`` and the displayed level stays the last traded one (null when this browser never saw one that day).
 */
export function tradedIndex(tick: LiveTick | undefined): { ltp: number | null; prevClose: number | null; at: number | null; indicative: number | null } | null {
  if (tick?.ltp == null) return null;
  const ms = Date.parse(tick.received_at);
  if (!Number.isFinite(ms)) return { ltp: tick.ltp, prevClose: tick.prev_close, at: null, indicative: null };
  const p = istOf(ms);
  if (inIndicativeWindow(ms)) {
    const lt = lastTraded && lastTraded.ymd === p.ymd ? lastTraded : null;
    return { ltp: lt?.ltp ?? null, prevClose: lt?.prevClose ?? tick.prev_close, at: lt?.at ?? null, indicative: tick.ltp };
  }
  if (p.weekday && p.min >= 9 * 60 && p.min < toMin(closingSchedule(p.ymd).indicativeFrom)) lastTraded = { ymd: p.ymd, ltp: tick.ltp, prevClose: tick.prev_close, at: ms };
  return { ltp: tick.ltp, prevClose: tick.prev_close, at: ms, indicative: null };
}
/** Test hook. */
export const resetLastTraded = (): void => { lastTraded = null; };


export function useLiveState(): LiveState {
  return useSyncExternalStore(liveStore.subscribeState, liveStore.getState);
}

/** Re-renders only when this one instrument's tick changes. */
export function useLiveTick(key: string | null): LiveTick | undefined {
  const subscribe = useCallback(
    (cb: () => void) => (key ? liveStore.subscribeTick(key, cb) : noopSubscribe()),
    [key],
  );
  return useSyncExternalStore(subscribe, () => (key ? liveStore.getTick(key) : undefined));
}

/** Nearest listed strike to a price (ties go to the lower strike). */
export function nearestStrike(strikes: number[], price: number): number | null {
  let best: number | null = null;
  for (const k of strikes) {
    if (best === null || Math.abs(k - price) < Math.abs(best - price)) best = k;
  }
  return best;
}

/** ATM strike derived from the live NIFTY price. Returns a number, so the host re-renders only
 *  when the ATM strike itself changes, not on every index tick. */
export function useLiveAtmStrike(strikes: number[], enabled: boolean): number | null {
  const subscribe = useCallback(
    (cb: () => void) => (enabled ? liveStore.subscribeTick(INDEX_KEY, cb) : noopSubscribe()),
    [enabled],
  );
  return useSyncExternalStore(subscribe, () => {
    if (!enabled) return null;
    const ltp = liveStore.getTick(INDEX_KEY)?.ltp;
    return ltp == null ? null : nearestStrike(strikes, ltp);
  });
}

/** NIFTY 50 level from the stream, only while that stream is genuinely fresh. A connected stream
 *  whose data is stale or whose market is closed is NOT live: callers fall back to the snapshot and
 *  must not call the number live. */
export function useLiveSpot(): { ltp: number | null; prevClose: number | null; live: boolean } {
  const tick = useLiveTick(INDEX_KEY);
  const { stream } = useStreamStatus();
  const ti = tradedIndex(tick);
  const live = stream?.effective_state === "streaming" && ti?.ltp != null && ti.indicative == null; // an indicative auction value is not a live price
  return live ? { ltp: ti!.ltp, prevClose: ti!.prevClose, live: true } : { ltp: null, prevClose: null, live: false };
}

/** The NIFTY level a screen shows, and what it is. */
export interface SpotDisplay {
  ltp: number | null;
  prevClose: number | null;
  /** live: the stream is moving; held: the last live tick, kept because it is newer than the fallback; snapshot: the fallback (a stored value); close: the last value of the closing auction, kept by the server (what brokers show as the close: an auction value, not a traded price) */
  kind: "live" | "held" | "snapshot" | "close";
  /** the exchange's indicative closing value while the closing auction runs (not a traded price): shown beside the level, never as it; null otherwise */
  indicative: number | null;
  /** when the value was taken (epoch ms): the tick's receipt for live and held, the fallback's time for a snapshot */
  at: number | null;
}

/**
 * The level to show for NIFTY. While the stream is moving it is the live tick. When the stream is quiet (the pre-open session ends at 09:08 and the live market opens at 09:15; the evening;
 * a dropped link) the last live tick is HELD for as long as it is newer than the stored fallback, instead of the app falling back to a stored value from an earlier moment: before the
 * open the stored snapshot is yesterday's close, so the price would jump back to it when pre-open ended. A held value is never called live.
 */
/**
 * Whether a tick received at ``ms`` can be a live exchange tick: on a weekday between 09:00 and 15:45 IST. The broker sends the last known quote again whenever the
 * backend restarts or the feed reconnects, and that tick is stamped with the time it was received, so after the close or at night it carried the time of the restart
 * ("Held 23:15:21") instead of the time the price was made, and the time changed with every deploy.
 */
export function isLiveTickTime(ms: number): boolean {
  const d = new Date(ms + 330 * 60_000);
  const day = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && min >= 9 * 60 && min <= 15 * 60 + 45;
}

export function useSpotDisplay(fallback: { ltp: number | null; prevClose: number | null; at: string | null }): SpotDisplay {
  const tick = useLiveTick(INDEX_KEY);
  const { stream } = useStreamStatus();
  const closeQ = useQuery({ queryKey: ["indexClose"], queryFn: api.indexClose, refetchInterval: 60_000, staleTime: 30_000, retry: false });
  const ti = tradedIndex(tick);
  const tickMs = ti?.at ?? (tick?.ltp != null ? Date.parse(tick.received_at) : Number.NaN);
  const fbMs = fallback.at ? Date.parse(fallback.at) : Number.NaN;
  const snapshot = (indicative: number | null): SpotDisplay => ({ ltp: fallback.ltp, prevClose: fallback.prevClose, kind: "snapshot", at: Number.isFinite(fbMs) ? fbMs : null, indicative });
  if (stream?.effective_state === "streaming" && ti) {
    if (ti.indicative != null) return ti.ltp != null ? { ltp: ti.ltp, prevClose: ti.prevClose, kind: "held", at: ti.at, indicative: ti.indicative } : snapshot(ti.indicative); // the auction estimate is not the price
    if (ti.ltp != null) return { ltp: ti.ltp, prevClose: ti.prevClose, kind: "live", at: Number.isFinite(tickMs) ? tickMs : null, indicative: null };
  }
  // a replayed last quote is not held: outside the session, or while the exchange says the market is closed (a holiday), the stored snapshot is shown with its own time
  const replay = !isLiveTickTime(tickMs) || stream?.effective_state === "market_closed";
  if (ti?.ltp != null && Number.isFinite(tickMs) && !replay && (!Number.isFinite(fbMs) || tickMs > fbMs)) return { ltp: ti.ltp, prevClose: ti.prevClose ?? fallback.prevClose, kind: "held", at: tickMs, indicative: null };
  // the stored chain's index level freezes at 15:15, and the browser's held tick is gone after a reload: the server's record of the auction's last value is the close of the session the fallback belongs to
  const c = closeQ.data;
  const cMs = c?.received_at ? Date.parse(c.received_at) : Number.NaN;
  if (c?.day && c.ltp != null && Number.isFinite(cMs) && (!Number.isFinite(fbMs) || c.day >= istOf(fbMs).ymd))
    return { ltp: c.ltp, prevClose: c.prev_close ?? fallback.prevClose, kind: "close", at: cMs, indicative: null };
  return snapshot(null);
}

/** Mount once near the root: owns the single browser WebSocket. */
export function useLiveConnection(): void {
  useEffect(() => startLiveSocket(liveStore), []);
}

/** WebSocket status when the link is up (fresher), otherwise the polled REST status. */
export function useStreamStatus(): {
  stream: StreamStatus | undefined;
  linkOpen: boolean;
  /** The backend answered but does not know about streaming (older version still running). */
  outdated: boolean;
} {
  const live = useLiveState();
  const rest = useStatus();
  // A reconnect of a few seconds is not an outage: while the last message from the backend is recent, the link counts as
  // up, so the top bar does not flip from "Live" to "Streaming" each time the socket is re-established.
  const recent = live.lastMessageAt != null && Date.now() - live.lastMessageAt < LINK_GRACE_MS;
  const linkOpen = (live.conn === "open" || recent) && isStreamStatus(live.status);
  const candidate = linkOpen ? live.status : rest.data?.stream;
  const valid = isStreamStatus(candidate);
  return { stream: valid ? candidate : undefined, linkOpen, outdated: !!rest.data && !valid };
}

export function useStreamControl() {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: ["status"] });
  const start = useMutation({ mutationFn: api.streamStart, onSettled: settle });
  const stop = useMutation({ mutationFn: api.streamStop, onSettled: settle });
  return { start, stop };
}
