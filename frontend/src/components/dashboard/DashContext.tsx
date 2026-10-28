import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { computeTotals, universeRows, type Totals } from "../../lib/analytics";
import { liveStore } from "../../lib/liveStore";
import { useLiveAtmStrike, useStreamStatus } from "../../lib/useLive";
import { isAtm, mergeRows, type LiveMode } from "../ChainTable";
import type { ChainResponse, HistoryResponse, OptionChainRow, OptionChainSnapshot } from "../../lib/types";

export type Range = number | "all";

export interface DashState {
  expiry: string | null;
  chain: UseQueryResult<ChainResponse>;
  snapshot: OptionChainSnapshot | undefined;
  noSnapshot: boolean;
  fetchChain: () => void;
  fetching: boolean;
  fetchError: string | null;
  liveMode: LiveMode;
  /** Every strike in the snapshot with live values laid over it. */
  rows: OptionChainRow[];
  /** The strike universe chosen in the toolbar (ATM +/- N). */
  view: OptionChainRow[];
  totals: Totals;
  atmStrike: number | null;
  atmLive: boolean;
  range: Range;
  showCalls: boolean;
  showPuts: boolean;
  selected: number | null;
  select: (strike: number | null) => void;
  history: UseQueryResult<HistoryResponse>;
  universeLabel: string;
}

const Ctx = createContext<DashState | null>(null);

export function useDash(): DashState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDash must be used inside DashProvider");
  return v;
}

/** Re-render at most every `ms` while ticks arrive; aggregates over many instruments do not need 4 Hz. */
function useThrottledVersion(ms: number): number {
  const [v, setV] = useState(liveStore.getVersion());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = liveStore.subscribeAny(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        setV(liveStore.getVersion());
      }, ms);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [ms]);
  return v;
}

export function DashProvider({ expiry, range, showCalls, showPuts, children }: {
  expiry: string | null; range: Range; showCalls: boolean; showPuts: boolean; children: ReactNode;
}) {
  const qc = useQueryClient();
  const { stream } = useStreamStatus();
  const [selected, select] = useState<number | null>(null);

  const chain = useQuery({
    queryKey: ["chain", expiry],
    queryFn: () => api.optionChain(expiry!),
    enabled: !!expiry,
    retry: false,
  });
  const snapshot = chain.data?.snapshot;
  const noSnapshot = chain.error instanceof ApiError && chain.error.code === "no_snapshot";

  const fetch = useMutation({
    mutationFn: () => api.capture(expiry!),
    onSettled: () => {
      for (const k of ["chain", "snapshots", "status", "history"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  const streamActive = !!stream && ["streaming", "waiting_for_data", "reconnecting"].includes(stream.state);
  const liveMode: LiveMode = !streamActive || !snapshot ? "off" : stream.effective_state === "streaming" ? "fresh" : "stale";

  const strikes = useMemo(() => snapshot?.rows.map((r) => r.strike) ?? [], [snapshot]);
  const liveAtm = useLiveAtmStrike(strikes, liveMode === "fresh");
  const brokerAtm = useMemo(() => snapshot?.rows.find(isAtm)?.strike ?? null, [snapshot]);
  const atmStrike = liveAtm ?? brokerAtm;

  const version = useThrottledVersion(400);
  const rows = useMemo(
    () => (snapshot ? mergeRows(snapshot.rows, liveMode) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, liveMode, version],
  );
  const view = useMemo(() => universeRows(rows, atmStrike, range), [rows, atmStrike, range]);
  const totals = useMemo(() => computeTotals(view), [view]);

  const history = useQuery({
    queryKey: ["history", expiry, range === "all" ? 100 : range],
    queryFn: () => api.history(expiry!, range === "all" ? 100 : range),
    enabled: !!expiry,
    refetchInterval: 30_000,
    retry: false,
  });

  const universeLabel = range === "all" ? `all ${rows.length} listed strikes` : `ATM ±${range} (${view.length} strikes)`;

  const value: DashState = {
    expiry, chain, snapshot, noSnapshot, fetchChain: () => fetch.mutate(), fetching: fetch.isPending,
    fetchError: fetch.error ? (fetch.error instanceof ApiError ? fetch.error.message : "Unknown error") : null,
    liveMode, rows, view, totals, atmStrike, atmLive: liveAtm != null, range, showCalls, showPuts,
    selected, select, history, universeLabel,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
