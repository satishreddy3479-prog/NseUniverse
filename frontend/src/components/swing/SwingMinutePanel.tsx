import { useQuery } from "@tanstack/react-query";
import { Panel } from "../ui";
import { api } from "../../lib/api";
import { fmtInt, fmtPrice, fmtTimeIST, MISSING } from "../../lib/format";
import { signedRupees } from "../../lib/swing";
import type { MinuteComparison, MinuteEvent, MinuteView } from "../../lib/swingMinute";
import { TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";
const STATE_TONE: Record<string, string> = { signal: "text-up", signal_blocked: "text-warn", below_trigger: "text-muted", volume_short: "text-warn", volume_early: "text-muted", above_cap: "text-warn", gap_skip: "text-warn", outside_window: "text-muted" };
const STATE_TEXT: Record<string, string> = {
  signal: "Signal", signal_blocked: "Signal, blocked", below_trigger: "Below the trigger", volume_short: "Volume short", volume_early: "Too early to judge volume", above_cap: "Above the 1% cap",
  gap_skip: "Gap-up skip", outside_window: "Outside 09:30–15:00",
};
const KIND_TEXT: Record<string, string> = { entry_state: "Entry reading", entry_fill: "Entry fill", entry_cancelled: "Entry cancelled", exit: "Exit", ratchet: "Stop moved" };
const pnlTone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-up" : "text-down");

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

function Compare({ c }: { c: MinuteComparison }) {
  const s = c.summary;
  return (
    <div data-testid="minute-compare">
      <p className="mb-2 text-xs text-muted">Session {c.session}: {s.orders} order(s). Both filled {s.both_filled}, only the official book {s.only_official}, only the shadow book {s.only_shadow}, neither {s.neither}; {s.exits_compared} official exit(s) compared.</p>
      <div className={TABLE_WRAP}>
        <table className="w-full min-w-[40rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_L}>Official book (daily bar)</th><th className={TH_L}>Shadow book (1-minute)</th><th className={TH_R}>Fill gap</th></tr></thead>
          <tbody>{c.entries.map((e) => (
            <tr key={e.symbol} className="border-t border-rule" data-testid="minute-compare-row"><td className={`${TD_L} font-medium text-paper`}>{e.symbol}</td><td className={TD_L}>{e.official}</td>
              <td className={`${TD_L} ${e.same ? "" : "text-warn"}`}>{e.shadow}</td><td className={TD}>{e.fill_diff_pct == null ? MISSING : `${e.fill_diff_pct > 0 ? "+" : ""}${e.fill_diff_pct.toFixed(2)}%`}</td></tr>))}</tbody></table>
      </div>
      {c.exits.length > 0 && (
        <div className={`${TABLE_WRAP} mt-2`}>
          <table className="w-full min-w-[40rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Official exit</th><th className={TH_L}>Official</th><th className={TH_L}>Shadow</th><th className={TH_R}>Exit gap</th></tr></thead>
            <tbody>{c.exits.map((e) => (
              <tr key={e.symbol} className="border-t border-rule"><td className={`${TD_L} font-medium text-paper`}>{e.symbol}</td><td className={TD_L}>{e.official}</td><td className={`${TD_L} ${e.shadow_took_it ? "" : "text-muted"}`}>{e.shadow ?? "the shadow book did not hold it"}</td>
                <td className={TD}>{e.exit_diff_pct == null ? MISSING : `${e.exit_diff_pct > 0 ? "+" : ""}${e.exit_diff_pct.toFixed(2)}%`}</td></tr>))}</tbody></table>
        </div>
      )}
    </div>
  );
}

/** The live-style rules (1-minute candle closes) run in shadow beside the official daily-bar book. It places no order; each evening it is compared with the official decisions. */
export function SwingMinutePanel() {
  const q = useQuery({ queryKey: ["swing-minute"], queryFn: api.swingMinute, refetchInterval: 5_000, retry: false });
  const d: MinuteView | undefined = q.data;
  return (
    <Panel title="Live-rules shadow book (1-minute candles)" actions={<span className="rounded-sm border border-warn/50 px-1.5 py-px text-[11px] text-warn" data-testid="minute-badge">Shadow · no orders</span>}>
      <div role="note" className="mb-3 rounded-sm border border-info/40 bg-info/10 px-3 py-2 text-sm" data-testid="minute-note">
        <p className="font-medium text-paper">The live version of the rules, tested before any real order</p>
        <p className="mt-1 text-muted">Every decision is taken on the close of a completed 1-minute candle and filled at the next candle&apos;s open. This book never places an order and never changes the official book; each evening it is compared with what the official daily-bar rules did.</p>
        {d && <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer text-info">The rules</summary><ul className="mt-1 list-disc space-y-1 pl-5">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul></details>}
      </div>
      {q.isPending && <p className="text-sm text-muted">Reading the shadow book…</p>}
      {q.isError && <p role="alert" className="text-sm text-down" data-testid="minute-error">Could not read the shadow book: {q.error instanceof Error ? q.error.message : "unknown error"}</p>}
      {d && !d.enabled && <p className="mb-2 text-sm text-warn" data-testid="minute-off">The shadow book is switched off in the server settings (swing_live_enabled).</p>}
      {d && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6" data-testid="minute-stats">
            {([["Shadow equity", fmtInt(Math.round(d.book.equity))], ["Cash", fmtInt(Math.round(d.book.cash))], ["Open / slots", `${d.book.open} / ${d.book.slots}`], ["Closed", String(d.book.closed)],
              ["Realised P&L", signedRupees(d.book.realised_pnl)], ["Open P&L", signedRupees(d.book.unrealised_pnl)]] as const).map(([l, v]) => (
              <div key={l} className="rounded-sm bg-slate-2 p-2"><div className="text-[11px] text-muted">{l}</div><div className="num text-paper">{v}</div></div>))}
          </div>
          <p className="text-xs text-muted" data-testid="minute-data">
            Volume is judged against {d.volume_basis === "profile" ? `the app's recorded stock volume profile (${(d.expected_share_of_day_now * 100).toFixed(0)}% of a normal day's volume expected by now)` : "a straight line through the session (no recorded profile yet; not judged before 09:45)"}.
            {" "}Candles so far today: {d.data.bars_today} across {d.data.symbols_with_bars} stock(s){d.data.last_poll_at ? `, last price read ${fmtTimeIST(d.data.last_poll_at)}` : ""}. {d.data.note}
          </p>

          <section aria-label="Tonight's orders" data-testid="minute-watching">
            <h3 className="mb-1 text-sm font-semibold text-paper">Orders being watched ({d.windows.entry_from}–{d.windows.entry_until})</h3>
            {d.watching.length === 0 ? <p className="text-sm text-muted" data-testid="minute-watch-empty">No order is queued for this session (or the book is catching up), so nothing is watched.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[52rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>#</th><th className={TH_L}>Stock</th><th className={TH_R}>Trigger</th><th className={TH_R}>Stop</th><th className={TH_R}>Last candle close</th><th className={TH_R}>Volume pace</th><th className={TH_L}>Reading</th></tr></thead>
                  <tbody>{d.watching.map((w) => (
                    <tr key={w.symbol} className="border-t border-rule" data-testid="minute-watch-row" title={w.note ?? undefined}>
                      <td className={TD_L}>{w.rank}</td><td className={`${TD_L} font-medium text-paper`}>{w.symbol}</td><td className={TD}>{fmtPrice(w.trigger)}</td><td className={TD}>{fmtPrice(w.stop)}</td>
                      <td className={TD}>{w.last_close == null ? MISSING : fmtPrice(w.last_close)}</td><td className={TD}>{w.pace == null ? MISSING : `${Math.round(w.pace * 100)}%`}</td>
                      <td className={`${TD_L} ${STATE_TONE[w.state] ?? "text-muted"}`}>{STATE_TEXT[w.state] ?? w.state}{w.note ? <span className="block text-[11px] text-muted">{w.note}</span> : null}</td>
                    </tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Shadow positions" data-testid="minute-positions">
            <h3 className="mb-1 text-sm font-semibold text-paper">Shadow positions</h3>
            {d.positions.length === 0 ? <p className="text-sm text-muted" data-testid="minute-pos-empty">No shadow position is open.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[52rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_R}>Fill</th><th className={TH_R}>Shares</th><th className={TH_R}>Stop in force</th><th className={TH_L}>Stage</th><th className={TH_R}>R now</th><th className={TH_R}>Open P&amp;L</th></tr></thead>
                  <tbody>{d.positions.map((p) => (
                    <tr key={p.id} className="border-t border-rule" data-testid="minute-pos-row" title={p.evidence}>
                      <td className={`${TD_L} font-medium text-paper`}>{p.symbol}</td><td className={TD}>{fmtPrice(p.fill)}</td><td className={TD}>{fmtInt(p.shares)}</td><td className={TD}>{fmtPrice(p.tsl)}</td><td className={TD_L}>{p.stage}</td>
                      <td className={TD}>{p.r_now == null ? MISSING : p.r_now.toFixed(2)}</td><td className={`${TD} ${pnlTone(p.unrealized_pnl)}`}>{signedRupees(p.unrealized_pnl)}</td>
                    </tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Today's events" data-testid="minute-events">
            <h3 className="mb-1 text-sm font-semibold text-paper">Today&apos;s events</h3>
            {d.events.length === 0 ? <p className="text-sm text-muted">Nothing has happened yet today.</p> : (
              <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs" tabIndex={0} aria-label="Today's events, scrollable">
                {d.events.map((e) => <li key={e.id} className="flex flex-wrap gap-x-2 border-b border-rule/40 py-1" data-testid="minute-event"><span className="num text-muted">{fmtTimeIST(e.at)}</span><span className="font-medium text-paper">{e.symbol}</span><span className="text-info">{KIND_TEXT[e.kind] ?? e.kind}</span>{e.price != null && <span className="num text-paper">{fmtPrice(e.price)}</span>}<span className="text-muted">{eventText(e)}</span></li>)}
              </ul>
            )}
          </section>

          <section aria-label="Closed shadow trades" data-testid="minute-closed">
            <h3 className="mb-1 text-sm font-semibold text-paper">Closed shadow trades</h3>
            {d.recent_closed.length === 0 ? <p className="text-sm text-muted" data-testid="minute-closed-empty">No shadow trade has closed yet.</p> : (
              <div className={TABLE_WRAP}>
                <table className="w-full min-w-[52rem] text-sm"><thead className={THEAD}><tr><th className={TH_L}>Stock</th><th className={TH_R}>Fill</th><th className={TH_R}>Exit</th><th className={TH_L}>Reason</th><th className={TH_R}>Net P&amp;L</th></tr></thead>
                  <tbody>{d.recent_closed.map((c) => (
                    <tr key={c.id} className="border-t border-rule" title={c.evidence}><td className={`${TD_L} font-medium text-paper`}>{c.symbol}</td><td className={TD}>{fmtPrice(c.fill)}</td><td className={TD}>{c.exit_price == null ? MISSING : fmtPrice(c.exit_price)}</td>
                      <td className={TD_L}>{c.exit_reason ?? MISSING}{c.exit_basis && c.exit_basis !== "next open" ? <span className="block text-[11px] text-warn">{c.exit_basis}</span> : null}</td><td className={`${TD} ${pnlTone(c.pnl)}`}>{c.pnl == null ? MISSING : signedRupees(c.pnl)}</td></tr>))}</tbody></table>
              </div>
            )}
          </section>

          <section aria-label="Comparison with the official book" data-testid="minute-comparison">
            <h3 className="mb-1 text-sm font-semibold text-paper">Compared with the official daily-bar book</h3>
            {d.comparisons.length === 0 ? <p className="text-sm text-muted" data-testid="minute-compare-empty">No comparison yet: it is made after each evening settlement, once the shadow book has watched a session.</p> : <Compare c={d.comparisons[0]!} />}
            {d.comparisons.length > 1 && <p className="mt-2 text-[11px] text-muted">Earlier sessions: {d.comparisons.slice(1).map((c) => `${c.session} (both ${c.summary.both_filled}, only official ${c.summary.only_official}, only shadow ${c.summary.only_shadow})`).join("; ")}.</p>}
          </section>
        </div>
      )}
    </Panel>
  );
}
