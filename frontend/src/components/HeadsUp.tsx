import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type HeadsUpReminder } from "../lib/api";
import { MISSING } from "../lib/format";

const KEY = "nse-universe.dismissed-headsup";
const KEEP_MS = 7 * 24 * 3_600_000; // a closed reminder is remembered this long; its next phase has a new key, so it comes back by itself

function loadHidden(now = Date.now()): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => typeof until === "number" && until > now));
  } catch {
    return {};
  }
}

const IST = "Asia/Kolkata";
const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));

/** "in 2 days", "in 3 h 20 min", "in 40 min", "starting now" from the minutes left. */
export function inText(min: number): string {
  if (min <= 1) return "starting now";
  if (min < 60) return `in ${min} min`;
  if (min < 24 * 60) return `in ${Math.floor(min / 60)} h ${min % 60} min`;
  const d = Math.round(min / (24 * 60));
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

function Reminder({ r, now }: { r: HeadsUpReminder; now: number }) {
  const min = Math.round((new Date(r.time_ist).getTime() - now) / 60000);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span aria-hidden className="text-brass">◷</span>
      <Link to="/tools/economic-calendar" className="font-semibold hover:text-brass hover:underline">{r.name}</Link>
      <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-muted">{r.country || "Global"}</span>
      <span className="text-info">{inText(min)}</span>
      <span className="text-xs text-muted">{when(r.time_ist)} IST · Previous {r.previous ?? MISSING} · Forecast {r.forecast ?? MISSING}</span>
    </li>
  );
}

/** Reminders for the catalysts of the next three days (daily, then every four hours in the last day) and fresh market-moving headlines, above every page. Closing it hides
 *  what is shown now; the next reminder phase of an event, or a new headline, shows again. Nothing renders when there is nothing to say or the feed is unavailable. */
export function HeadsUpStrip() {
  const q = useQuery({ queryKey: ["headsup"], queryFn: api.headsUp, refetchInterval: 60_000, retry: false });
  const [hidden, setHidden] = useState<Record<string, number>>(() => loadHidden());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const d = q.data;
  if (!d) return null;
  const reminders = (d.reminders ?? []).filter((r) => !(hidden[r.key] && hidden[r.key]! > now) && new Date(r.time_ist).getTime() > now - 60_000);
  const news = (d.news ?? []).filter((n) => !(hidden[n.key] && hidden[n.key]! > now));
  if (reminders.length === 0 && news.length === 0) return null;
  const close = () => {
    const next = { ...loadHidden(), ...hidden };
    for (const k of [...reminders.map((r) => r.key), ...news.map((n) => n.key)]) next[k] = Date.now() + KEEP_MS;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: closed for this visit only */ }
    setHidden(next);
  };
  return (
    <div role="region" aria-label="Heads up" data-testid="headsup-strip" className="border-b border-brass bg-brass/10 px-3 py-2 text-sm text-paper">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-brass">Heads up</span>
          <ul className="mt-1 space-y-1.5 break-words">
            {reminders.map((r) => <Reminder key={r.key} r={r} now={now} />)}
            {news.map((n) => (
              <li key={n.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span aria-hidden className="text-brass">●</span>
                <a href={n.link} target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-brass hover:underline">{n.title}</a>
                <span className="text-xs text-muted">{n.source} · {n.age_min} min ago</span>
                {n.topics.map((t) => <span key={t} className="rounded-full bg-brass/15 px-2 py-0.5 text-[11px] text-brass">{t}</span>)}
              </li>
            ))}
          </ul>
        </div>
        <button type="button" onClick={close} aria-label="Close heads up" title="Close (an event comes back at its next reminder, news when a new headline arrives)"
          className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule bg-slate text-base leading-none text-muted hover:text-paper"><span aria-hidden>✕</span></button>
      </div>
    </div>
  );
}
