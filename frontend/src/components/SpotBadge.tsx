import { fmtDateTimeIST, fmtPct, fmtPrice, fmtSigned, fmtTimeIST } from "../lib/format";

/** True when the ISO time falls on today's date in India: an older snapshot carries its date so a Friday price is not read as today's. */
const sameIstDay = (iso: string): boolean => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10) === new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
import { INDEX_KEY } from "../lib/liveStore";
import { useSpotDisplay } from "../lib/useLive";
import type { SnapshotSummary } from "../lib/types";
import { Info } from "./Info";
import { SourceTag } from "./ui";

export { INDEX_KEY };

/** NIFTY 50 level in the header. Live when the stream is moving; when it is quiet the last live tick is held while it is newer than the
 *  latest snapshot (the pre-open price stays through 09:08-09:15 instead of jumping back to yesterday's close); otherwise the snapshot,
 *  labelled as such. Change is LTP minus previous close, shown only when both exist. */
export function SpotBadge({ latest, className = "" }: { latest: SnapshotSummary | undefined; className?: string }) {
  const spot = useSpotDisplay({ ltp: latest?.underlying_ltp ?? null, prevClose: latest?.underlying_prev_close ?? null, at: latest?.retrieved_at ?? null });
  const useLive = spot.kind === "live";
  const held = spot.kind === "held" && spot.indicative == null;
  const ltp = spot.ltp;
  const prev = spot.prevClose;
  if (ltp == null) return null;
  const chg = prev != null && prev > 0 ? ltp - prev : null;
  const pct = chg != null && prev ? (chg / prev) * 100 : null;
  const source = useLive ? "live" : (latest?.source ?? "snapshot");
  const tone = chg == null || chg === 0 ? "" : chg > 0 ? "text-up" : "text-down";
  return (
    <div className={`flex shrink-0 items-center gap-x-3 whitespace-nowrap leading-tight ${className}`} title={useLive ? "Live from the exchange feed" : held ? `Held: the last price from the exchange feed, ${spot.at ? fmtTimeIST(new Date(spot.at).toISOString()) : ""}. Live prices resume when the market opens.` : "From the latest snapshot, not live"}>
      <div className="hidden flex-col items-start gap-0.5 min-[520px]:flex">
        <span className="flex items-center gap-1.5 text-xs text-muted">NIFTY 50 {held ? <><span className="inline-flex items-center rounded-sm border border-warn/50 px-1.5 py-px text-xs font-medium text-warn" data-testid="spot-held">Held {spot.at ? fmtTimeIST(new Date(spot.at).toISOString()) : ""}</span> <Info term="held price" /></> : <SourceTag source={source} />}</span>
        {spot.kind === "snapshot" && latest && <span className="num text-[11px] text-muted" title={`Stored snapshot of the ${latest.expiry} expiry; each expiry reads the index on its own, so the other expiry can differ by a point or so`}>{sameIstDay(latest.retrieved_at) ? fmtTimeIST(latest.retrieved_at) : fmtDateTimeIST(latest.retrieved_at)} · {latest.expiry.slice(5)}</span>}
      </div>
      {spot.indicative != null && <span className="inline-flex flex-col rounded-sm border border-warn/50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-warn" data-testid="spot-indicative" title="The closing auction is running. The exchange publishes an indicative closing value that can sit far from the traded price while the order book fills; it is not a traded price. The level shown is the last traded one.">Closing auction<span className="num">indicative {fmtPrice(spot.indicative)}</span></span>}
      <div className="flex flex-col items-start gap-px leading-none min-[520px]:items-end min-[520px]:gap-0.5 min-[520px]:leading-tight">
        <span className="text-[10px] font-medium tracking-wide text-muted min-[520px]:hidden">NIFTY</span>
        <span className="num text-[17px] font-semibold leading-tight text-paper md:text-[15px]">{fmtPrice(ltp)}</span>
        <span className={`num text-[11px] font-medium min-[520px]:text-xs ${tone}`}>{chg == null ? "" : `${fmtSigned(Math.round(chg * 100) / 100)} (${fmtPct(pct)})`}</span>
      </div>
    </div>
  );
}
