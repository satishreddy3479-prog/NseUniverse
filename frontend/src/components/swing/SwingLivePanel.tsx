import { Panel } from "../ui";
import { fmtInt, fmtPrice } from "../../lib/format";
import { fmtStamp, liveEventLabel, liveStateLabel, pct, pctTo, signedRupees } from "../../lib/swing";
import type { SwingLiveRow, SwingLiveView } from "../../lib/types";
import { TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";
const good = new Set(["triggered", "holding"]);
const bad = new Set(["stop_hit", "gap_skip"]);

function Levels({ r }: { r: SwingLiveRow }) {
  const d = (label: string, level: number | undefined) => (
    <span className="mr-3 whitespace-nowrap">{label} {level == null ? "—" : fmtPrice(level)}
      {pctTo(level, r.ltp) != null && <span className="text-muted"> ({pct(pctTo(level, r.ltp), 1)})</span>}</span>
  );
  if (r.kind === "order") return <>{d("Trigger", r.trigger)}{d("Stop", r.stop)}</>;
  return (
    <>
      {d("Stop", r.stop)}
      <span className="mr-3 whitespace-nowrap">1.8R {fmtPrice(r.level_1_8r ?? 0)}{r.reached_1_8r ? " ✓" : ""}</span>
      <span className="whitespace-nowrap">2.5R {fmtPrice(r.level_2_5r ?? 0)}{r.reached_2_5r ? " ✓" : ""}</span>
    </>
  );
}

export function SwingLivePanel({ live, loading, error }: { live: SwingLiveView | undefined; loading: boolean; error: unknown }) {
  return (
    <Panel title="Live prices from your Kotak feed">
      <div role="note" className="mb-3 rounded-sm border border-info/40 bg-info/10 px-3 py-2 text-sm">
        <p className="font-medium text-paper">Shadow mode: shown and logged, the paper book is not changed</p>
        <p className="mt-1 text-muted">
          Live price and volume for tonight&apos;s queued orders and your open positions, checked against the same rules every few seconds.
          What the rules would do right now is logged once a day. The paper book still follows the end-of-day settlement until a
          session&apos;s live decisions have been compared with it.
        </p>
      </div>
      {loading && <p className="text-sm text-muted">Reading the live view…</p>}
      {error != null && !live && <p role="alert" className="text-sm text-down">Could not read the live view: {error instanceof Error ? error.message : "unknown error"}</p>}
      {live && (
        <>
          <p className="mb-2 text-sm" data-testid="live-status">
            Market: <b>{live.market === "open" ? "open" : "closed (09:15-15:30 IST)"}</b> · Kotak feed: <b>{live.feed_state.replace("_", " ")}</b>
            {live.market === "closed" && <span className="text-muted"> · last prices are shown; decisions run only during the session</span>}
          </p>
          {live.note && <p className="mb-2 text-sm text-warn" role="status">{live.note}</p>}
          {live.watching.length === 0 ? (
            <p className="text-sm text-muted">Nothing to watch: no queued orders and no open positions.</p>
          ) : (
            <div className={TABLE_WRAP}>
              <table className="num w-full min-w-[900px] text-sm">
                <caption className="sr-only">Live prices for watched stocks</caption>
                <thead className={THEAD}>
                  <tr><th scope="col" className={TH_L}>Stock</th><th scope="col" className={TH_L}>What</th>
                    <th scope="col" className={TH_R}>Price</th><th scope="col" className={TH_R}>Day change</th>
                    <th scope="col" className={TH_R}>Volume</th><th scope="col" className={TH_L}>Levels (distance from price)</th>
                    <th scope="col" className={TH_L}>Now</th></tr>
                </thead>
                <tbody>
                  {live.watching.map((r) => (
                    <tr key={`${r.kind}-${r.symbol}`} className="border-t border-rule">
                      <th scope="row" className={`${TD_L} font-medium text-paper`}>{r.symbol}</th>
                      <td className={TD_L}>{r.kind === "order" ? `Queued order #${r.rank ?? ""}` : `Position, ${fmtInt(r.shares ?? 0)} sh`}</td>
                      <td className={TD}>{r.ltp == null ? "—" : fmtPrice(r.ltp)}{r.stale && r.ltp != null && <span className="text-warn"> (stale)</span>}</td>
                      <td className={`${TD} ${(r.change_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>{r.change_pct == null ? "—" : pct(r.change_pct, 2)}</td>
                      <td className={TD}>{r.volume == null ? "—" : fmtInt(r.volume)}
                        {r.kind === "order" && r.pace != null && <span className="text-muted"> ({Math.round(r.pace * 100)}% of pace)</span>}</td>
                      <td className={TD_L}><Levels r={r} /></td>
                      <td className={`${TD_L} ${good.has(r.state) ? "text-up" : bad.has(r.state) ? "text-down" : ""}`}>
                        {liveStateLabel(r.state)}
                        {r.kind === "position" && r.unrealized_pnl != null && <span className="text-muted"> · {signedRupees(r.unrealized_pnl)}</span>}
                        {!r.has_token && <span className="text-warn"> · no Kotak token</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="mb-1 mt-4 text-sm font-medium text-paper">Shadow decisions today</h3>
          {live.events.length === 0 ? (
            <p className="text-sm text-muted">None yet today. Each appears once, the first time the rule is met.</p>
          ) : (
            <ul className="space-y-1 text-sm" aria-label="Shadow decisions today">
              {live.events.map((e) => (
                <li key={`${e.kind}-${e.symbol}`} className="num">
                  <span className="text-muted">{fmtStamp(e.at, true)}</span> · <b>{e.symbol}</b> · {liveEventLabel(e.kind)}
                  {e.price != null && <> at {fmtPrice(e.price)}</>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
