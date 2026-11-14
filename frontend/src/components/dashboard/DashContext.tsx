import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { computeTotals, universeRows, type Totals, type TsRange } from "../../lib/analytics";
import { liveStore } from "../../lib/liveStore";
import { useThrottledValue } from "../../lib/hooks";
import { clipObservations } from "../../lib/replay";
import { useReplay } from "./ReplayContext";
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
  /** The stored history as the page may show it: while a replay runs, cut at the replay time. */
  history: UseQueryResult<HistoryResponse>;
  /** The stored history whole, whatever the replay time is (the replay bar reads its steps from here). */
  historyRaw: UseQueryResult<HistoryResponse>;
  universeLabel: string;
  /** Time window of the time-series widgets (shared by all of them). */
  tsRange: TsRange;
  setTsRange: (r: TsRange) => void;
}

const Ctx = createContext<DashState | null>(null);

export function useDash(): DashState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDash must be used inside DashProvider");
  return v;
}

/** Re-render at most every `ms` while ticks arrive; aggregates over many instruments do not need 4 Hz. */
export function useThrottledVersion(ms: number): number {
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
  const [tsRange, setRange] = useState<TsRange>(() => {
    try {
      const v = localStorage.getItem("nse.analysis.tsrange");
      return v === "30m" || v === "1h" || v === "all" ? v : "session";
    } catch { return "session"; }
  });
  const setTsRange = (r: TsRange) => {
    setRange(r);
    try { localStorage.setItem("nse.analysis.tsrange", r); } catch { /* storage unavailable: applies to this visit only */ }
  };

  const chain = useQuery({
    queryKey: ["chain", expiry],
    queryFn: () => api.optionChain(expiry!),
    enabled: !!expiry,
    // the sampler stores a new snapshot every minute in market hours; pick it up so the page is never minutes behind
    refetchInterval: 15_000,
    retry: false,
  });
  const historyRaw = useQuery({
    queryKey: ["history", expiry, range === "all" ? 100 : range],
    queryFn: () => api.history(expiry!, range === "all" ? 100 : range),
    enabled: !!expiry,
    refetchInterval: 15_000,
    retry: false,
  });

  // While a replay runs the chain is the stored snapshot of the replay time, not the latest one, and nothing live is laid over it:
  // every widget that reads the chain (strikes, ATM, totals, greeks) then shows the page as it was at that moment.
  const replay = useReplay();
  const replayOn = replay.on;
  const replayId = useMemo(() => {
    const obs = historyRaw.data?.observations;
    if (!replayOn || replay.cutMs == null || !obs?.length) return null;
    let id: string | null = null;
    for (const o of obs) { if (Date.parse(o.retrieved_at) <= replay.cutMs) id = o.snapshot_id; else break; }
    return id;
  }, [replayOn, replay.cutMs, historyRaw.data]);
  const shownId = useThrottledValue(replayId, 700); // a stored chain is a file read on the server: at most about one a second while playing
  const replayChain = useQuery({
    queryKey: ["replaySnapshot", shownId], queryFn: () => api.snapshot(shownId!), enabled: replayOn && !!shownId,
    staleTime: Infinity, placeholderData: keepPreviousData, retry: false,
  });
  // a stored chain that cannot be read (its file was cleaned up, a failed request) must not blank the page: the last chain that did load stays
  // until one loads again, and the replay bar says nothing newer was available
  const lastGood = useRef<ChainResponse | undefined>(undefined);
  if (replayOn && replayChain.data) lastGood.current = replayChain.data;
  if (!replayOn) lastGood.current = undefined;
  const replayShown = replayOn && !replayChain.data && lastGood.current
    ? ({ ...replayChain, data: lastGood.current, error: null, isError: false, isPending: false, isLoading: false } as unknown as typeof replayChain)
    : replayChain;
  const chainShown = (replayOn ? replayShown : chain) as typeof chain;
  const snapshot = chainShown.data?.snapshot;
  const noSnapshot = !replayOn && chain.error instanceof ApiError && chain.error.code === "no_snapshot";

  const fetch = useMutation({
    mutationFn: () => api.capture(expiry!),
    onSettled: () => {
      for (const k of ["chain", "snapshots", "status", "history"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  const streamActive = !!stream && ["streaming", "waiting_for_data", "reconnecting"].includes(stream.state);
  const liveMode: LiveMode = replayOn || !streamActive || !snapshot ? "off" : stream.effective_state === "streaming" ? "fresh" : "stale";

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


  // while a replay runs every widget reading the history sees it cut at the replay time: the replayed day up to that moment, earlier days whole, nothing later
  const { cutMs } = useReplay();
  const history = useMemo(() => {
    if (cutMs == null || !historyRaw.data) return historyRaw;
    return { ...historyRaw, data: { ...historyRaw.data, observations: clipObservations(historyRaw.data.observations, cutMs) } } as typeof historyRaw;
  }, [historyRaw, cutMs]);

  const universeLabel = range === "all" ? `all ${rows.length} listed strikes` : `ATM ±${range} (${view.length} strikes)`;

  const value: DashState = {
    expiry, chain: chainShown, snapshot, noSnapshot, fetchChain: () => fetch.mutate(), fetching: fetch.isPending,
    fetchError: fetch.error ? (fetch.error instanceof ApiError ? fetch.error.message : "Unknown error") : null,
    liveMode, rows, view, totals, atmStrike, atmLive: liveAtm != null, range, showCalls, showPuts,
    selected, select, history, historyRaw, universeLabel, tsRange, setTsRange,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The dashboard state when a page is inside a DashProvider, otherwise null (pages that can also run on stored data alone). */
export function useDashOptional(): DashState | null {
  return useContext(Ctx);
}
