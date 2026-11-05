import { useMemo, type ReactNode } from "react";
import { EChart, useChartColors } from "../EChart";
import { Button, EmptyState, Panel } from "../ui";
import { fmtDateTimeIST, fmtInt, fmtPrice } from "../../lib/format";
import { exitLabel, fmtStamp, isStale, pct, plain, reportAgeDays, resultText, rupees, SECTOR_NAME, signedRupees } from "../../lib/swing";
import { paperEquityOption } from "../../lib/swingCharts";
import type { SwingPaperView } from "../../lib/types";
import { Stat, TABLE_WRAP, TD, TD_L, THEAD, Verdict, When } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";
const tone = (v: number) => (v >= 0 ? "text-up" : "text-down");

export interface RunNote { kind: "info" | "error"; text: string }

export function SwingPaper({ view, onRun, runPending, runNote, live }: {
  view: SwingPaperView; onRun: () => void; runPending: boolean; runNote: RunNote | null; live?: ReactNode;
}) {
  const colors = useChartColors();
  const opt = useMemo(() => paperEquityOption(view, colors), [view, colors]);
  const { book, status, scan } = view;
  const t = view.trade_totals;
  const never = book.sessions === 0;
  const stale = book.as_of != null && isStale(book.as_of);
  return (
    <>
      <div role="note" className="rounded-sm border border-info/40 bg-info/10 px-3 py-2 text-sm">
        <p className="font-medium text-paper">Paper trading: simulated, no real orders</p>
        <p className="mt-1 text-muted">
          After each close (from {status.runs_after_ist} IST) the scanner reads your Chartink list, judges last night&apos;s orders
          against today&apos;s bar, applies the stops, and queues orders for the next session. Fills are simulated on the daily bar at
          the rule prices with {view.config.cost_per_side_pct}% costs per side; real fills can be worse. Virtual capital {rupees(view.config.capital)}.
        </p>
      </div>

      {stale && (
        <div role="alert" className="rounded-sm border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
          <p className="font-medium text-warn">Stale: the paper book was last updated for {book.as_of} ({reportAgeDays(book.as_of!)} days ago)</p>
          <p className="text-paper">Last result: {status.last_result}. The job retries every 15 minutes after {status.runs_after_ist} IST on trading days.</p>
        </div>
      )}

      <Panel
        title="Scanner status"
        actions={
          <Button onClick={onRun} disabled={status.running || runPending} title="Runs the same scan the schedule runs after 17:00 IST, on the last finished session">
            {status.running || runPending ? "Scan running…" : "Run scan now"}
          </Button>
        }
      >
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-muted">Auto mode</dt><dd>{status.enabled ? "On" : "Off (disabled in settings)"}</dd></div>
          <div><dt className="text-muted">Last run</dt><dd className="num">{status.last_run_at ? fmtDateTimeIST(status.last_run_at) : "Not yet"}</dd></div>
          <div><dt className="text-muted">Last result</dt><dd>{resultText(status.last_result)}</dd></div>
          <div><dt className="text-muted">Book started</dt><dd className="num">{book.started ?? "Waiting for the first run"}</dd></div>
        </dl>
        {status.running && (
          <p className="mt-3 text-sm" role="status" data-testid="scan-progress">
            <span className="text-warn">●</span> Running now: {status.progress?.phase ?? "starting"}
            {status.progress?.done != null && status.progress.total != null ? ` (${status.progress.done} of ${status.progress.total})` : ""}
          </p>
        )}
        {runNote && (runNote.kind === "error" || status.running || runPending) && (
          <p role={runNote.kind === "error" ? "alert" : "status"} className={`mt-2 text-sm ${runNote.kind === "error" ? "text-down" : "text-muted"}`}>{runNote.text}</p>
        )}
        {!status.running && !runPending && (
          <p className="mt-3 max-w-[75ch] text-xs text-muted">
            The scan also runs by itself after {status.runs_after_ist} IST. Before then &ldquo;Run scan now&rdquo; uses the last finished session; it takes about 9 minutes the first time and seconds when nothing is new.
          </p>
        )}
      </Panel>

      {live}

      {never ? (
        <Panel title="Paper book">
          <EmptyState title="The scanner has not run yet">
            <p>The first run after {status.runs_after_ist} IST on a trading day starts the book, scans your Chartink list and queues the first orders. Nothing here is estimated or back-filled.</p>
          </EmptyState>
        </Panel>
      ) : (
        <>
          <section aria-label="Paper book figures" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={`Equity after ${book.sessions} session${book.sessions === 1 ? "" : "s"}`} value={rupees(book.equity)} sub={`as of ${book.as_of}`} />
            <Stat label="Return since start" value={pct(book.return_pct, 2)} tone={book.return_pct >= 0 ? "up" : "down"} sub={book.nifty_return_pct == null ? undefined : `NIFTY 50: ${pct(book.nifty_return_pct, 2)}`} />
            <Stat label="Cash" value={rupees(book.cash)} sub={`${rupees(book.invested)} invested`} />
            <Stat label="Open positions" value={`${book.open_positions} of ${book.slots}`} />
            <Stat label="Closed trades" value={String(t.closed)} sub={t.closed ? `${((t.wins / t.closed) * 100).toFixed(0)}% won` : "none yet"} />
            <Stat label="Closed P&L after costs" value={signedRupees(t.net_pnl)} tone={t.net_pnl >= 0 ? "up" : "down"} sub={`costs ${rupees(t.costs)}`} />
          </section>

          <Panel title="Paper book vs NIFTY 50">
            {view.equity.length < 2 ? (
              <p className="text-sm text-muted">The curve needs at least two sessions. Today&apos;s starting value is {rupees(book.equity)}.</p>
            ) : (
              <div className="h-[260px]"><EChart option={opt} ariaLabel="Paper book equity against NIFTY 50" /></div>
            )}
          </Panel>
        </>
      )}

      <Panel title={`Open positions (${view.positions.length} of ${book.slots})`}>
        {view.positions.length === 0 ? (
          <EmptyState title="No open positions">{never ? "Positions appear after the first orders are filled." : "Slots are empty until a queued order triggers."}</EmptyState>
        ) : (
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[820px] text-sm">
              <caption className="sr-only">Open paper positions</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className={TH_L}>Stock</th><th scope="col" className={TH_L}>Entered</th>
                  <th scope="col" className={TH_R}>Fill</th><th scope="col" className={TH_R}>Shares</th>
                  <th scope="col" className={TH_R}>Last close</th><th scope="col" className={TH_R}>Unrealised</th>
                  <th scope="col" className={TH_R}>Stop</th><th scope="col" className={TH_L}>Stop stage</th>
                  <th scope="col" className={TH_R}>Room to stop</th></tr>
              </thead>
              <tbody>
                {view.positions.map((p) => (
                  <tr key={p.symbol} className="border-t border-rule">
                    <th scope="row" className={`${TD_L} font-medium text-paper`}>{p.symbol}</th>
                    <td className={TD_L}><When day={p.entry_session} seen={p.entry_seen_at} seenLabel="live trigger" booked={p.entered_booked_at} /></td>
                    <td className={TD}>{fmtPrice(p.fill)}</td><td className={TD}>{fmtInt(p.shares)}</td>
                    <td className={TD}>{fmtPrice(p.last_close)}</td>
                    <td className={`${TD} ${tone(p.unrealized_pnl)}`}>{signedRupees(p.unrealized_pnl)} ({pct(p.unrealized_pct, 1)})</td>
                    <td className={TD}>{fmtPrice(p.tsl)}</td>
                    <td className={TD_L}>{p.stop_stage}</td>
                    <td className={TD}>{p.risk_to_stop_pct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={scan ? `Orders for the next session · scan of ${scan.session}${view.orders[0]?.scanned_at ? ` (recorded ${fmtStamp(view.orders[0].scanned_at)})` : ""}` : "Orders for the next session"}>
        <p className="mb-3 max-w-[75ch] text-sm text-muted">
          Queued automatically at the close and recorded permanently. Next session each is taken only if the price trades through the trigger,
          the open is no higher than the &ldquo;do not chase&rdquo; price, volume reaches the minimum, a slot is free and the stock is out of its
          {` ${view.config.cooldown}`}-session cooldown. Size = the smaller of {view.config.risk_pct}% of equity at risk ÷ (fill − stop) and 1/{view.config.slots} of equity.
        </p>
        {view.orders.length === 0 ? (
          <EmptyState title={scan ? "No stock passed every rule at this close" : "Nothing queued"}>
            {scan && scan.blocked_by_gate > 0 ? `${scan.blocked_by_gate} stock(s) would qualify but the market or sector gate is closed.` : "Check again after the next close."}
          </EmptyState>
        ) : (
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[960px] text-sm">
              <caption className="sr-only">Orders queued for the next session</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className={TH_R}>#</th><th scope="col" className={TH_L}>Stock</th><th scope="col" className={TH_L}>Sector index</th>
                  <th scope="col" className={TH_L}>Pattern</th><th scope="col" className={TH_R}>Score</th><th scope="col" className={TH_R}>Close</th>
                  <th scope="col" className={TH_R}>Trigger</th><th scope="col" className={TH_R}>Do not chase above</th>
                  <th scope="col" className={TH_R}>Initial stop</th><th scope="col" className={TH_R}>Risk to stop</th><th scope="col" className={TH_R}>Min volume</th></tr>
              </thead>
              <tbody>
                {view.orders.map((o) => (
                  <tr key={o.id} className="border-t border-rule">
                    <td className={TD}>{o.rank}</td>
                    <th scope="row" className={`${TD_L} font-medium text-paper`}>{o.symbol}</th>
                    <td className={TD_L}>{SECTOR_NAME[o.sector] ?? o.sector}</td>
                    <td className={TD_L}>{o.archetype.replace("_", " ").toLowerCase()}</td>
                    <td className={TD} title={`Pillars: volatility ${o.pillars[0]}/30, accumulation ${o.pillars[1]}/30, relative strength ${o.pillars[2]}/20, pivot ${o.pillars[3]}/20`}>{o.score.toFixed(0)}</td>
                    <td className={TD}>{fmtPrice(o.close)}</td><td className={TD}>{fmtPrice(o.trigger)}</td>
                    <td className={TD}>{fmtPrice(o.max_open)}</td><td className={TD}>{fmtPrice(o.initial_sl)}</td>
                    <td className={`${TD} ${o.risk_pct > 5.5 ? "text-warn" : ""}`}>{o.risk_pct.toFixed(1)}%{o.risk_pct > 5.5 ? " (wide)" : ""}</td>
                    <td className={TD}>{fmtInt(Math.round(o.min_volume))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {scan && (
          <p className="mt-3 text-sm">
            Gate at that close: NIFTY 50 <Verdict ok={scan.nifty_ok} yes="open" no="closed" />
            {" · "}sector indices open: {scan.sectors.filter((s) => s.ok).map((s) => SECTOR_NAME[s.code] ?? s.code).join(", ") || "none"}
            {scan.sectors.some((s) => s.ok === false) && <> · closed: {scan.sectors.filter((s) => s.ok === false).map((s) => SECTOR_NAME[s.code] ?? s.code).join(", ")}</>}
            <span className="text-muted"> · {scan.fetched_ok} of {scan.universe_size} stocks had usable bars</span>
          </p>
        )}
      </Panel>

      <Panel title="What happened to the previous orders">
        {view.decisions.length === 0 ? (
          <EmptyState title="No orders judged yet">Orders are judged on the session after they are queued.</EmptyState>
        ) : (
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[640px] text-sm">
              <caption className="sr-only">Outcome of earlier orders</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className={TH_L}>Session</th><th scope="col" className={TH_L}>Stock</th>
                  <th scope="col" className={TH_R}>Score</th><th scope="col" className={TH_L}>Outcome</th></tr>
              </thead>
              <tbody>
                {view.decisions.map((d) => (
                  <tr key={`${d.decided_on}-${d.symbol}`} className="border-t border-rule">
                    <td className={TD_L}><When day={d.decided_on} seen={d.seen_at} seenLabel="live trigger" booked={d.decided_booked_at} /></td>
                    <th scope="row" className={`${TD_L} font-medium text-paper`}>{d.symbol}</th>
                    <td className={TD}>{d.score.toFixed(0)}</td>
                    <td className={TD_L}>
                      {d.outcome === "filled"
                        ? <span className="text-up">✓ Filled {fmtInt(d.shares)} @ {fmtPrice(d.fill)}</span>
                        : <span className="text-muted">✕ Skipped: {d.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Closed paper trades (after costs)">
        {view.trades.length === 0 ? (
          <EmptyState title="No closed trades yet" />
        ) : (
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[820px] text-sm">
              <caption className="sr-only">Closed paper trades</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className={TH_L}>Stock</th><th scope="col" className={TH_L}>Entered</th><th scope="col" className={TH_R}>Entry</th>
                  <th scope="col" className={TH_L}>Exited</th><th scope="col" className={TH_R}>Exit</th><th scope="col" className={TH_L}>Why</th>
                  <th scope="col" className={TH_R}>Sessions</th><th scope="col" className={TH_R}>R</th><th scope="col" className={TH_R}>P&amp;L</th></tr>
              </thead>
              <tbody>
                {view.trades.map((x) => (
                  <tr key={x.id} className="border-t border-rule">
                    <th scope="row" className={`${TD_L} font-medium text-paper`}>{x.symbol}</th>
                    <td className={TD_L}><When day={x.entry_session} seen={x.entry_seen_at} seenLabel="live trigger" booked={x.entered_booked_at} /></td><td className={TD}>{fmtPrice(x.entry)}</td>
                    <td className={TD_L}><When day={x.exit_session} seen={x.exit_seen_at} seenLabel="live stop hit" booked={x.exited_booked_at} /></td><td className={TD}>{fmtPrice(x.exit)}</td>
                    <td className={TD_L}>{exitLabel(x.reason)}</td><td className={TD}>{x.hold_sessions}</td>
                    <td className={TD}>{plain(x.r_mult)}</td>
                    <td className={`${TD} ${tone(x.pnl)}`}>{signedRupees(x.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
