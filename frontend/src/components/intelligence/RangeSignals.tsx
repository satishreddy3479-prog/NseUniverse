import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtTimeIST, MISSING } from "../../lib/format";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);

function Item({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid: string }) {
  return <div className="rounded-sm border border-rule/60 bg-slate-2 px-2 py-1.5" data-testid={testid}><div className="text-[11px] text-muted">{label}</div><div className="num text-sm font-semibold text-paper">{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>;
}

/** How far NIFTY has moved today and whether the move is speeding up. A description of the day so far, not a forecast; the Entry Lab tests whether these numbers have mattered. */
export function RangeSignalsCard() {
  const q = useQuery({ queryKey: ["range-signals"], queryFn: api.rangeSignals, refetchInterval: 30_000, retry: false });
  const d = q.data;
  const shell = (body: React.ReactNode) => (
    <section aria-label="Range so far today" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="range-signals">
      <h2 className="text-sm font-semibold text-paper">Range so far today <span className="font-normal text-muted">· has NIFTY already moved more than the premium pays for?</span></h2>
      {body}
    </section>
  );
  if (q.isPending) return <div className="h-16 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="range-loading" />;
  if (q.isError) return shell(<p role="alert" className="mt-2 text-xs text-down" data-testid="range-error">The range signals could not be loaded.</p>);
  if (!d || !d.available) return shell(<p className="mt-2 text-xs text-muted" data-testid="range-unavailable">Not available: {d && !d.available ? d.reason : "no answer"}.</p>);
  return shell(
    <>
      <p className="mt-1 text-[11px] text-muted" data-testid="range-asof">As of {fmtTimeIST(d.as_of)}, session {d.session}{d.live ? "" : " (stored session, not live)"}{d.stale ? " · the newest stored minute is stale" : ""}. {d.note}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Item testid="range-gap" label="Opening gap" value={d.gap_pts == null ? MISSING : `${sg(d.gap_pts, 0)} pts`} sub={d.gap_pct == null ? "no previous close" : `${sg(d.gap_pct, 2)}% of the previous close`} />
        <Item testid="range-so-far" label="Range so far" value={d.range_so_far == null ? MISSING : `${d.range_so_far.toFixed(0)} pts`} sub={d.range_ratio == null ? undefined : `${d.range_ratio.toFixed(2)} × the ${d.premium.toFixed(0)}-point straddle`} />
        <Item testid="range-break" label="Opening range" value={d.or_break == null ? (d.minutes != null && d.minutes >= 30 ? "Inside" : "Forming") : d.or_break === "up" ? "Broken upwards" : "Broken downwards"} sub="first 30 minutes, 10-point margin" />
        <Item testid="range-eff" label="Last 30 minutes" value={d.eff30 == null ? MISSING : d.eff30.toFixed(2)} sub="1.0 = a straight line, near 0 = going nowhere" />
        <Item testid="range-acc" label="Speeding up?" value={d.acc == null ? MISSING : `${d.acc.toFixed(2)}×`} sub="range of the last 15 min against the 15 before" />
        <Item testid="range-prem" label="Straddle premium" value={`${d.premium.toFixed(0)} pts`} sub={d.premium_pct == null ? undefined : `${d.premium_pct.toFixed(2)}% of NIFTY`} />
      </div>
      <p className="mt-2 text-[11px] text-muted"><Link to="/market-intelligence/entry-lab" className="text-info hover:underline">Entry Lab: do these signals separate good entry days from bad ones? →</Link></p>
    </>,
  );
}
