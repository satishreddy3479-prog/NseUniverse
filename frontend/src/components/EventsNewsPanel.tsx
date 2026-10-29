import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { NewsStatus } from "../lib/types";
import { Panel } from "./ui";

const when = (iso: string, allDay: boolean) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", hour: allDay ? undefined : "2-digit", minute: allDay ? undefined : "2-digit" }) + (allDay ? " (all day)" : " IST");

/** Scheduled macro events (official calendars) and the daily news-tone series being collected. */
export function EventsNewsPanel() {
  const ev = useQuery({ queryKey: ["events"], queryFn: api.events, retry: false, staleTime: 300_000 });
  const news = useQuery({ queryKey: ["news-status"], queryFn: api.newsStatus, retry: false, refetchInterval: 60_000 });
  const n = news.data;
  return (
    <Panel title="Events and news">
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-sm font-medium">Upcoming scheduled events (next 45 days)</p>
          {ev.isPending ? <p className="text-sm text-muted">Loading…</p>
            : ev.error || !ev.data ? <p className="text-sm text-muted">Not available: the running backend does not have this module yet.</p>
            : ev.data.events.length === 0 ? <p className="text-sm text-muted">No scheduled high-impact events in the calendar for the next 45 days.</p>
            : (
              <table className="w-full text-sm" aria-label="Upcoming events">
                <thead className="text-xs text-muted"><tr><th className="text-left font-normal">When</th><th className="text-left font-normal">Event</th><th className="text-left font-normal">Impact</th></tr></thead>
                <tbody>
                  {ev.data.events.map((e) => (
                    <tr key={e.id} className="border-t border-rule/50" title={e.source}>
                      <td className="num py-1 pr-3 whitespace-nowrap">{when(e.start_ist, e.all_day)}{!e.time_verified && !e.all_day && <span className="text-muted"> (time usual, unconfirmed)</span>}{e.tentative && <span className="text-muted"> (tentative)</span>}</td>
                      <td>{e.name}</td>
                      <td className={e.impact === "high" ? "text-warn" : "text-muted"}>{e.impact}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <p className="mt-1 text-xs text-muted">Dates come from the official central-bank, statistics-office and election calendars (hover a row for its source). For the next-session forecast, a directional call is withheld when a high-impact event falls before the target close. That is a precaution, not a validated improvement.</p>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">News tone (GDELT, daily average; negative = gloomier coverage)</p>
          {news.isPending ? <p className="text-sm text-muted">Loading…</p>
            : news.error || !n ? <p className="text-sm text-muted">Not available: the running backend does not have this module yet.</p>
            : n.coverage.days === 0 ? <p className="text-sm text-muted" data-testid="news-empty">No news data collected yet. It starts by itself and refreshes twice a day.{n.problems.length > 0 ? ` Last problem: ${n.problems[0]}` : ""}</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="News tone">
                  <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Theme</th><th className="text-right font-normal">Latest day</th><th className="text-right font-normal">Tone</th><th className="text-right font-normal">Share of coverage</th><th className="text-right font-normal">Previous day tone</th></tr></thead>
                  <tbody>
                    {(Object.entries(n.latest) as [string, NewsStatus["latest"][string]][]).map(([k, rows]) => (
                      <tr key={k} className="num border-t border-rule/50">
                        <td className="font-sans">{n.themes[k] ?? k}</td><td className="text-right">{rows[0]?.day ?? "—"}</td>
                        <td className={`text-right ${rows[0]?.tone == null ? "" : rows[0].tone < 0 ? "text-down" : "text-up"}`}>{rows[0]?.tone?.toFixed(2) ?? "—"}</td>
                        <td className="text-right">{rows[0]?.volume_pct != null ? `${rows[0].volume_pct.toFixed(3)}%` : "—"}</td>
                        <td className="text-right text-muted">{rows[1]?.tone?.toFixed(2) ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {n && <p className="mt-1 text-xs text-muted">{n.model_use}. Collecting since {n.coverage.collecting_since ? n.coverage.collecting_since.slice(0, 10) : "—"}. Not used: {n.not_used}.</p>}
        </div>
      </div>
    </Panel>
  );
}
