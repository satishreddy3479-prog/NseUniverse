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

/** One alert's text: on a phone long texts show three lines and a "More" button (the holiday-list alert was seven lines of a 812 px screen); from the sm breakpoint up the whole text shows. */
function AlertText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 110;
  return (
    <span className="min-w-0">
      <span className={long && !open ? "line-clamp-3 sm:line-clamp-none" : ""}>{text}</span>
      {long && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="ml-1 min-h-8 text-xs font-semibold text-info hover:underline sm:hidden">{open ? "Less" : "More"}</button>}
    </span>
  );
}

/** What the server watchdog found, shown on every page while something is wrong (a dead feed, a lost broker login, a full disk, a missed backup).
 *  Each alert can be closed with the cross; it returns after a day (an hour for a critical one) if the problem is still there.
 *  Nothing is shown when there are no alerts (on a development machine only the app's own consistency checks, such as the lot size, can appear). */
export function AlertStrip() {
  const q = useQuery({ queryKey: ["ops-alerts"], queryFn: api.opsAlerts, refetchInterval: 60_000, retry: false });
  const [hidden, setHidden] = useState<Record<string, number>>(() => loadHidden());
  const [openOnPhone, setOpenOnPhone] = useState(false);
  const d = q.data;
  const now = Date.now();
  const shown: OpsAlert[] = (d?.alerts ?? []).filter((a) => !(hidden[a.key] && hidden[a.key]! > now));
  if (!d || shown.length === 0) return null;
  const critical = shown.some((a) => a.level === "critical");
  const open = critical || openOnPhone; // a critical alert (a dead feed, a lost login) is never folded away; the rest fold to one row on a phone
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
            <span className="text-[11px] text-muted">checked {d.checked_at ? fmtTimeIST(d.checked_at) : "—"} · <Link to="/diagnostics" className="inline-flex min-h-7 items-center px-1 text-info hover:underline">details</Link></span>
            {!critical && <button type="button" onClick={() => setOpenOnPhone(!openOnPhone)} aria-expanded={open} data-testid="alert-toggle" className="min-h-8 text-xs font-semibold text-info hover:underline sm:hidden">{open ? "Hide" : `${shown.length} alert${shown.length === 1 ? "" : "s"} · show`}</button>}
          </div>
          <ul className={`mt-1 space-y-1 break-words ${open ? "" : "max-sm:hidden"}`} data-testid="alert-list">
            {shown.map((a) => (
              <li key={a.key} className="flex gap-1.5">
                <span aria-hidden className={`shrink-0 ${a.level === "critical" ? "text-down" : "text-warn"}`}>●</span>
                <AlertText text={a.text} />
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
