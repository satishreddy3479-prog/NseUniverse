import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { EChart, useChartColors } from "../EChart";
import { Panel } from "../ui";
import { api } from "../../lib/api";
import { fmtInt, fmtPrice, fmtTimeIST, MISSING } from "../../lib/format";
import { fmtStamp, signedRupees } from "../../lib/swing";
import { liveEquityOption } from "../../lib/swingCharts";
import type { MinuteComparison, MinuteEvent, MinuteView } from "../../lib/swingMinute";
import { Stat, TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";
const STATE_TONE: Record<string, string> = { signal: "text-up", signal_blocked: "text-warn", below_trigger: "text-muted", volume_short: "text-warn", volume_early: "text-muted", above_cap: "text-warn", gap_skip: "text-warn", outside_window: "text-muted" };
const STATE_TEXT: Record<string, string> = {
  signal: "Signal", signal_blocked: "Signal, blocked", below_trigger: "Below the trigger", volume_short: "Volume short", volume_early: "Too early to judge volume", above_cap: "Above the 1% cap",
  gap_skip: "Gap-up skip", outside_window: "Outside 09:30–15:00",
};
const KIND_TEXT: Record<string, string> = { entry_state: "Entry reading", entry_fill: "Entry fill", entry_cancelled: "Entry cancelled", exit: "Exit", ratchet: "Stop moved" };
const pnlTone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-up" : "text-down");
const tone = (v: number | null | undefined): "up" | "down" | undefined => (v == null || v === 0 ? undefined : v > 0 ? "up" : "down");
const pctText = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const rText = (v: number | null | undefined) => (v == null ? MISSING : `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`);
const holdText = (m: number | null | undefined) => (m == null ? MISSING : m < 90 ? `${Math.round(m)} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`);

/** One line of plain words for an event's detail. */
export function eventText(e: MinuteEvent): string {
  const d = e.detail;
  if (e.kind === "entry_state") return String(d.note ?? d.state ?? "");
  if (e.kind === "entry_fill") return `${d.shares} shares at the next candle's open; trigger ${fmtPrice(Number(d.trigger))}, stop ${fmtPrice(Number(d.stop))}`;
  if (e.kind === "entry_cancelled") return String(d.reason ?? "");
  if (e.kind === "exit") return `${d.reason}: ${(d.notes as string[] | undefined)?.join("; ") ?? ""}`.replace(/: $/, "");
  if (e.kind === "ratchet") return String(d.note ?? "");
  return JSON.stringify(d);
}

function holdMin(c: { filled_at: string; exit_at: string | null }): number | null {
  if (!c.exit_at) return null;
  const m = (new Date(c.exit_at).getTime() - new Date(c.filled_at).getTime()) / 60_000;
  return Number.isNaN(m) ? null : m;
}

/** Portfolio figures of the live book, from its own closed trades and recorded equity. A figure that cannot be computed is a dash, not a zero. */
function Analytics({ d }: { d: MinuteView }) {
  const a = d.analytics;
  if (!a) return null;
  const since = d.started?.equity_recorded_from;
  return (
    <section aria-label="Live book analytics" data-testid="minute-analytics">
      <h3 className="mb-1 text-sm font-semibold text-paper">Portfolio analytics</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Return on capital" value={pctText(a.return_pct, 2)} tone={tone(a.return_pct)} sub={`capital ${fmtInt(d.book.capital)}${d.started?.first_fill_at ? ` · first trade ${fmtStamp(d.started.first_fill_at)}` : ""}`} />
        <Stat label="Win rate" value={a.win_rate_pct == null ? MISSING : `${a.win_rate_pct.toFixed(0)}%`} sub={a.trades ? `${a.wins} won · ${a.losses} lost of ${a.trades}` : "no closed trade yet"} />
        <Stat label="Profit factor" value={a.profit_factor == null ? MISSING : a.profit_factor.toFixed(2)} sub={a.trades && a.losses === 0 ? "no losing trade yet" : "wins ÷ losses, after costs"} />
        <Stat label="Expectancy per trade" value={a.expectancy == null ? MISSING : signedRupees(a.expectancy)} tone={tone(a.expectancy)} sub={a.avg_r == null ? undefined : `average ${a.avg_r >= 0 ? "+" : "−"}${Math.abs(a.avg_r).toFixed(2)} R`} />
        <Stat label="Average win / loss" value={a.avg_win == null && a.avg_loss == null ? MISSING : `${a.avg_win == null ? MISSING : signedRupees(a.avg_win)} / ${a.avg_loss == null ? MISSING : signedRupees(a.avg_loss)}`} sub="after costs" />
        <Stat label="Max drawdown" value={a.max_drawdown_pct == null ? MISSING : `−${a.max_drawdown_pct.toFixed(2)}%`} tone={a.max_drawdown_pct ? "down" : undefined} sub={since ? `from ${a.equity_points} recorded minutes since ${fmtStamp(since)}` : "no equity recorded yet"} />
        <Stat label="Costs paid" value={a.costs == null ? MISSING : fmtInt(Math.round(a.costs))} sub={a.gross_pnl == null ? undefined : `gross ${signedRupees(a.gross_pnl)}`} />
        <Stat label="Average hold" value={holdText(a.avg_hold_minutes)} sub={a.best ? `best ${a.best.symbol} ${signedRupees(a.best.pnl)}${a.worst ? ` · worst ${a.worst.symbol} ${signedRupees(a.worst.pnl)}` : ""}` : undefined} />
      </div>
    </section>
  );
}

function Equity({ d }: { d: MinuteView }) {
  const c = useChartColors();
  const curve = d.equity_curve ?? [];
  const option = useMemo(() => liveEquityOption(curve, d.book.capital, c), [curve, d.book.capital, c]);
  return (
    <section aria-label="Live book equity curve" data-testid="minute-equity">
      <h3 className="mb-1 text-sm font-semibold text-paper">Equity curve</h3>
      {curve.length < 2 ? (
        <p className="text-sm text-muted" data-testid="minute-equity-empty">The equity curve fills in as the book records its value each minute of market hours; there are {curve.length} point(s) so far. Nothing before the first recorded minute is back-filled.</p>
      ) : (
        <>
          <div className="h-[260px]"><EChart option={option} ariaLabel="Live paper book equity against its starting capital" /></div>
          <p className="mt-1 text-[11px] text-muted">One point per minute of market hours, recorded from {fmtStamp(curve[0]!.at)} to {fmtStamp(curve[curve.length - 1]!.at)}; mark-to-market at the last price read.</p>
        </>
      )}
    </section>
  );
}

function Compare({ c }: { c: MinuteComparison }) {
  const s = c.summary;
  return (
    <div data-testid="minute-compare">
      <p className="mb-2 text-xs text-muted">Session {c.session}: {s.orders} order(s). Both filled {s.both_filled}, only the official book {s.only_official}, only the live book {s.only_shadow}, neither {s.neither}; {s.exits_compared} official exit(s) compared.</p>
      <div className={TABLE_WRAP}>
        <table className="w-full min-w-[40rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_L}>Official book (daily bar)</th><th className={TH_L}>Live book (1-minute)</th><th className={TH_R}>Fill gap</th></tr></thead>
          <tbody>{c.entries.map((e) => (
            <tr key={e.symbol} className="border-t border-rule" data-testid="minute-compare-row"><td className={`${TD_L} font-medium text-paper`}>{e.symbol}</td><td className={TD_L}>{e.official}</td>
              <td className={`${TD_L} ${e.same ? "" : "text-warn"}`}>{e.shadow}</td><td className={TD}>{e.fill_diff_pct == null ? MISSING : `${e.fill_diff_pct > 0 ? "+" : ""}${e.fill_diff_pct.toFixed(2)}%`}</td></tr>))}</tbody></table>
      </div>
      {c.exits.length > 0 && (
        <div className={`${TABLE_WRAP} mt-2`}>
          <table className="w-full min-w-[40rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Official exit</th><th className={TH_L}>Official</th><th className={TH_L}>Live book</th><th className={TH_R}>Exit gap</th></tr></thead>
            <tbody>{c.exits.map((e) => (
              <tr key={e.symbol} className="border-t border-rule"><td className={`${TD_L} font-medium text-paper`}>{e.symbol}</td><td className={TD_L}>{e.official}</td><td className={`${TD_L} ${e.shadow_took_it ? "" : "text-muted"}`}>{e.shadow ?? "the live book did not hold it"}</td>
                <td className={TD}>{e.exit_diff_pct == null ? MISSING : `${e.exit_diff_pct > 0 ? "+" : ""}${e.exit_diff_pct.toFixed(2)}%`}</td></tr>))}</tbody></table>
        </div>
      )}
    </div>
  );
}

/** The live-style rules (1-minute candle closes) run as a separate paper book beside the official daily-bar book. It places no order; each evening it is compared with the official decisions. */
export function SwingMinutePanel() {
  const q = useQuery({ queryKey: ["swing-minute"], queryFn: api.swingMinute, refetchInterval: 5_000, retry: false });
  const d: MinuteView | undefined = q.data;
  const closedRows = d ? (d.closed_trades ?? d.recent_closed) : [];
  return (
    <Panel title="Live paper book" actions={<span className="rounded-sm border border-warn/50 px-1.5 py-px text-[11px] text-warn" data-testid="minute-badge">Separate book · no orders</span>}>
      <div role="note" className="mb-3 rounded-sm border border-info/40 bg-info/10 px-3 py-2 text-sm" data-testid="minute-note">
        <p className="font-medium text-paper">A separate paper portfolio: its own cash, positions, stops and trades</p>
        <p className="mt-1 text-muted">The same rules as the official book, run live: every decision is taken on the close of a completed 1-minute candle and filled at the next candle&apos;s open. This book never places an order and never reads or changes the official book&apos;s positions, so it can hold a stock the official book does not (and the other way round). Each evening it is compared with what the official daily-bar rules did. All times are IST.</p>
        {d && <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer text-info">The rules</summary><ul className="mt-1 list-disc space-y-1 pl-5">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul></details>}
      </div>
      {q.isPending && <p className="text-sm text-muted">Reading the live paper book…</p>}
      {q.isError && <p role="alert" className="text-sm text-down" data-testid="minute-error">Could not read the live paper book: {q.error instanceof Error ? q.error.message : "unknown error"}</p>}
      {d && !d.enabled && <p className="mb-2 text-sm text-warn" data-testid="minute-off">The live paper book is switched off in the server settings (swing_live_enabled).</p>}
      {d && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6" data-testid="minute-stats">
            {([["Live equity", fmtInt(Math.round(d.book.equity))], ["Cash", fmtInt(Math.round(d.book.cash))], ["Open / slots", `${d.book.open} / ${d.book.slots}`], ["Closed", String(d.book.closed)],
              ["Realised P&L", signedRupees(d.book.realised_pnl)], ["Open P&L", signedRupees(d.book.unrealised_pnl)]] as const).map(([l, v]) => (
              <div key={l} className="rounded-sm bg-slate-2 p-2"><div className="text-[11px] text-muted">{l}</div><div className="num text-paper">{v}</div></div>))}
          </div>
          <Analytics d={d} />
          <Equity d={d} />
          <p className="text-xs text-muted" data-testid="minute-data">
            Volume is judged against {d.volume_basis === "profile" ? `the app's recorded stock volume profile (${(d.expected_share_of_day_now * 100).toFixed(0)}% of a normal day's volume expected by now)` : "a straight line through the session (no recorded profile yet; not judged before 09:45)"}.
            {" "}Candles so far today: {d.data.bars_today} across {d.data.symbols_with_bars} stock(s){d.data.last_poll_at ? `, last price read ${fmtTimeIST(d.data.last_poll_at)}` : ""}. {d.data.note}
          </p>

          <section aria-label="Tonight's orders" data-testid="minute-watching">
            <h3 className="mb-1 text-sm font-semibold text-paper">Orders being watched ({d.windows.entry_from}–{d.windows.entry_until})</h3>
            {d.watching.length === 0 ? <p className="text-sm text-muted" data-testid="minute-watch-empty">No order is queued for this session (or the book is catching up), so nothing is watched.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[52rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>#</th><th className={TH_L}>Stock</th><th className={TH_R}>Trigger</th><th className={TH_R}>Stop</th><th className={TH_R}>Last candle close</th><th className={TH_R}>Volume pace</th><th className={TH_L}>Reading</th><th className={TH_L}>As of</th></tr></thead>
                  <tbody>{d.watching.map((w) => (
                    <tr key={w.symbol} className="border-t border-rule" data-testid="minute-watch-row" title={w.note ?? undefined}>
                      <td className={TD_L}>{w.rank}</td><td className={`${TD_L} font-medium text-paper`}>{w.symbol}</td><td className={TD}>{fmtPrice(w.trigger)}</td><td className={TD}>{fmtPrice(w.stop)}</td>
                      <td className={TD}>{w.last_close == null ? MISSING : fmtPrice(w.last_close)}</td><td className={TD}>{w.pace == null ? MISSING : `${Math.round(w.pace * 100)}%`}</td>
                      <td className={`${TD_L} ${STATE_TONE[w.state] ?? "text-muted"}`}>{STATE_TEXT[w.state] ?? w.state}{w.note ? <span className="block text-[11px] text-muted">{w.note}</span> : null}</td>
                      <td className={`${TD_L} num text-xs text-muted`}>{fmtStamp(w.read_at)}</td>
                    </tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Open positions" data-testid="minute-positions">
            <h3 className="mb-1 text-sm font-semibold text-paper">Open positions, stops and targets</h3>
            {d.positions.length === 0 ? <p className="text-sm text-muted" data-testid="minute-pos-empty">No position is open in the live book.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[64rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_L}>Entered</th><th className={TH_R}>Fill</th><th className={TH_R}>Shares</th><th className={TH_R}>Last price</th><th className={TH_R}>Stop in force</th><th className={TH_R}>To stop</th><th className={TH_R}>1.8R target</th><th className={TH_R}>2.5R target</th><th className={TH_L}>Stage</th><th className={TH_R}>R now</th><th className={TH_R}>Open P&amp;L</th></tr></thead>
                  <tbody>{d.positions.map((p) => (
                    <tr key={p.id} className="border-t border-rule" data-testid="minute-pos-row" title={p.evidence}>
                      <td className={`${TD_L} font-medium text-paper`}>{p.symbol}</td><td className={`${TD_L} num text-xs text-muted`}>{fmtStamp(p.filled_at)}</td><td className={TD}>{fmtPrice(p.fill)}</td><td className={TD}>{fmtInt(p.shares)}</td>
                      <td className={TD}>{p.last_price == null ? MISSING : fmtPrice(p.last_price)}<span className="block text-[11px] text-muted">{fmtStamp(p.last_at)}</span></td>
                      <td className={TD}>{fmtPrice(p.tsl)}</td><td className={TD}>{pctText(p.to_stop_pct)}</td>
                      <td className={TD}>{p.level_1_8r == null ? MISSING : fmtPrice(p.level_1_8r)}{p.reached_1_8r ? " ✓" : ""}</td><td className={TD}>{p.level_2_5r == null ? MISSING : fmtPrice(p.level_2_5r)}{p.reached_2_5r ? " ✓" : ""}</td>
                      <td className={TD_L}>{p.stage}</td>
                      <td className={TD}>{rText(p.r_now)}</td><td className={`${TD} ${pnlTone(p.unrealized_pnl)}`}>{signedRupees(p.unrealized_pnl)}</td>
                    </tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Today's events" data-testid="minute-events">
            <h3 className="mb-1 text-sm font-semibold text-paper">Today&apos;s events (date and time, IST)</h3>
            {d.events.length === 0 ? <p className="text-sm text-muted">Nothing has happened yet today.</p> : (
              <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs" tabIndex={0} aria-label="Today's events, scrollable">
                {d.events.map((e) => <li key={e.id} className="flex flex-wrap gap-x-2 border-b border-rule/40 py-1" data-testid="minute-event"><span className="num text-muted">{fmtStamp(e.at, true)}</span><span className="font-medium text-paper">{e.symbol}</span><span className="text-info">{KIND_TEXT[e.kind] ?? e.kind}</span>{e.price != null && <span className="num text-paper">{fmtPrice(e.price)}</span>}<span className="text-muted">{eventText(e)}</span></li>)}
              </ul>
            )}
          </section>

          <section aria-label="Closed trades" data-testid="minute-closed">
            <h3 className="mb-1 text-sm font-semibold text-paper">Closed trades</h3>
            {closedRows.length === 0 ? <p className="text-sm text-muted" data-testid="minute-closed-empty">No trade has closed in the live book yet.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[60rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_L}>Entered</th><th className={TH_L}>Exited</th><th className={TH_R}>Held</th><th className={TH_R}>Shares</th><th className={TH_R}>Fill</th><th className={TH_R}>Exit</th><th className={TH_L}>Reason</th><th className={TH_R}>R</th><th className={TH_R}>Net P&amp;L</th></tr></thead>
                  <tbody>{closedRows.map((c) => (
                    <tr key={c.id} className="border-t border-rule" data-testid="minute-closed-row" title={c.evidence}><td className={`${TD_L} font-medium text-paper`}>{c.symbol}</td>
                      <td className={`${TD_L} num text-xs text-muted`}>{fmtStamp(c.filled_at)}</td><td className={`${TD_L} num text-xs text-muted`}>{fmtStamp(c.exit_at)}</td>
                      <td className={TD}>{holdText(holdMin(c))}</td><td className={TD}>{fmtInt(c.shares)}</td><td className={TD}>{fmtPrice(c.fill)}</td><td className={TD}>{c.exit_price == null ? MISSING : fmtPrice(c.exit_price)}</td>
                      <td className={TD_L}>{c.exit_reason ?? MISSING}{c.exit_basis && c.exit_basis !== "next open" ? <span className="block text-[11px] text-warn">{c.exit_basis}</span> : null}</td>
                      <td className={TD}>{rText("r" in c ? (c as { r: number | null }).r : null)}</td><td className={`${TD} ${pnlTone(c.pnl)}`}>{c.pnl == null ? MISSING : signedRupees(c.pnl)}</td></tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Comparison with the official book" data-testid="minute-comparison">
            <h3 className="mb-1 text-sm font-semibold text-paper">Compared with the official daily-bar book (a separate portfolio)</h3>
            {d.comparisons.length === 0 ? <p className="text-sm text-muted" data-testid="minute-compare-empty">No comparison yet: it is made after each evening settlement, once the live book has watched a session.</p> : <Compare c={d.comparisons[0]!} />}
            {d.comparisons.length > 1 && <p className="mt-2 text-[11px] text-muted">Earlier sessions: {d.comparisons.slice(1).map((c) => `${c.session} (both ${c.summary.both_filled}, only official ${c.summary.only_official}, only live ${c.summary.only_shadow})`).join("; ")}.</p>}
          </section>
        </div>
      )}
    </Panel>
  );
}
