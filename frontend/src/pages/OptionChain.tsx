import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { ageSeconds, fmtAge, fmtDateTimeIST, fmtExpiry, fmtInt, fmtPrice } from "../lib/format";
import { useExpiries, useNow, useStatus } from "../lib/hooks";
import { ChainTable, isAtm, type LiveMode } from "../components/ChainTable";
import { StreamButtons } from "../components/LiveActivity";
import { useLiveAtmStrike, useStreamStatus } from "../lib/useLive";
import {
  Button, CompletenessText, EmptyState, ErrorNote, Panel, Skeleton, SourceTag,
} from "../components/ui";

type Mode = "weekly" | "monthly" | "manual";
const RANGES = [5, 10, 20] as const;

export function OptionChain() {
  const qc = useQueryClient();
  const now = useNow();
  const status = useStatus();
  const expiries = useExpiries();
  const exp = expiries.data;
  const { stream } = useStreamStatus();

  const [mode, setMode] = useState<Mode>("weekly");
  const [manual, setManual] = useState<string>("");
  const [range, setRange] = useState<number | "all">(10);
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  const [strikeFilter, setStrikeFilter] = useState("");

  const expiry =
    mode === "weekly" ? exp?.weekly : mode === "monthly" ? exp?.monthly : manual || exp?.available[0];

  const chain = useQuery({
    queryKey: ["chain", expiry],
    queryFn: () => api.optionChain(expiry!),
    enabled: !!expiry,
    retry: false,
  });
  const noSnapshot = chain.error instanceof ApiError && chain.error.code === "no_snapshot";

  const fetchChain = useMutation({
    mutationFn: () => api.capture(expiry!),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["snapshots"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const snap = chain.data?.snapshot;
  const streamActive = !!stream && ["streaming", "waiting_for_data", "reconnecting"].includes(stream.state);
  const liveMode: LiveMode = !streamActive || !snap
    ? "off"
    : stream.effective_state === "streaming" ? "fresh" : "stale";
  const strikes = useMemo(() => snap?.rows.map((r) => r.strike) ?? [], [snap]);
  const liveAtm = useLiveAtmStrike(strikes, liveMode === "fresh");
  const age = ageSeconds(snap?.retrieved_at, now);
  const staleAfter = status.data?.snapshot_stale_after_seconds ?? 300;
  const stale = !!snap && age != null && age > staleAfter;

  const { rows, atmStrike, hidden } = useMemo(() => {
    const all = snap?.rows ?? [];
    const brokerAtm = all.find(isAtm)?.strike ?? null;
    const atm = liveAtm ?? brokerAtm; // while streaming, ATM follows the live NIFTY price
    const atmIdx = atm == null ? -1 : all.findIndex((r) => r.strike === atm);
    let out = all;
    if (range !== "all" && atmIdx >= 0) out = all.slice(Math.max(0, atmIdx - range), atmIdx + range + 1);
    const f = strikeFilter.trim();
    if (f) out = out.filter((r) => String(r.strike).includes(f));
    return { rows: out, atmStrike: atmIdx >= 0 ? atm : null, hidden: all.length - out.length };
  }, [snap, range, strikeFilter, liveAtm]);

  const modeBtn = (m: Mode, label: string, date?: string | null) => (
    <button
      type="button"
      key={m}
      aria-pressed={mode === m}
      disabled={m !== "manual" && !date}
      onClick={() => setMode(m)}
      className={`min-h-9 rounded-sm border px-3 text-sm disabled:opacity-40 ${
        mode === m ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"
      }`}
    >
      {label}{date ? <span className="ml-1.5 text-xs text-muted">{fmtExpiry(date)}</span> : null}
    </button>
  );

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Live option chain</h1>
          <p className="text-sm text-muted">
            NIFTY 50 options. The latest snapshot is the base; while the stream runs, every live value updates from it.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <StreamButtons />
          <Button variant="primary" disabled={!expiry || fetchChain.isPending}
            onClick={() => fetchChain.mutate()}
            title="Fetch this expiry's chain from the data source now">
            {fetchChain.isPending ? "Fetching…" : "Refresh snapshot"}
          </Button>
        </div>
      </div>

      <Panel title="Controls">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div role="group" aria-label="Expiry" className="flex flex-wrap items-center gap-2">
            {modeBtn("weekly", "Weekly", exp?.weekly)}
            {modeBtn("monthly", "Monthly", exp?.monthly)}
            {modeBtn("manual", "Other expiry")}
            {mode === "manual" && (
              <select aria-label="Choose expiry" value={manual || exp?.available[0] || ""}
                onChange={(e) => setManual(e.target.value)}
                className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm">
                {exp?.available.map((d) => <option key={d} value={d}>{fmtExpiry(d)}</option>)}
              </select>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">
            Strikes around ATM
            <select aria-label="Strike range" value={String(range)}
              onChange={(e) => setRange(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
              {RANGES.map((n) => <option key={n} value={n}>±{n}</option>)}
              <option value="all">All</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            Strike contains
            <input inputMode="numeric" value={strikeFilter} onChange={(e) => setStrikeFilter(e.target.value)}
              placeholder="e.g. 245" aria-label="Filter strikes"
              className="num min-h-9 w-28 rounded-sm border border-rule bg-slate-2 px-2 text-paper" />
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)}
              className="accent-[var(--brass)]" /> Calls
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)}
              className="accent-[var(--brass)]" /> Puts
          </label>
        </div>
      </Panel>

      {fetchChain.error && (
        <ErrorNote title="Could not fetch the chain"
          message={fetchChain.error instanceof ApiError ? fetchChain.error.message : "Unknown error"} />
      )}

      <Panel
        title={expiry ? `Expiry ${fmtExpiry(expiry)}` : "Option chain"}
        actions={snap && (
          <div className="flex items-center gap-3 text-sm">
            <CompletenessText value={snap.completeness} />
            <SourceTag source={chain.data!.display_source} />
          </div>
        )}
      >
        {expiries.isLoading || (chain.isLoading && !!expiry) ? (
          <Skeleton className="h-64 w-full" />
        ) : expiries.error ? (
          <ErrorNote title="Could not load expiries"
            message={expiries.error instanceof ApiError ? expiries.error.message : "Unknown error"} />
        ) : !expiry ? (
          <EmptyState title="No expiry available">The data source returned no usable expiry dates.</EmptyState>
        ) : noSnapshot ? (
          <EmptyState title="No snapshot for this expiry yet"
            action={<Button variant="primary" onClick={() => fetchChain.mutate()} disabled={fetchChain.isPending}>
              {fetchChain.isPending ? "Fetching…" : "Fetch option chain"}</Button>}>
            Nothing has been captured for {fmtExpiry(expiry)}.
          </EmptyState>
        ) : chain.error ? (
          <ErrorNote title="Could not load the chain"
            message={chain.error instanceof ApiError ? chain.error.message : "Unknown error"} />
        ) : snap ? (
          <div className="flex flex-col gap-3">
            <div className={`rounded-sm border px-3 py-2 text-sm ${
              stale && liveMode !== "fresh" ? "border-warn/50 text-warn" : "border-rule text-muted"}`}>
              Base snapshot retrieved {fmtDateTimeIST(snap.retrieved_at)} ({fmtAge(age)}).
              {stale && liveMode !== "fresh" && " This snapshot is stale and nothing is streaming; start the stream or refresh the snapshot."}
              {chain.data!.display_source === "stored" && " Loaded from an earlier session: these are not current prices."}
              {" "}Exchange timestamp is not provided by the snapshot source.
              {snap.underlying_ltp != null && (
                <> NIFTY 50 at snapshot: <span className="num text-paper">{fmtPrice(snap.underlying_ltp)}</span>.</>
              )}
            </div>
            {liveMode !== "off" && (
              <p className={`text-sm ${liveMode === "stale" ? "text-warn" : "text-up"}`}>
                {liveMode === "fresh"
                  ? `Live: LTP, volume, OI, OI change, totals and the ATM strike update from the stream (last data ${stream?.data_age_seconds ?? 0}s ago).`
                  : `Stream is ${stream?.effective_state.replace("_", " ")}: live cells are dimmed and may be out of date. The ATM strike is from the snapshot.`}
              </p>
            )}
            {atmStrike == null && (
              <p className="text-sm text-warn">
                No ATM strike is available (no broker label and no live NIFTY price), so the range filter is off and all strikes are shown.
              </p>
            )}
            {!showCalls && !showPuts ? (
              <EmptyState title="Calls and puts are both hidden">Turn on Calls or Puts above.</EmptyState>
            ) : rows.length === 0 ? (
              <EmptyState title="No strikes match this filter">Clear the strike filter or widen the range.</EmptyState>
            ) : (
              <ChainTable rows={rows} allRows={snap.rows} showCalls={showCalls} showPuts={showPuts} liveMode={liveMode}
                atmStrike={atmStrike} atmLive={liveAtm != null} />
            )}
            <p className="text-xs text-muted">
              {rows.length} of {snap.rows.length} strikes shown{hidden > 0 ? ` (${hidden} hidden by filters)` : ""}.
              Lot size {fmtInt(snap.lot_size)}. ATM is the strike nearest the live NIFTY price while streaming, otherwise the broker's label from the snapshot. LTP chg = LTP vs previous close,
              shown only when both exist. Total rows add up OI and OI change for the strikes shown and, when filters hide some, for all strikes in the snapshot; † means some contracts had no value and were left out. — means missing at source; * means the source value failed validation.
            </p>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
