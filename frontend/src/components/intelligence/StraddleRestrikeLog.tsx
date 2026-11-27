import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { fmtTimeIST, MISSING } from "../../lib/format";
import type { ManagedBook, ManagedDay, StraddleDecay } from "../../lib/straddleDecay";

const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-up" : "text-down");
const inr = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`);
const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
/** points of one straddle (a sold pair, so profit = sold at - bought back) to rupees for one lot */
const rupees = (points: number | null | undefined, lot: number) => (points == null ? null : points * lot);

/** The trades of one managed-straddle book: each closed pair (sold at, bought back at, profit), then the pair still held. Stored last traded prices, before costs. */
export function ManagedTrades({ book, session }: { book: ManagedBook; session: string }) {
  const lot = book.lot_size;
  const rows = book.segments;
  const held = book.open;
  return (
    <div className="overflow-x-auto" data-testid={`restrike-trades-${session}`}>
      <table className="w-full min-w-[34rem] text-xs">
        <thead><tr className="text-left text-muted"><th className="py-1 pr-2 font-normal">#</th><th className="pr-2 font-normal">Strike</th><th className="pr-2 font-normal">In</th><th className="pr-2 font-normal">Out</th><th className="pr-2 text-right font-normal">Sold at</th><th className="pr-2 text-right font-normal">Bought back</th><th className="pr-2 text-right font-normal">Points</th><th className="text-right font-normal">₹ per lot</th></tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={s.from} className="border-t border-rule/50" data-testid="restrike-trade">
              <td className="py-1 pr-2 text-muted">{i + 1}</td>
              <td className="num pr-2 text-paper">{s.strike}</td>
              <td className="num pr-2">{fmtTimeIST(s.from).slice(0, 5)}</td>
              <td className="num pr-2">{fmtTimeIST(s.to).slice(0, 5)}</td>
              <td className="num pr-2 text-right">{s.entry.toFixed(2)}</td>
              <td className="num pr-2 text-right">{s.exit.toFixed(2)}{s.exit_carried && <span title="The pair had no price at the re-strike: its last price before it is used" className="text-warn">*</span>}</td>
              <td className={`num pr-2 text-right ${tone(s.pnl)}`}>{sg(s.pnl)}</td>
              <td className={`num text-right ${tone(s.pnl)}`}>{inr(rupees(s.pnl, lot))}</td>
            </tr>
          ))}
          {held && (
            <tr className="border-t border-rule/50" data-testid="restrike-open">
              <td className="py-1 pr-2 text-muted">{rows.length + 1}</td>
              <td className="num pr-2 text-paper">{held.strike}</td>
              <td className="num pr-2">{fmtTimeIST(held.from).slice(0, 5)}</td>
              <td className="pr-2 text-info">held</td>
              <td className="num pr-2 text-right">{held.entry.toFixed(2)}</td>
              <td className="num pr-2 text-right text-muted" title="Its last price: still held">{held.last.toFixed(2)}</td>
              <td className={`num pr-2 text-right ${tone(held.pnl)}`}>{sg(held.pnl)}</td>
              <td className={`num text-right ${tone(held.pnl)}`}>{inr(rupees(held.pnl, lot))}</td>
            </tr>
          )}
          {rows.length === 0 && !held && <tr><td colSpan={8} className="py-2 text-muted" data-testid="restrike-none">No trade yet: the opening straddle is not priced.</td></tr>}
        </tbody>
        <tfoot>
          <tr className="border-t border-rule text-paper" data-testid="restrike-total">
            <td colSpan={6} className="py-1 pr-2">{book.restrikes} re-strike{book.restrikes === 1 ? "" : "s"} · booked {sg(book.realised)} · open {sg(book.open_pnl)}</td>
            <td className={`num pr-2 text-right font-semibold ${tone(book.total)}`}>{sg(book.total)}</td>
            <td className={`num text-right font-semibold ${tone(book.total)}`}>{inr(book.total_rupees)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DayRow({ day, open, onToggle }: { day: ManagedDay; open: boolean; onToggle: () => void }) {
  const b = day.book;
  return (
    <>
      <tr className="border-t border-rule/50" data-testid="restrike-day">
        <td className="py-1 pr-2">
          <button type="button" aria-expanded={open} onClick={onToggle} disabled={!b} className="text-left text-info hover:underline disabled:text-muted disabled:no-underline" aria-label={`Trades of ${dmy(day.session)}`}>
            {open ? "▾" : "▸"} {dmy(day.session)}
          </button>
          {day.live && <span className="ml-1 rounded-sm border border-rule px-1 text-[10px] text-muted">running</span>}
        </td>
        <td className="num pr-2 text-muted">{dmy(day.expiry)}</td>
        <td className="num pr-2 text-right">{b ? b.restrikes : MISSING}</td>
        <td className={`num pr-2 text-right ${tone(b?.realised)}`}>{sg(b?.realised)}</td>
        <td className={`num pr-2 text-right ${tone(b?.open_pnl)}`}>{sg(b?.open_pnl)}</td>
        <td className={`num pr-2 text-right font-semibold ${tone(b?.total)}`}>{sg(b?.total)}</td>
        <td className={`num text-right font-semibold ${tone(b?.total)}`}>{inr(b?.total_rupees)}</td>
      </tr>
      {open && (
        <tr><td colSpan={7} className="pb-2 pl-3">{b ? <ManagedTrades book={b} session={day.session} /> : <span className="text-muted">{day.message ?? MISSING}</span>}</td></tr>
      )}
    </>
  );
}

/** The managed straddle's trade log: the session on the page (live or replayed), then every stored session with a day-by-day summary that opens into each day's trades. */
export function StraddleRestrikeLog({ d }: { d: StraddleDecay }) {
  const book = d.tracker?.managed;
  const hist = useQuery({ queryKey: ["straddle-managed-history"], queryFn: () => api.straddleManagedHistory(30), retry: false, staleTime: 60_000, refetchInterval: 60_000 });
  const [openDay, setOpenDay] = useState<string | null>(null);
  const h = hist.data;
  return (
    <div className="flex flex-col gap-3" data-testid="restrike-log">
      <section aria-label="Re-strike trades of this session" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="restrike-session">
        <h3 className="text-sm font-semibold text-paper">Trades of this session{d.session ? ` · ${dmy(d.session)}` : ""}{d.expiry ? <span className="font-normal text-muted"> · expiry {dmy(d.expiry)}</span> : null}</h3>
        <p className="mb-2 mt-0.5 text-[13px] leading-snug text-muted">
          The managed straddle: the opening straddle sold, and every time NIFTY is {book?.threshold ?? 100} points from the held strike it is bought back and sold again at the strike nearest NIFTY. Each row is one pair: sold at, bought back at (in points of straddle premium; ₹ for one lot of {book?.lot_size ?? 65}). Stored last traded prices, before brokerage and slippage; a record of what the rule would have done, not orders.
        </p>
        {book ? <ManagedTrades book={book} session={d.session ?? "now"} /> : <p className="text-sm text-muted" data-testid="restrike-nobook">The managed straddle has no book for this session yet.</p>}
      </section>

      <section aria-label="Re-strike history" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="restrike-history">
        <h3 className="text-sm font-semibold text-paper">History · every stored session</h3>
        <p className="mb-2 mt-0.5 text-[13px] leading-snug text-muted">The same rule on each stored session, newest first. Open a day to see its trades. A running session changes with every minute.</p>
        {hist.isPending ? <p className="text-sm text-muted" data-testid="restrike-history-loading">Loading the stored sessions…</p>
          : hist.isError || !h ? <p className="text-sm text-down" data-testid="restrike-history-error">The history could not be loaded{hist.error instanceof Error ? `: ${hist.error.message}` : ""}.</p>
          : h.days.length === 0 ? <p className="text-sm text-muted" data-testid="restrike-history-empty">No stored session has a chain sampled yet.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-xs">
                <thead><tr className="text-left text-muted"><th className="py-1 pr-2 font-normal">Session</th><th className="pr-2 font-normal">Expiry</th><th className="pr-2 text-right font-normal">Re-strikes</th><th className="pr-2 text-right font-normal">Booked</th><th className="pr-2 text-right font-normal">Open</th><th className="pr-2 text-right font-normal">Total pts</th><th className="text-right font-normal">₹ per lot</th></tr></thead>
                <tbody>{h.days.map((x) => <DayRow key={x.session} day={x} open={openDay === x.session} onToggle={() => setOpenDay(openDay === x.session ? null : x.session)} />)}</tbody>
                <tfoot>
                  <tr className="border-t border-rule text-paper" data-testid="restrike-history-total">
                    <td colSpan={2} className="py-1 pr-2">{h.totals.sessions} session{h.totals.sessions === 1 ? "" : "s"} · {h.totals.winning_sessions} in profit</td>
                    <td className="num pr-2 text-right">{h.totals.restrikes}</td>
                    <td /><td />
                    <td className={`num pr-2 text-right font-semibold ${tone(h.totals.total)}`}>{sg(h.totals.total)}</td>
                    <td className={`num text-right font-semibold ${tone(h.totals.total)}`}>{inr(h.totals.total_rupees)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}
