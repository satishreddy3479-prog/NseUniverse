import { useState } from "react";
import { Link } from "react-router-dom";
import { fmtDateTimeIST, MISSING } from "../../lib/format";
import type { Capability } from "../../lib/intelligence";

const STATE_TONE: Record<string, string> = { AVAILABLE: "text-up", PARTIAL: "text-warn", UNAVAILABLE: "text-down" };
const WHY: Record<string, { text: string; title: string }> = {
  feed: { text: "Not in the broker feed", title: "The feed does not carry this data at all, so it cannot be collected whatever the app subscribes to" },
  not_subscribed: { text: "Not subscribed yet", title: "This data exists at the exchange, but nothing in the app subscribes to or stores it yet" },
  no_data_yet: { text: "No data stored yet", title: "The live tracker has nothing and no minute of it has been stored today" },
};

/** A source's own timestamp: a full timestamp as IST date and time, a plain date (daily closes) as it is. */
export function asOf(v: string | null): string {
  if (!v) return MISSING;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v} (daily)` : fmtDateTimeIST(v);
}

/** Every capability of the dashboard with its state, its own timestamp and, when it does not exist, WHY. Order and ids are those of the backend. */
export function Capabilities({ items }: { items: Capability[] }) {
  const [gaps, setGaps] = useState(false);
  const n = (s: string) => items.filter((c) => c.status === s).length;
  const rows = gaps ? items.filter((c) => c.status !== "AVAILABLE") : items;
  const feed = items.filter((c) => c.why === "feed").length, sub = items.filter((c) => c.why === "not_subscribed").length;
  return (
    <section aria-label="Data quality and freshness" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-capabilities">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Data quality and freshness <span className="font-normal text-muted">· what exists today, each with its own source timestamp</span></h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={gaps} onChange={(e) => setGaps(e.target.checked)} />Show only what is not fully available</label>
      </div>
      <p className="mb-2 text-xs text-paper" data-testid="mi-cap-summary">
        <span className="text-up">{n("AVAILABLE")} available</span> · <span className="text-warn">{n("PARTIAL")} partial</span> · <span className="text-down">{n("UNAVAILABLE")} unavailable</span>
        {feed + sub > 0 && <span className="text-muted"> (of those, {feed} the broker feed does not carry and {sub} not subscribed yet)</span>}
      </p>
      <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="w-[22%] py-1 font-normal">Capability</th><th className="w-[14%] py-1 font-normal">Status</th><th className="w-[14%] py-1 font-normal">Source as of</th><th className="py-1 font-normal">Why</th></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id} className="border-t border-rule/50 align-top" data-testid={`mi-cap-${c.id}`}>
            <td className="py-1.5 pr-2 text-paper">{c.link ? <Link to={c.link} className="text-info hover:underline">{c.name}</Link> : c.name}</td>
            <td className="whitespace-nowrap py-1.5 pr-2"><span className={`font-semibold ${STATE_TONE[c.status] ?? "text-muted"}`}>{c.status}</span>{c.status !== "AVAILABLE" && c.why && WHY[c.why] && <div className="mt-0.5 text-[10px] text-muted" title={WHY[c.why]!.title}>{WHY[c.why]!.text}</div>}</td>
            <td className="num whitespace-nowrap py-1.5 pr-2 text-muted">{asOf(c.as_of)}</td>
            <td className="py-1.5 text-muted">{c.reason}</td>
          </tr>))}</tbody></table></div>
      <p className="mt-2 text-[11px] text-muted">AVAILABLE: computed in full from stored or live data. PARTIAL: an incomplete calculation or coverage, or the last stored minute while the live feed is not pushing (counted for only the share of its evidence that exists). UNAVAILABLE: the data is not collected or stored; nothing is estimated in its place.</p>
    </section>
  );
}
