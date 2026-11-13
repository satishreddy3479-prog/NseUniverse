import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";

/** What the server watchdog found, shown on every page while something is wrong (a dead feed, a lost broker login, a full disk, a missed backup).
 *  Nothing is shown when there are no alerts or where no watchdog runs (a development machine). */
export function AlertStrip() {
  const q = useQuery({ queryKey: ["ops-alerts"], queryFn: api.opsAlerts, refetchInterval: 60_000, retry: false });
  const d = q.data;
  if (!d || !d.available || d.alerts.length === 0) return null;
  const critical = d.alerts.some((a) => a.level === "critical");
  return (
    <div role="alert" data-testid="alert-strip"
      className={`border-b px-3 py-2 text-sm ${critical ? "border-down bg-down/10 text-paper" : "border-warn bg-warn/10 text-paper"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-semibold ${critical ? "text-down" : "text-warn"}`}>{critical ? "Needs attention" : "Heads up"}</span>
        <ul className="min-w-0 flex-1">
          {d.alerts.map((a) => <li key={a.key}><span className={a.level === "critical" ? "text-down" : "text-warn"}>●</span> {a.text}</li>)}
        </ul>
        <span className="text-[11px] text-muted">server check {d.checked_at ? fmtDateTimeIST(d.checked_at) : "—"} · <Link to="/diagnostics" className="text-info hover:underline">details</Link></span>
      </div>
    </div>
  );
}
