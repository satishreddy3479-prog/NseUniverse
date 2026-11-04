import { useMemo, useState } from "react";
import { EmptyState, Button, Panel } from "../ui";
import { fmtPrice } from "../../lib/format";
import {
  exitLabel, filterTrades, NO_FILTER, pct, plain, signedRupees, sortBy, tradesToCsv, type SortDir, type TradeFilter,
} from "../../lib/swing";
import type { SwingReport, SwingTrade } from "../../lib/types";
import { SortTh, TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const PAGE = 25;
const KEYS: Record<string, (t: SwingTrade) => number | string | null> = {
  symbol: (t) => t.symbol, entry_date: (t) => t.entry_date, score: (t) => t.score, pnl: (t) => t.pnl,
  return_pct: (t) => t.return_pct, r_mult: (t) => t.r_mult, hold_days: (t) => t.hold_days,
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const sel = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

export function SwingTrades({ report }: { report: SwingReport }) {
  const [f, setF] = useState<TradeFilter>(NO_FILTER);
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({ key: "entry_date", dir: "desc" });
  const [page, setPage] = useState(0);
  const years = useMemo(() => [...new Set(report.trades.map((t) => t.entry_date.slice(0, 4)))].sort(), [report.trades]);
  const reasons = useMemo(() => [...new Set(report.trades.map((t) => t.reason))].sort(), [report.trades]);
  const archetypes = useMemo(() => [...new Set(report.trades.map((t) => t.archetype))].sort(), [report.trades]);
  const rows = useMemo(() => sortBy(filterTrades(report.trades, f), KEYS[sort.key] ?? KEYS.entry_date!, sort.dir), [report.trades, f, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const shown = rows.slice(cur * PAGE, cur * PAGE + PAGE);
  const total = rows.reduce((s, t) => s + t.pnl, 0);
  const wins = rows.filter((t) => t.pnl > 0).length;
  const set = (patch: Partial<TradeFilter>) => { setF((x) => ({ ...x, ...patch })); setPage(0); };
  const onSort = (k: string) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "symbol" ? "asc" : "desc" }));
  const th = { sortKey: sort.key, dir: sort.dir, onSort };
  const filtered = f.reason || f.year || f.archetype || f.query;
  return (
    <Panel
      title="Backtest trades (before costs)"
      actions={
        <Button onClick={() => download(`swing-backtest-trades${filtered ? "-filtered" : ""}.csv`, tradesToCsv(rows))} disabled={rows.length === 0} title="Download the rows that match the filters">
          Download CSV ({rows.length})
        </Button>
      }
    >
      <form className="mb-3 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Trade filters">
        <label className="flex flex-col gap-1 text-xs text-muted">Symbol
          <input value={f.query} onChange={(e) => set({ query: e.target.value })} placeholder="e.g. TITAN" className={`${sel} w-36`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Entry year
          <select value={f.year} onChange={(e) => set({ year: e.target.value })} className={sel}>
            <option value="">All</option>{years.map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Exit
          <select value={f.reason} onChange={(e) => set({ reason: e.target.value })} className={sel}>
            <option value="">All</option>{reasons.map((r) => <option key={r} value={r}>{exitLabel(r)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Pattern
          <select value={f.archetype} onChange={(e) => set({ archetype: e.target.value })} className={sel}>
            <option value="">All</option>{archetypes.map((a) => <option key={a} value={a}>{a.replace("_", " ").toLowerCase()}</option>)}
          </select>
        </label>
        <Button onClick={() => set(NO_FILTER)} disabled={!filtered}>Clear filters</Button>
      </form>
      <p className="num mb-2 text-sm text-muted" aria-live="polite">
        {rows.length} of {report.trades.length} trades · {rows.length ? `${((wins / rows.length) * 100).toFixed(0)}% won · net ` : ""}
        {rows.length ? <span className={total >= 0 ? "text-up" : "text-down"}>{signedRupees(total)}</span> : null}
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No trades match these filters" />
      ) : (
        <>
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[900px] text-sm">
              <caption className="sr-only">Backtest trades</caption>
              <thead className={THEAD}>
                <tr>
                  <SortTh label="Stock" k="symbol" align="left" {...th} />
                  <SortTh label="Entry" k="entry_date" align="left" {...th} />
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Entry price</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Initial stop</th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Exit</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Exit price</th>
                  <SortTh label="Days" k="hold_days" {...th} />
                  <SortTh label="Return" k="return_pct" {...th} />
                  <SortTh label="R" k="r_mult" {...th} title="Profit as a multiple of the initial risk" />
                  <SortTh label="P&L" k="pnl" {...th} />
                  <SortTh label="Score" k="score" {...th} />
                </tr>
              </thead>
              <tbody>
                {shown.map((t, i) => (
                  <tr key={`${t.symbol}-${t.entry_date}-${i}`} className="border-t border-rule">
                    <th scope="row" className={`${TD_L} font-medium text-paper`}>{t.symbol}</th>
                    <td className={TD_L}>{t.entry_date}</td>
                    <td className={TD}>{fmtPrice(t.entry)}</td>
                    <td className={TD}>{fmtPrice(t.initial_sl)}</td>
                    <td className={TD_L}>{exitLabel(t.reason)}<span className="text-muted"> · {t.exit_date ?? "—"}</span></td>
                    <td className={TD}>{t.exit == null ? "—" : fmtPrice(t.exit)}</td>
                    <td className={TD}>{t.hold_days}</td>
                    <td className={`${TD} ${(t.return_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>{pct(t.return_pct, 2)}</td>
                    <td className={TD}>{plain(t.r_mult)}</td>
                    <td className={`${TD} ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{signedRupees(t.pnl)}</td>
                    <td className={TD}>{t.score.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Trade pages" className="mt-3 flex items-center justify-between gap-3 text-sm">
            <Button onClick={() => setPage(cur - 1)} disabled={cur === 0}>Previous</Button>
            <span className="num text-muted">Page {cur + 1} of {pages}</span>
            <Button onClick={() => setPage(cur + 1)} disabled={cur >= pages - 1}>Next</Button>
          </nav>
        </>
      )}
    </Panel>
  );
}
