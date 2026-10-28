import { memo, useMemo, useRef, useSyncExternalStore } from "react";
import { fmtInt, fmtPct, fmtPrice, fmtSigned } from "../lib/format";
import { liveStore } from "../lib/liveStore";
import { useLiveTick } from "../lib/useLive";
import type { LiveTick, OptionChainRow, OptionQuote } from "../lib/types";

export type LiveMode = "off" | "fresh" | "stale";

export function liveKey(q: OptionQuote | null): string | null {
  return q && q.exchange_segment && q.instrument_token ? `${q.exchange_segment}|${q.instrument_token}` : null;
}

/** A streamed OI of 0 is not trusted over a positive snapshot OI: the feed's 0 can mean "not supplied"
 *  (unverified, audit F7). Otherwise streamed OI replaces the snapshot value. */
export function liveOiValue(q: OptionQuote, t: LiveTick | undefined): number | null {
  if (!t || t.oi == null) return null;
  if (t.oi === 0 && (q.oi ?? 0) > 0) return null;
  return t.oi;
}

/** Snapshot quote with the latest streamed values laid over it. OI change is recomputed as
 *  streamed OI minus the snapshot's previous-day OI (never taken from the source's own change field). */
export function overlay(q: OptionQuote | null, t: LiveTick | undefined): OptionQuote | null {
  if (!q || !t) return q;
  const oi = liveOiValue(q, t);
  const prev = q.oi_previous;
  const base = { ...q, ltp: t.ltp ?? q.ltp, volume: t.volume ?? q.volume };
  if (oi == null) return base;
  const change = prev != null ? oi - prev : null;
  return {
    ...base,
    oi,
    oi_change: change,
    oi_change_pct: change != null && prev != null && prev > 0 ? (change / prev) * 100 : null,
  };
}

/** Day change = LTP - previous close. Defined only when both are present and previous close > 0. */
export function dayChange(q: OptionQuote | null): { abs: number; pct: number } | null {
  if (!q || q.ltp == null || q.prev_close == null || q.prev_close <= 0) return null;
  const abs = q.ltp - q.prev_close;
  return { abs, pct: (abs / q.prev_close) * 100 };
}

export function isAtm(r: OptionChainRow): boolean {
  return r.call?.moneyness === "ATM" || r.put?.moneyness === "ATM";
}

export interface OiTotals {
  oi: number | null;
  oiChange: number | null;
  /** Contracts left out of a sum because the value was missing at source. */
  missingOi: number;
  missingChange: number;
}

/** Sum OI and OI change over one side. Missing values are skipped and counted, never treated as 0;
 *  a sum is null only when no contract had a value. */
export function sumOi(rows: OptionChainRow[], side: "call" | "put"): OiTotals {
  let oi = 0, oiChange = 0, haveOi = 0, haveChange = 0, missingOi = 0, missingChange = 0;
  for (const r of rows) {
    const q = side === "call" ? r.call : r.put;
    if (q?.oi != null) { oi += q.oi; haveOi++; } else missingOi++;
    if (q?.oi_change != null) { oiChange += q.oi_change; haveChange++; } else missingChange++;
  }
  return {
    oi: haveOi ? oi : null,
    oiChange: haveChange ? oiChange : null,
    missingOi,
    missingChange,
  };
}

function tone(v: number | null | undefined): string {
  return v == null || v === 0 ? "" : v > 0 ? "text-up" : "text-down";
}

function Num({ v, kind, invalid, className = "", flash, title }: {
  v: number | null; kind: "price" | "int" | "signed" | "pct"; invalid?: boolean; className?: string;
  flash?: "up" | "down"; title?: string;
}) {
  const text = kind === "price" ? fmtPrice(v) : kind === "int" ? fmtInt(v) : kind === "pct" ? fmtPct(v) : fmtSigned(v);
  const color = kind === "signed" || kind === "pct" ? tone(v) : "";
  return (
    <td className={`px-2 py-1.5 text-right ${color} ${v == null ? "text-muted" : ""} ${flash ? `flash-${flash}` : ""} ${className}`}
      title={invalid ? "Invalid value from source; shown as missing" : title}>
      {text}{invalid && <span className="ml-0.5 text-warn">*</span>}
    </td>
  );
}

function Side({ q, side, tick, mode }: {
  q: OptionQuote | null; side: "call" | "put"; tick: LiveTick | undefined; mode: LiveMode;
}) {
  const prevLtp = useRef<number | null>(null);
  const merged = mode === "off" ? q : overlay(q, tick);
  const chg = dayChange(merged);
  const inv = (k: string) => !!q?.invalid_fields.includes(k);
  const liveCell = mode !== "off" && !!tick;
  const dim = liveCell && mode === "stale" ? "opacity-60" : "";
  let flash: "up" | "down" | undefined;
  if (liveCell && tick.ltp != null) {
    if (prevLtp.current != null && tick.ltp !== prevLtp.current) flash = tick.ltp > prevLtp.current ? "up" : "down";
    prevLtp.current = tick.ltp;
  }
  const liveOi = mode !== "off" && !!q && liveOiValue(q, tick) != null;
  const oi = (
    <Num key="oi" v={merged?.oi ?? null} kind="int" invalid={inv("oi")} className={liveOi ? dim : ""}
      title={liveOi ? "Live open interest from the stream (units)" : undefined} />
  );
  const oic = (
    <Num key="oic" v={merged?.oi_change ?? null} kind="signed" invalid={inv("oi_change")}
      className={liveOi ? dim : ""}
      title={liveOi ? "Streamed OI minus previous-day OI from the snapshot" : undefined} />
  );
  const vol = (
    <Num key="vol" v={merged?.volume ?? null} kind="int" invalid={inv("volume")} className={dim}
      title={liveCell ? "Live volume from the stream (units)" : undefined} />
  );
  const ltp = (
    <Num key={`ltp-${tick?.seq ?? 0}`} v={merged?.ltp ?? null} kind="price" invalid={inv("ltp")}
      flash={flash} className={`font-medium ${dim}`}
      title={liveCell ? "Live last traded price from the stream" : undefined} />
  );
  const pct = <Num key="pct" v={chg?.pct ?? null} kind="pct" className={dim} />;
  return <>{side === "call" ? [oi, oic, vol, pct, ltp] : [ltp, pct, vol, oic, oi]}</>;
}

const ChainRow = memo(function ChainRow({ row, showCalls, showPuts, mode, atm, atmLive, selected, onSelect }: {
  row: OptionChainRow; showCalls: boolean; showPuts: boolean; mode: LiveMode; atm: boolean; atmLive: boolean;
  selected: boolean; onSelect?: (strike: number) => void;
}) {
  const callTick = useLiveTick(mode === "off" ? null : liveKey(row.call));
  const putTick = useLiveTick(mode === "off" ? null : liveKey(row.put));
  return (
    <tr
      className={`border-b border-rule/50 ${atm ? "bg-brass/10" : ""} ${selected ? "outline outline-1 -outline-offset-1 outline-info" : ""} ${onSelect ? "cursor-pointer hover:bg-slate-2" : ""}`}
      aria-selected={onSelect ? selected : undefined}
      onClick={onSelect ? () => onSelect(row.strike) : undefined}
    >
      {showCalls && <Side q={row.call} side="call" tick={callTick} mode={mode} />}
      <td className={`border-x border-rule px-3 py-1.5 text-center font-semibold ${atm ? "text-brass" : ""}`}>
        {fmtInt(row.strike)}
        {atm && (
          <span className="ml-1 text-xs font-normal"
            title={atmLive ? "Nearest strike to the live NIFTY price" : "Broker's ATM label from the snapshot"}>
            ATM
          </span>
        )}
      </td>
      {showPuts && <Side q={row.put} side="put" tick={putTick} mode={mode} />}
    </tr>
  );
});

function TotalCells({ t, side }: { t: OiTotals; side: "call" | "put" }) {
  const note = (n: number) => (n > 0 ? `Excludes ${n} contract${n === 1 ? "" : "s"} with no value at source` : undefined);
  const oi = (
    <td key="oi" title={note(t.missingOi)} className="px-2 py-1.5 text-right font-semibold">
      {fmtInt(t.oi)}{t.missingOi > 0 && t.oi != null && <span className="ml-0.5 text-warn">†</span>}
    </td>
  );
  const chg = (
    <td key="chg" title={note(t.missingChange)}
      className={`px-2 py-1.5 text-right font-semibold ${tone(t.oiChange)}`}>
      {fmtSigned(t.oiChange)}{t.missingChange > 0 && t.oiChange != null && <span className="ml-0.5 text-warn">†</span>}
    </td>
  );
  const pad = [<td key="p1" className="px-2 py-1.5" />, <td key="p2" className="px-2 py-1.5" />, <td key="p3" className="px-2 py-1.5" />];
  return <>{side === "call" ? [oi, chg, ...pad] : [...pad, chg, oi]}</>;
}

const HELP: Record<string, string> = {
  OI: "Open interest: contracts outstanding (from the broker).",
  "OI chg": "Open interest now minus previous-day open interest (computed here from the two OI values).",
  Volume: "Contracts traded today.",
  "LTP chg": "Last traded price vs previous close, as a percentage. Shown only when both prices exist.",
  LTP: "Last traded price (INR).",
};

export function mergeRows(rows: OptionChainRow[], mode: LiveMode): OptionChainRow[] {
  if (mode === "off") return rows;
  return rows.map((r) => {
    const ck = liveKey(r.call);
    const pk = liveKey(r.put);
    return {
      ...r,
      call: overlay(r.call, ck ? liveStore.getTick(ck) : undefined),
      put: overlay(r.put, pk ? liveStore.getTick(pk) : undefined),
    };
  });
}

export function ChainTable({ rows, allRows, showCalls, showPuts, liveMode = "off", atmStrike = null, atmLive = false, selectedStrike = null, onSelectStrike, maxHeight = "max-h-[68vh]" }: {
  rows: OptionChainRow[]; allRows?: OptionChainRow[]; showCalls: boolean; showPuts: boolean;
  liveMode?: LiveMode; atmStrike?: number | null; atmLive?: boolean;
  selectedStrike?: number | null; onSelectStrike?: (strike: number) => void; maxHeight?: string;
}) {
  // Totals depend on many instruments: recompute when any tick batch lands (batches arrive ~4x/s).
  const version = useSyncExternalStore(liveStore.subscribeAny, liveStore.getVersion);
  const { shown, all, showAll } = useMemo(() => {
    const r = mergeRows(rows, liveMode);
    const a = allRows ? mergeRows(allRows, liveMode) : r;
    return {
      shown: { call: sumOi(r, "call"), put: sumOi(r, "put") },
      all: { call: sumOi(a, "call"), put: sumOi(a, "put") },
      showAll: !!allRows && allRows.length !== rows.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, allRows, liveMode, version]);
  const totalRow = (label: string, t: { call: OiTotals; put: OiTotals }, key: string) => (
    <tr key={key} className="border-t border-rule bg-slate-2">
      {showCalls && <TotalCells t={t.call} side="call" />}
      <td className="border-x border-rule px-3 py-1.5 text-center text-xs font-medium text-muted">{label}</td>
      {showPuts && <TotalCells t={t.put} side="put" />}
    </tr>
  );
  const callCols = ["OI", "OI chg", "Volume", "LTP chg", "LTP"];
  const putCols = ["LTP", "LTP chg", "Volume", "OI chg", "OI"];
  const th = (h: string, k: string) => (
    <th key={k} title={HELP[h]} className="px-2 py-1.5 text-right font-medium">{h}</th>
  );
  return (
    <div className={`${maxHeight} overflow-auto rounded-sm border border-rule`}>
      <table className="num w-full min-w-[820px] text-sm">
        <caption className="sr-only">Option chain, calls on the left, strike in the centre, puts on the right</caption>
        <thead className="sticky top-0 z-10 bg-slate-2 text-xs text-muted">
          <tr>
            {showCalls && <th colSpan={5} className="border-b border-rule px-2 py-1.5 text-left font-medium text-paper">Calls (CE)</th>}
            <th className="border-b border-rule px-2 py-1.5" />
            {showPuts && <th colSpan={5} className="border-b border-rule px-2 py-1.5 text-right font-medium text-paper">Puts (PE)</th>}
          </tr>
          <tr className="border-b border-rule">
            {showCalls && callCols.map((h) => th(h, `c${h}`))}
            <th className="px-3 py-1.5 text-center font-medium text-paper">Strike</th>
            {showPuts && putCols.map((h) => th(h, `p${h}`))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ChainRow key={r.strike} row={r} showCalls={showCalls} showPuts={showPuts} mode={liveMode}
              atm={atmStrike != null && r.strike === atmStrike} atmLive={atmLive}
              selected={selectedStrike === r.strike} onSelect={onSelectStrike} />
          ))}
        </tbody>
        <tfoot className="sticky bottom-0 z-10">
          {totalRow(showAll ? `Total, ${rows.length} shown` : "Total", shown, "shown")}
          {showAll && totalRow(`Total, all ${allRows!.length}`, all, "all")}
        </tfoot>
      </table>
    </div>
  );
}
