import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Re-render every `ms` so relative ages stay honest without refetching. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5000 });

export const useExpiries = () =>
  useQuery({ queryKey: ["expiries"], queryFn: () => api.expiries(), staleTime: 60_000 });

export const useSnapshots = () =>
  useQuery({ queryKey: ["snapshots"], queryFn: () => api.snapshots(50), refetchInterval: 15000 });

/**
 * A value that follows `value` at most once per `ms` (the newest value always arrives, never an old one), and at
 * once when `resetKey` changes. Used so a chart fed by live ticks redraws calmly instead of on every tick.
 */
export function useThrottledValue<T>(value: T, ms: number, resetKey: unknown = null): T {
  const [out, setOut] = useState(value);
  const last = useRef({ at: 0, key: resetKey });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const now = Date.now();
    if (last.current.key !== resetKey || now - last.current.at >= ms) {
      last.current = { at: now, key: resetKey };
      setOut(value);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = { at: Date.now(), key: resetKey }; setOut(value); }, ms - (now - last.current.at));
    return () => clearTimeout(timer.current);
  }, [value, ms, resetKey]);
  return out;
}
