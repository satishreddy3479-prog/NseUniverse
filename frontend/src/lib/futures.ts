import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

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
