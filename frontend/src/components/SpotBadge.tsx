import { fmtDateTimeIST, fmtPct, fmtPrice, fmtSigned, fmtTimeIST } from "../lib/format";
import { marketClockMs } from "../lib/session";

import { INDEX_KEY } from "../lib/liveStore";
import { useSpotDisplay } from "../lib/useLive";
import type { SnapshotSummary } from "../lib/types";
import { Info } from "./Info";
import { SourceTag } from "./ui";

/** The time the prices in a stored snapshot are as of: the fetch time during the session, otherwise the close of the last session (holidays and weekends skipped). A chain fetched again
 *  after a restart at 10:32 on a holiday holds the previous session's close, so the badge keeps showing that close instead of a time that changes with every restart. */
const asOfIso = (s: SnapshotSummary): string => new Date(marketClockMs(Date.parse(s.retrieved_at))).toISOString();
const IST_DAY = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
/** The time of the prices and the trading date they belong to (the expiry of the chain is in the tooltip: it is not the date of the prices). */
const asOfText = (s: SnapshotSummary): string => { const iso = asOfIso(s); return `${fmtTimeIST(iso)} · ${IST_DAY.format(new Date(iso))}`; };
const asOfTitle = (s: SnapshotSummary): string => {
  const base = `Stored snapshot of the ${s.expiry} expiry; each expiry reads the index on its own, so the other expiry can differ by a point or so`;
  return asOfIso(s) === new Date(Date.parse(s.retrieved_at)).toISOString() ? base : `${base}. The market is closed: these are the prices of the last session close (${fmtDateTimeIST(asOfIso(s))}); the chain was fetched again at ${fmtDateTimeIST(s.retrieved_at)}.`;
};

export { INDEX_KEY };

/** NIFTY 50 level in the header. Live when the stream is moving; when it is quiet the last live tick is held while it is newer than the
 *  latest snapshot (the pre-open price stays through 09:08-09:15 instead of jumping back to yesterday's close); otherwise the snapshot,
 *  labelled as such. Change is LTP minus previous close, shown only when both exist. */
export function SpotBadge({ latest, className = "" }: { latest: SnapshotSummary | undefined; className?: string }) {
  const spot = useSpotDisplay({ ltp: latest?.underlying_ltp ?? null, prevClose: latest?.underlying_prev_close ?? null, at: latest?.retrieved_at ?? null });
  const useLive = spot.kind === "live";
  const held = spot.kind === "held" && spot.indicative == null;
  const closed = spot.kind === "close";
  const ltp = spot.ltp;
  const prev = spot.prevClose;
  if (ltp == null) return null;
  const chg = prev != null && prev > 0 ? ltp - prev : null;
  const pct = chg != null && prev ? (chg / prev) * 100 : null;
  const source = useLive ? "live" : (latest?.source ?? "snapshot");
  const tone = chg == null || chg === 0 ? "" : chg > 0 ? "text-up" : "text-down";
  return (
    <div className={`flex shrink-0 items-center gap-x-3 whitespace-nowrap leading-tight ${className}`} title={useLive ? "Live from the exchange feed" : closed ? "The last value of the closing auction, which brokers show as the close. It is an auction value, not a traded price." : held ? `Held: the last price from the exchange feed, ${spot.at ? fmtTimeIST(new Date(spot.at).toISOString()) : ""}. Live prices resume when the market opens.` : "From the latest snapshot, not live"}>
      <div className="hidden flex-col items-start gap-0.5 min-[520px]:flex">
        <span className="flex items-center gap-1.5 text-xs text-muted">NIFTY 50 {closed ? <span className="inline-flex items-center rounded-sm border border-rule px-1.5 py-px text-xs font-medium text-muted" data-testid="spot-close">Close {spot.at ? fmtTimeIST(new Date(spot.at).toISOString()) : ""}</span> : held ? <><span className="inline-flex items-center rounded-sm border border-warn/50 px-1.5 py-px text-xs font-medium text-warn" data-testid="spot-held">Held {spot.at ? fmtTimeIST(new Date(spot.at).toISOString()) : ""}</span> <Info term="held price" /></> : <SourceTag source={source} />}</span>
        {spot.kind === "snapshot" && latest && <span className="num text-[11px] text-muted" title={asOfTitle(latest)}>{asOfText(latest)}</span>}
      </div>
      {spot.indicative != null && <span aria-label={`Closing auction, indicative value ${fmtPrice(spot.indicative)}`} className="hidden shrink-0 flex-col rounded-sm border border-warn/50 px-1.5 py-0.5 text-[10px] min-[520px]:inline-flex font-medium leading-tight text-warn" data-testid="spot-indicative" title="The closing auction is running. The exchange publishes an indicative closing value that can sit far from the traded price while the order book fills; it is not a traded price. The level shown is the last traded one.">Closing auction<span className="num">indicative {fmtPrice(spot.indicative)}</span></span>}
      <div className="flex flex-col items-start gap-px leading-none min-[520px]:items-end min-[520px]:gap-0.5 min-[520px]:leading-tight">
        <span className="text-[10px] font-medium tracking-wide text-muted min-[520px]:hidden">NIFTY</span>
        <span className="num text-[17px] font-semibold leading-tight text-paper md:text-[15px]">{fmtPrice(ltp)}</span>
        <span className={`num text-[11px] font-medium min-[520px]:text-xs ${tone}`}>{chg == null ? "" : `${fmtSigned(Math.round(chg * 100) / 100)} (${fmtPct(pct)})`}</span>
      </div>
    </div>
  );
}

/** On a phone the header has no room for the closing-auction value (it pushed the price, the scores and the buttons off the screen at 15:23 on 25 Nov 2026): it gets its own thin line under the header instead. */
export function AuctionStrip({ latest }: { latest: SnapshotSummary | undefined }) {
  const spot = useSpotDisplay({ ltp: latest?.underlying_ltp ?? null, prevClose: latest?.underlying_prev_close ?? null, at: latest?.retrieved_at ?? null });
  if (spot.indicative == null) return null;
  return (
    <div role="status" data-testid="auction-strip" className="border-b border-warn/40 bg-warn/10 px-3 py-1 text-xs text-warn min-[520px]:hidden">
      Closing auction: indicative value <span className="num font-semibold">{fmtPrice(spot.indicative)}</span> (not a traded price; the level above is the last trade)
    </div>
  );
}
