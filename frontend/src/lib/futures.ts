import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useThrottledVersion } from "../components/dashboard/DashContext";
import { api } from "./api";
import { liveStore } from "./liveStore";
import type { LiveTick } from "./types";
import { useStreamStatus } from "./useLive";

/** One NIFTY index-future contract as the backend resolves it (current month, or the next month for rolling). A missing price is null, never zero. */
export interface FutureContract { role: "current" | "next"; symbol: string | null; key: string | null; expiry: string | null; ltp: number | null; as_of: string | null; fresh: boolean; note: string | null }
export interface FutureContracts { current: FutureContract; next: FutureContract }

/** Live price of the future that expires on ``expiry``: only a fresh quote counts. */
export function futurePrice(c: FutureContracts | undefined | null, expiry: string): number | null {
  const k = futureOf(c, expiry);
  return k && k.fresh && k.ltp != null && k.ltp > 0 ? k.ltp : null;
}
export const futureOf = (c: FutureContracts | undefined | null, expiry: string): FutureContract | null =>
  !c ? null : c.current.expiry === expiry ? c.current : c.next.expiry === expiry ? c.next : null;

/** The contract a new future leg starts on: the current month. After its expiry the backend already reports the next month as current. */
export function futureToAdd(c: FutureContracts | undefined | null, today: string): FutureContract | null {
  if (!c) return null;
  return c.current.expiry && c.current.expiry >= today ? c.current : null;
}
/** The contract a future leg rolls into: the next month's, when it is listed and later than the leg's own expiry. */
export function futureToRollInto(c: FutureContracts | undefined | null, legExpiry: string): FutureContract | null {
  return c && c.next.expiry && c.next.expiry > legExpiry ? c.next : null;
}

/** Polled while a page that holds futures is open. */
export function useFutureContracts(enabled = true) {
  return useQuery({ queryKey: ["futureContracts"], queryFn: () => api.futureContracts(), enabled, refetchInterval: 5_000, staleTime: 3_000, retry: false });
}

/** A quote older than this is not used (the backend's own limit for a contract's price). */
const LIVE_FRESH_MS = 180_000;

/**
 * The contracts with each future's live tick laid over the polled quote. The poll (every 5 s) resolves the contract (symbol, key, expiry) and is the fallback; the stream carries the
 * future tick by tick, like the NIFTY index, so while it is streaming the price follows it. The tick is used only when it is not older than the polled quote (a later poll has newer data)
 * and is itself fresh; otherwise the polled quote stands. Pure: the clock and the tick source are arguments.
 */
export function overlayLiveFutures(c: FutureContracts | undefined, tickOf: (key: string) => LiveTick | undefined, streaming: boolean, nowMs: number = Date.now()): FutureContracts | undefined {
  if (!c || !streaming) return c;
  const one = (k: FutureContract): FutureContract => {
    const t = k.key ? tickOf(k.key) : undefined;
    if (!t || t.ltp == null || !(t.ltp > 0)) return k;
    const tickMs = Date.parse(t.received_at);
    if (!Number.isFinite(tickMs) || nowMs - tickMs > LIVE_FRESH_MS) return k;
    if (k.as_of && Date.parse(k.as_of) > tickMs) return k; // the poll already has a later quote
    return { ...k, ltp: t.ltp, as_of: t.received_at, fresh: true, note: null };
  };
  return { current: one(c.current), next: one(c.next) };
}

/** The futures as pages should read them: polled for the contract, live from the stream for the price. Re-reads at most every 400 ms while ticks arrive. */
export function useLiveFutureContracts(enabled = true): FutureContracts | undefined {
  const polled = useFutureContracts(enabled).data;
  const { stream } = useStreamStatus();
  const version = useThrottledVersion(400);
  const streaming = stream?.effective_state === "streaming";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => overlayLiveFutures(polled, (k) => liveStore.getTick(k), streaming), [polled, streaming, version]);
}
