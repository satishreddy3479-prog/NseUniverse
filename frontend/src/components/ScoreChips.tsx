import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtTimeIST } from "../lib/format";

const STALE_S = 15 * 60; // a score older than this is not shown: nothing is recorded outside market hours
const tone = (v: number) => (v >= 60 ? "text-up font-semibold" : v >= 45 ? "text-paper" : "text-muted");
const move = (now: number, before: number | null | undefined) => (before == null ? "" : `, ${now - before >= 0 ? "up" : "down"} ${Math.abs(Math.round(now - before))} in 15 min`);

/** The straddle engine's buyer and seller environment scores, stacked (buyer above seller) next to the NIFTY price. Nothing renders when the engine has not recorded a minute
 *  in the last 15 minutes or is switched off, so the bar stays as it was. A green number means 60 or more: favourable for that side's premium behaviour, not a trade signal. */
export function ScoreChips() {
  const q = useQuery({ queryKey: ["straddleScores"], queryFn: api.straddleScores, refetchInterval: 30_000, retry: false });
  const d = q.data;
  if (!d?.available || d.seller == null || d.buyer == null || d.age_s == null || d.age_s > STALE_S) return null;
  const title = [
    `Straddle engine, expiry ${d.expiry ?? "—"}, recorded ${fmtTimeIST(d.at)}`,
    `Seller environment ${Math.round(d.seller)}${move(d.seller, d.seller_15m)}`,
    `Buyer environment ${Math.round(d.buyer)}${move(d.buyer, d.buyer_15m)}`,
    `${d.regime ?? "no regime"} · 60 or more is favourable for that side's premium behaviour; not a trade signal`,
  ].join("\n");
  const row = (label: string, v: number) => (
    <span className="flex items-baseline gap-1"><span className="w-2.5 text-[10px] font-medium text-muted">{label}</span><span className={`num text-xs ${tone(v)}`}>{Math.round(v)}</span></span>
  );
  return (
    <Link to="/market-intelligence/straddle" title={title} aria-label={`Buyer environment ${Math.round(d.buyer)}, seller environment ${Math.round(d.seller)}: open the straddle intelligence`}
      data-testid="score-chips" className="flex shrink-0 flex-col justify-center gap-0.5 rounded-sm border border-rule px-1.5 py-0.5 leading-tight hover:border-brass">
      {row("B", d.buyer)}
      {row("S", d.seller)}
    </Link>
  );
}
