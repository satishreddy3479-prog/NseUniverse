import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { INDEX_KEY, liveStore, type LiveState } from "./liveStore";
import { startLiveSocket } from "./liveSocket";
import { isStreamStatus, type LiveTick, type StreamStatus } from "./types";
import { useStatus } from "./hooks";

const LINK_GRACE_MS = 8000;
const noopSubscribe = () => () => {};

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
  const live = stream?.effective_state === "streaming" && tick?.ltp != null;
  return live ? { ltp: tick!.ltp, prevClose: tick!.prev_close, live: true } : { ltp: null, prevClose: null, live: false };
}

/** The NIFTY level a screen shows, and what it is. */
export interface SpotDisplay {
  ltp: number | null;
  prevClose: number | null;
  /** live: the stream is moving; held: the last live tick, kept because it is newer than the fallback; snapshot: the fallback (a stored value) */
  kind: "live" | "held" | "snapshot";
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
  const tickMs = tick?.ltp != null ? Date.parse(tick.received_at) : Number.NaN;
  if (stream?.effective_state === "streaming" && tick?.ltp != null) return { ltp: tick.ltp, prevClose: tick.prev_close, kind: "live", at: Number.isFinite(tickMs) ? tickMs : null };
  const fbMs = fallback.at ? Date.parse(fallback.at) : Number.NaN;
  // a replayed last quote is not held: outside the session, or while the exchange says the market is closed (a holiday), the stored snapshot is shown with its own time
  const replay = !isLiveTickTime(tickMs) || stream?.effective_state === "market_closed";
  if (tick?.ltp != null && Number.isFinite(tickMs) && !replay && (!Number.isFinite(fbMs) || tickMs > fbMs)) return { ltp: tick.ltp, prevClose: tick.prev_close ?? fallback.prevClose, kind: "held", at: tickMs };
  return { ltp: fallback.ltp, prevClose: fallback.prevClose, kind: "snapshot", at: Number.isFinite(fbMs) ? fbMs : null };
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
