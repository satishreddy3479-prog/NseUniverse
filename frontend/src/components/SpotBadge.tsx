import { fmtPct, fmtPrice, fmtSigned, fmtTimeIST } from "../lib/format";
import { INDEX_KEY } from "../lib/liveStore";
import { useLiveSpot } from "../lib/useLive";
import type { SnapshotSummary } from "../lib/types";
import { SourceTag } from "./ui";

export { INDEX_KEY };

/** NIFTY 50 level in the header. Live when the stream is moving; otherwise the latest snapshot
 *  value, labelled as such. Change is LTP minus previous close, shown only when both exist. */
export function SpotBadge({ latest, className = "" }: { latest: SnapshotSummary | undefined; className?: string }) {
  const spot = useLiveSpot();
  const useLive = spot.live;
  const ltp = useLive ? spot.ltp : (latest?.underlying_ltp ?? null);
  const prev = useLive ? spot.prevClose : (latest?.underlying_prev_close ?? null);
  if (ltp == null) return null;
  const chg = prev != null && prev > 0 ? ltp - prev : null;
  const pct = chg != null && prev ? (chg / prev) * 100 : null;
  const source = useLive ? "live" : (latest?.source ?? "snapshot");
  const tone = chg == null || chg === 0 ? "" : chg > 0 ? "text-up" : "text-down";
  return (
    <div className={`flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0 leading-tight ${className}`} title={useLive ? "Live from the exchange feed" : "From the latest snapshot, not live"}>
      <span className="flex items-center gap-1.5 text-xs text-muted">NIFTY 50 <SourceTag source={source} /></span>
      <span className="num text-[17px] font-semibold text-paper md:text-[15px]">{fmtPrice(ltp)}</span>
      <span className={`num text-xs font-medium ${tone}`}>{chg == null ? "" : `${fmtSigned(Math.round(chg * 100) / 100)} (${fmtPct(pct)})`}</span>
      {!useLive && latest && <span className="num text-[11px] text-muted" title={`Stored snapshot of the ${latest.expiry} expiry; each expiry reads the index on its own, so the other expiry can differ by a point or so`}>{fmtTimeIST(latest.retrieved_at)} · {latest.expiry.slice(5)}</span>}
    </div>
  );
}
