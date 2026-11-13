import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type OpsAlert } from "../lib/api";
import { fmtTimeIST } from "../lib/format";

const KEY = "nse-universe.dismissed-alerts";
/** How long a closed alert stays closed: a warning for a day, a critical one for an hour (it comes back if the problem is still there). */
const HIDE_MS = { warning: 24 * 3_600_000, critical: 3_600_000 } as const;

function loadHidden(now = Date.now()): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => typeof until === "number" && until > now));
  } catch {
    return {};
  }
}

/** What the server watchdog found, shown on every page while something is wrong (a dead feed, a lost broker login, a full disk, a missed backup).
 *  Each alert can be closed with the cross; it returns after a day (an hour for a critical one) if the problem is still there.
 *  Nothing is shown when there are no alerts (on a development machine only the app's own consistency checks, such as the lot size, can appear). */
export function AlertStrip() {
  const q = useQuery({ queryKey: ["ops-alerts"], queryFn: api.opsAlerts, refetchInterval: 60_000, retry: false });
  const [hidden, setHidden] = useState<Record<string, number>>(() => loadHidden());
  const d = q.data;
  const now = Date.now();
  const shown: OpsAlert[] = (d?.alerts ?? []).filter((a) => !(hidden[a.key] && hidden[a.key]! > now));
  if (!d || shown.length === 0) return null;
  const critical = shown.some((a) => a.level === "critical");
  const close = () => {
    const next = { ...loadHidden(), ...hidden };
    for (const a of shown) next[a.key] = Date.now() + HIDE_MS[a.level];
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: the strip is closed for this visit only */ }
    setHidden(next);
  };
  return (
    <div role="alert" data-testid="alert-strip"
      className={`border-b px-3 py-2 text-sm ${critical ? "border-down bg-down/10 text-paper" : "border-warn bg-warn/10 text-paper"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`font-semibold ${critical ? "text-down" : "text-warn"}`}>{critical ? "Needs attention" : "Heads up"}</span>
            <span className="text-[11px] text-muted">checked {d.checked_at ? fmtTimeIST(d.checked_at) : "—"} · <Link to="/diagnostics" className="text-info hover:underline">details</Link></span>
          </div>
          <ul className="mt-1 space-y-1 break-words">
            {shown.map((a) => (
              <li key={a.key} className="flex gap-1.5">
                <span aria-hidden className={`shrink-0 ${a.level === "critical" ? "text-down" : "text-warn"}`}>●</span>
                <span className="min-w-0">{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" onClick={close} aria-label="Close this message" title="Close (it returns later if the problem is still there)"
          className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule bg-slate text-base leading-none text-muted hover:text-paper">
          <span aria-hidden>✕</span>
        </button>
      </div>
    </div>
  );
}
