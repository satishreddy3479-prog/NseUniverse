import { Panel, EmptyState } from "../ui";
import { fmtInt, fmtPrice } from "../../lib/format";
import { pct, rupees, signedRupees } from "../../lib/swing";
import type { SwingLiveRow, SwingPaperPosition } from "../../lib/types";
import { When, TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";
const tone = (v: number) => (v >= 0 ? "text-up" : "text-down");

/** What the engine's exit rules mean in prices for one position: R is the risk taken at entry (fill minus the initial stop). */
export function positionLevels(p: Pick<SwingPaperPosition, "fill" | "initial_sl" | "tsl" | "hh">) {
  const r = p.fill - p.initial_sl;
  const l18 = p.fill + 1.8 * r, l25 = p.fill + 2.5 * r;
  return { r, l18, l25, reached18: p.hh >= l18, reached25: p.hh >= l25 };
}

/** The price a position is valued at now: the live feed's last price when there is one, otherwise the settled close. */
export function positionPrice(p: SwingPaperPosition, row: SwingLiveRow | undefined) {
  const live = row != null && row.ltp != null && row.ltp > 0;
  const px = live ? (row!.ltp as number) : p.last_close;
  return { px, live, stale: live && row!.stale, tickAge: live ? row!.tick_age_s : null };
}

/** Live value of the whole book: cash plus every position at its live price (settled close where none), and how many are live. */
export function liveEquity(cash: number, positions: SwingPaperPosition[], rows: SwingLiveRow[] | undefined) {
  const by = new Map((rows ?? []).filter((r) => r.kind === "position").map((r) => [r.symbol, r]));
  let value = 0, live = 0;
  for (const p of positions) {
    const q = positionPrice(p, by.get(p.symbol));
    value += p.shares * q.px;
    if (q.live) live++;
  }
  return { equity: cash + value, live, total: positions.length };
}

/** One position on a price line: stop, entry, the two stage levels and the price now. */
function RangeBar({ p, px }: { p: SwingPaperPosition; px: number }) {
  const { l18, l25 } = positionLevels(p);
  const marks = [
    { v: p.tsl, label: "Stop", cls: "bg-down" }, { v: p.fill, label: "Entry", cls: "bg-muted" },
    { v: l18, label: "1.8R", cls: "bg-info" }, { v: l25, label: "2.5R", cls: "bg-up" },
  ];
  const lo = Math.min(p.tsl, px, p.fill), hi = Math.max(l25, px);
  const span = hi - lo || 1;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%`;
  return (
    <div className="relative mt-1 h-5 min-w-[150px]" role="img" aria-label={`${p.symbol}: stop ${fmtPrice(p.tsl)}, entry ${fmtPrice(p.fill)}, price ${fmtPrice(px)}, 1.8R ${fmtPrice(l18)}, 2.5R ${fmtPrice(l25)}`}>
      <div className="absolute left-0 right-0 top-2 h-1 rounded-full bg-rule" />
      <div className="absolute top-2 h-1 rounded-full bg-up/40" style={{ left: at(p.fill), width: `calc(${at(Math.max(p.fill, Math.min(px, l25)))} - ${at(p.fill)})` }} />
      {marks.map((m) => <span key={m.label} title={`${m.label} ${fmtPrice(m.v)}`} className={`absolute top-0.5 h-4 w-0.5 ${m.cls}`} style={{ left: at(m.v) }} />)}
      <span title={`Price ${fmtPrice(px)}`} className="absolute top-1 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-paper bg-slate" style={{ left: at(px) }} />
    </div>
  );
}

export function PositionsPanel({ positions, slots, never, rows, market, cash }: {
  positions: SwingPaperPosition[]; slots: number; never: boolean; rows: SwingLiveRow[] | undefined; market: "open" | "closed" | undefined; cash: number;
}) {
  const by = new Map((rows ?? []).filter((r) => r.kind === "position").map((r) => [r.symbol, r]));
  const eq = liveEquity(cash, positions, rows);
  return (
    <Panel title={`Open positions (${positions.length} of ${slots})`} actions={<span className="rounded-sm border border-warn/50 px-1.5 py-px text-[11px] text-warn" title="Live figures come from the Kotak feed and are shown, not booked: the paper book follows the end-of-day settlement">Live values: provisional</span>}>
      {positions.length === 0 ? (
        <EmptyState title="No open positions">{never ? "Positions appear after the first orders are filled." : "Slots are empty until a queued order triggers."}</EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted" data-testid="positions-live-note">
            {eq.live === 0 ? "No live price yet: positions are valued at the last settled close." : `${eq.live} of ${eq.total} priced live from the Kotak feed${market === "closed" ? " (market closed: the last trade)" : ""}.`}
            {" "}Price is the feed&apos;s last trade; &ldquo;Settled close&rdquo; is the end-of-day figure the paper book uses (they differ because NSE&apos;s closing price is an average of the last half hour).
          </p>
          <div className={TABLE_WRAP}>
            <table className="num w-full min-w-[1040px] text-sm">
              <caption className="sr-only">Open paper positions</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className={TH_L}>Stock</th><th scope="col" className={TH_L}>Entered</th>
                  <th scope="col" className={TH_R}>Fill</th><th scope="col" className={TH_R}>Shares</th>
                  <th scope="col" className={TH_R}>Price now</th><th scope="col" className={TH_R}>Settled close</th>
                  <th scope="col" className={TH_R}>Unrealised (now)</th>
                  <th scope="col" className={TH_R}>Stop</th><th scope="col" className={TH_L}>Exit levels</th>
                  <th scope="col" className={TH_L}>Progress</th></tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const q = positionPrice(p, by.get(p.symbol));
                  const lv = positionLevels(p);
                  const pnl = (q.px - p.fill) * p.shares;
                  const toStop = ((q.px - p.tsl) / q.px) * 100;
                  return (
                    <tr key={p.symbol} className="border-t border-rule align-top">
                      <th scope="row" className={`${TD_L} font-medium text-paper`}>{p.symbol}<div className="text-[11px] font-normal text-muted">{p.stop_stage}</div></th>
                      <td className={TD_L}><When day={p.entry_session} seen={p.entry_seen_at} seenLabel="live trigger" booked={p.entered_booked_at} /></td>
                      <td className={TD}>{fmtPrice(p.fill)}</td><td className={TD}>{fmtInt(p.shares)}</td>
                      <td className={TD}>{fmtPrice(q.px)}
                        <div className={`text-[11px] ${q.live ? (q.stale ? "text-warn" : "text-up") : "text-muted"}`}>{q.live ? (q.stale ? `stale${q.tickAge != null ? ` ${Math.round(q.tickAge)} s` : ""}` : "live") : "settled close"}</div></td>
                      <td className={`${TD} text-muted`}>{fmtPrice(p.last_close)}</td>
                      <td className={`${TD} ${tone(pnl)}`}>{signedRupees(pnl)} <span className="text-xs">({pct(((q.px - p.fill) / p.fill) * 100, 1)})</span>
                        <div className="text-[11px] text-muted">settled {signedRupees(p.unrealized_pnl)}</div></td>
                      <td className={TD}>{fmtPrice(p.tsl)}<div className="text-[11px] text-muted">{toStop.toFixed(1)}% below price</div></td>
                      <td className={TD_L}>
                        <div className="whitespace-nowrap">1.8R {fmtPrice(lv.l18)}{lv.reached18 && <span className="text-up"> ✓</span>}<span className="text-[11px] text-muted"> stop to breakeven+0.2%</span></div>
                        <div className="whitespace-nowrap">2.5R {fmtPrice(lv.l25)}{lv.reached25 && <span className="text-up"> ✓</span>}<span className="text-[11px] text-muted"> trailing stop starts</span></div>
                        <div className="text-[11px] text-muted">{pct(((lv.l18 - q.px) / q.px) * 100, 1)} / {pct(((lv.l25 - q.px) / q.px) * 100, 1)} from price</div>
                      </td>
                      <td className={TD_L}><RangeBar p={p} px={q.px} /><div className="mt-0.5 text-[11px] text-muted">{((q.px - p.fill) / lv.r).toFixed(2)}R now · risk {rupees(lv.r * p.shares)}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-[80ch] text-xs text-muted">
            There is no fixed profit target by design: this is a trend-following engine. The stop starts at the initial stop; once the highest price reaches 1.8R it moves to breakeven plus 0.2%; from 2.5R it trails
            (the highest of the earlier stop, breakeven+0.2%, the highest price minus 2.5 ATR and the 10-day average). A gap below the stop at the open exits at the open. R = fill minus the initial stop.
          </p>
        </>
      )}
    </Panel>
  );
}
