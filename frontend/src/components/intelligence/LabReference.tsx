import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { LabReference } from "../../lib/entryLab";
import { MISSING } from "../../lib/format";

const sg = (v: number | null | undefined, d = 0) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");

function Row({ name, b, lot, testid }: { name: string; b: LabReference["plain"]; lot: number; testid: string }) {
  return (
    <tr className="border-t border-rule/50" data-testid={testid}>
      <td className="py-1 text-paper">{name}</td>
      <td className="num text-right">{b.days}</td>
      <td className={`num text-right ${tone(b.median)}`}>{sg(b.median, 1)}</td>
      <td className={`num text-right ${tone(b.mean)}`}>{sg(b.mean, 1)}</td>
      <td className="num text-right">{b.win_pct == null ? MISSING : `${b.win_pct.toFixed(0)}%`}</td>
      <td className={`num text-right font-semibold ${tone(b.worst)}`}>{b.worst == null ? MISSING : `${sg(b.worst)} (₹${Math.abs(Math.round(b.worst * lot)).toLocaleString("en-IN")} a lot)`}</td>
    </tr>
  );
}

/** What the recorded sessions say about selling a straddle at about this time of day, beside the live reading: the typical day and the worst day, so the size of the bad day is known before the entry. */
export function LabReferenceCard() {
  const q = useQuery({ queryKey: ["lab-reference"], queryFn: api.labReference, refetchInterval: 120_000, retry: false });
  const d = q.data;
  const shell = (body: React.ReactNode) => (
    <section aria-label="What the recorded days say" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="lab-reference">
      <h2 className="text-sm font-semibold text-paper">What the recorded days say <span className="font-normal text-muted">· the typical day and the bad day, before you decide</span></h2>
      {body}
    </section>
  );
  if (q.isPending) return <div className="h-16 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="labref-loading" />;
  if (q.isError || !d || !d.plain || !d.stop20) return shell(<p role="alert" className="mt-2 text-xs text-down" data-testid="labref-error">The recorded-day history could not be loaded.</p>);
  if (!d.plain.days) return shell(<p className="mt-2 text-xs text-muted" data-testid="labref-empty">{d.status.loading ? `Loading the recorded days (${d.status.days_loaded} of ${d.status.days_total}).` : "No recorded day could be replayed for this time."}</p>);
  return shell(
    <>
      <p className="mt-1 text-[11px] text-muted" data-testid="labref-lead">Short ATM straddle sold at {d.entry} and held to {d.exit}, on the {d.plain.days} recorded days{d.status.loading ? " loaded so far" : ""}. Points; net of 2 points.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-xs">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Rule</th><th className="text-right font-normal">Days</th><th className="text-right font-normal">Typical (median)</th><th className="text-right font-normal">Mean</th><th className="text-right font-normal">Won</th><th className="text-right font-normal">Worst day</th></tr></thead>
          <tbody>
            <Row testid="labref-plain" name="Held to the close" b={d.plain} lot={d.lot} />
            <Row testid="labref-stop" name="With a 20% premium stop" b={d.stop20} lot={d.lot} />
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted" data-testid="labref-caution">{d.plain.sufficient ? "" : `Only ${d.plain.days} days (at least ${d.plain.min_days} before this is a finding). `}{d.caution} <Link to="/market-intelligence/entry-lab" className="text-info hover:underline">Entry Lab →</Link></p>
    </>,
  );
}
