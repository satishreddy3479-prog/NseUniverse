import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type HeadsUpReminder, type HeadsUpTradeAlert } from "../lib/api";
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

const LEVEL = { good: ["●", "text-up"], bad: ["●", "text-down"], warn: ["▲", "text-brass"], info: ["●", "text-info"] } as const;
const clock = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));

/** The same alert raised several times (the same title, e.g. "GCSL: triggered, waiting for volume" at 09:34, 09:36 and 11:05) is one line: the newest, with how many times and since when. */
export type TradeGroup = HeadsUpTradeAlert & { count: number; first: string; keys: string[] };
export function groupTrades(alerts: HeadsUpTradeAlert[]): TradeGroup[] {
  const by = new Map<string, TradeGroup>();
  for (const a of alerts) {
    const id = `${a.source}|${a.title}`;
    const g = by.get(id);
    if (!g) by.set(id, { ...a, count: 1, first: a.at, keys: [a.key] });
    else {
      g.count += 1;
      g.keys.push(a.key);
      if (a.at > g.at) Object.assign(g, { at: a.at, text: a.text, key: a.key, link: a.link, level: a.level });
      if (a.at < g.first) g.first = a.at;
    }
  }
  return [...by.values()].sort((x, y) => (x.at < y.at ? 1 : -1));
}

const SHOWN = 3; // lines shown before "Show all": on a phone the strip was two thirds of the screen

function TradeAlert({ a }: { a: TradeGroup }) {
  const [icon, tone] = LEVEL[a.level] ?? LEVEL.info;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="headsup-trade">
      <span aria-hidden className={tone}>{icon}</span>
      <Link to={a.link} className="font-semibold hover:text-brass hover:underline">{a.title}</Link>
      <span className="text-xs text-muted">{a.source === "strategy" ? "Strategy" : "Swing"} · {clock(a.at)} IST · {a.text}{a.count > 1 ? ` · ${a.count} times since ${clock(a.first)} IST` : ""}</span>
    </li>
  );
}

/** Reminders for the catalysts of the next three days (daily, then every four hours in the last day) and fresh market-moving headlines, above every page. Closing it hides
 *  what is shown now; the next reminder phase of an event, or a new headline, shows again. Nothing renders when there is nothing to say or the feed is unavailable. */
export function HeadsUpStrip() {
  const q = useQuery({ queryKey: ["headsup"], queryFn: api.headsUp, refetchInterval: 60_000, retry: false });
  const tq = useQuery({ queryKey: ["headsup-trades"], queryFn: api.headsUpTrades, refetchInterval: 20_000, retry: false });
  const [hidden, setHidden] = useState<Record<string, number>>(() => loadHidden());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const d = q.data;
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false); // phones: the strip is one row until tapped (it was two thirds of the screen); from sm up it is always open
  const trades = groupTrades((tq.data?.alerts ?? []).filter((a) => !(hidden[a.key] && hidden[a.key]! > now)));
  if (!d && trades.length === 0) return null;
  const reminders = (d?.reminders ?? []).filter((r) => !(hidden[r.key] && hidden[r.key]! > now) && new Date(r.time_ist).getTime() > now - 60_000);
  const news = (d?.news ?? []).filter((n) => !(hidden[n.key] && hidden[n.key]! > now));
  if (reminders.length === 0 && news.length === 0 && trades.length === 0) return null;
  const close = () => {
    const next = { ...loadHidden(), ...hidden };
    for (const k of [...reminders.map((r) => r.key), ...news.map((n) => n.key), ...trades.flatMap((a) => a.keys)]) next[k] = Date.now() + KEEP_MS;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: closed for this visit only */ }
    setHidden(next);
  };
  const lines: { key: string; node: React.ReactNode }[] = [
    ...trades.map((a) => ({ key: a.key, node: <TradeAlert key={a.key} a={a} /> })),
    ...reminders.map((r) => ({ key: r.key, node: <Reminder key={r.key} r={r} now={now} /> })),
    ...news.map((n) => ({
      key: n.key,
      node: (
        <li key={n.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span aria-hidden className="text-brass">●</span>
          <a href={n.link} target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-brass hover:underline">{n.title}</a>
          <span className="text-xs text-muted">{n.source} · {n.age_min} min ago</span>
          {n.topics.map((t) => <span key={t} className="rounded-full bg-brass/15 px-2 py-0.5 text-[11px] text-brass">{t}</span>)}
        </li>
      ),
    })),
  ];
  return (
    <div role="region" aria-label="Heads up" data-testid="headsup-strip" className="border-b border-brass bg-brass/10 px-3 py-2 text-sm text-paper">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-brass">Heads up</span>
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="headsup-toggle" className="min-h-8 text-xs font-semibold text-info hover:underline sm:hidden">
              {open ? "Hide" : `${lines.length} item${lines.length === 1 ? "" : "s"} · show`}
            </button>
          </div>
          <div className={open ? "" : "max-sm:hidden"} data-testid="headsup-body">
            <ul className="mt-1 space-y-1.5 break-words">
              {lines.slice(0, all ? lines.length : SHOWN).map((l) => l.node)}
            </ul>
            {lines.length > SHOWN && (
              <button type="button" onClick={() => setAll(!all)} aria-expanded={all} data-testid="headsup-more" className="mt-1 min-h-8 text-xs font-semibold text-info hover:underline">
                {all ? "Show fewer" : `Show all ${lines.length}`}
              </button>
            )}
          </div>
        </div>
        <button type="button" onClick={close} aria-label="Close heads up" title="Close (an event comes back at its next reminder, news when a new headline arrives)"
          className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule bg-slate text-base leading-none text-muted hover:text-paper"><span aria-hidden>✕</span></button>
      </div>
    </div>
  );
}
