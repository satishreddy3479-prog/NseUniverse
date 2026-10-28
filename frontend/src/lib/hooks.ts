import { useEffect, useState } from "react";
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
