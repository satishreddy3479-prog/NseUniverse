import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { INDEX_KEY, liveStore, type LiveState } from "./liveStore";
import { startLiveSocket } from "./liveSocket";
import { isStreamStatus, type LiveTick, type StreamStatus } from "./types";
import { useStatus } from "./hooks";

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
  const linkOpen = live.conn === "open" && isStreamStatus(live.status);
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
