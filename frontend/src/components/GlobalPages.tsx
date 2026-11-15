import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CalEvent, type GlobalItem, type NewsItem } from "../lib/api";
import { fmtAge, MISSING } from "../lib/format";
import { EChart, useChartColors } from "./EChart";

const Loading = () => <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
const Problem = ({ what, e }: { what: string; e: unknown }) => (
  <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">{what} could not be loaded: {e instanceof Error ? e.message : "unknown error"}.</p>
);

const num = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v: number, d: number) => `${v >= 0 ? "+" : "−"}${num(Math.abs(v), d)}`;
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");
const IST = "Asia/Kolkata";
const istTime = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));
const istDay = (iso: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST }).format(new Date(iso));

const STATUS: Record<string, { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-up" },
  stale: { label: "Stale", dot: "bg-warn" },
  closed: { label: "Closed", dot: "bg-muted" },
  "no data": { label: "No data", dot: "bg-down" },
};
function StatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, dot: "bg-down" };
  return <span className="inline-flex items-center gap-1 rounded-full border border-rule px-2 py-0.5 text-[11px] text-muted"><span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />{s.label}</span>;
}

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <div className="h-8" aria-hidden />;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label="Recent trend">
      <polyline points={pts} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Card({ it, selected, onPick }: { it: GlobalItem; selected: boolean; onPick: () => void }) {
  const has = it.price != null;
  const d = it.decimals;
  const up = (it.change ?? 0) >= 0;
  return (
    <button type="button" onClick={onPick} aria-pressed={selected} disabled={!has}
      className={`flex flex-col gap-1 rounded-[var(--radius-panel)] border p-3 text-left transition-colors disabled:opacity-60 ${selected ? "border-brass bg-brass/10" : "border-rule bg-slate hover:border-muted"}`}>
      <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{it.name}</span><StatusChip status={it.status} /></span>
      <span className="text-xl font-semibold tabular-nums">{has ? `${num(it.price as number, d)}${it.yield ? "%" : ""}` : MISSING}</span>
      <span className={`text-sm tabular-nums ${tone(it.change)}`}>
        {it.change == null ? "No reference close" : it.yield && it.bp != null ? `${signed(it.bp, 1)} bp` : `${signed(it.change, d)} (${signed(it.change_pct ?? 0, 2)}%)`}
      </span>
      {has && it.spark ? <Spark values={it.spark} up={up} /> : null}
      <span className="text-[11px] text-muted">{has ? `${it.status === "live" ? "Updated" : "Last price"} ${fmtAge(it.age_s)}` : "No price stored yet"}</span>
    </button>
  );
}

function SeriesChart({ item }: { item: GlobalItem }) {
  const colors = useChartColors();
  const q = useQuery({ queryKey: ["globalSeries", item.key], queryFn: () => api.globalSeries(item.key, 24), refetchInterval: 60_000, retry: false });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The chart" e={q.error} />;
  const s = q.data;
  if (s.prices.length < 2) return <p className="p-4 text-sm text-muted">Not enough stored one-minute prices yet to draw {item.name}.</p>;
  const d = item.decimals;
  const option = {
    animation: false, grid: { left: 56, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (typeof v === "number" ? num(v, d) : String(v)) },
    xAxis: { type: "time", axisLabel: { color: colors.muted, hideOverlap: true, formatter: (v: number) => istTime(new Date(v).toISOString()) }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: (v: number) => num(v, d) }, splitLine: { lineStyle: { color: colors.rule, opacity: 0.5 } } },
    series: [{ name: item.name, type: "line", showSymbol: false, data: s.times.map((t, i) => [t, s.prices[i]]), lineStyle: { width: 2, color: colors.brass }, itemStyle: { color: colors.brass } }],
  };
  return <EChart option={option} ariaLabel={`${item.name}, last 24 hours of one-minute prices (times in IST)`} className="h-[280px] w-full" />;
}

/** US futures, cash indices, rates, commodities and Asia on one board, with each quote's own age and status. */
export function GlobalBody() {
  const q = useQuery({ queryKey: ["globalOverview"], queryFn: api.globalOverview, refetchInterval: 30_000, retry: false });
  const [pick, setPick] = useState("ES");
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The global board" e={q.error} />;
  const o = q.data;
  const all = o.groups.flatMap((g) => g.items);
  const sel = all.find((i) => i.key === pick && i.price != null) ?? all.find((i) => i.price != null);
  const nothing = !all.some((i) => i.price != null);
  return (
    <div className="flex flex-col gap-3">
      {(o.meta.stale || o.meta.last_error) && (
        <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">
          {o.meta.last_poll_ok ? `The last successful update was ${fmtAge(o.meta.last_poll_age_s)}.` : "No successful update yet."} {o.meta.last_error ? `Last error: ${o.meta.last_error}.` : ""} Prices below keep their own age.
        </p>
      )}
      {nothing && <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted">No global prices have been stored yet. The server fetches them every minute during Indian market hours and every five minutes otherwise.</p>}
      {o.groups.map((g) => (
        <section key={g.key} aria-label={g.title}>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</h2>
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-4">
            {g.items.map((it) => <Card key={it.key} it={it} selected={sel?.key === it.key} onPick={() => setPick(it.key)} />)}
          </div>
        </section>
      ))}
      {sel && (
        <section aria-label="Chart" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-2">
          <h2 className="px-1 text-sm font-semibold">{sel.name} · last 24 hours <span className="font-normal text-muted">(one-minute prices, times in IST)</span></h2>
          <SeriesChart item={sel} />
        </section>
      )}
      <p className="text-xs text-muted">
        {o.meta.source}. Change is computed here from the stored previous close: US index futures from the 16:00 New York cash close, the others from the previous session's last price. A future that has rolled to a new contract can show a one-off jump. GIFT Nifty is not on this board: no source for it is connected yet.
      </p>
    </div>
  );
}

function countdown(min: number): string {
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return h < 24 ? `in ${h} h ${m} min` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

function EventRow({ e, now }: { e: CalEvent; now: number }) {
  const mins = Math.round((new Date(e.time_ist).getTime() - now) / 60000);
  const state = e.state === "upcoming" && mins < 0 ? "past" : e.state;
  const has = e.actual || e.forecast || e.previous;
  return (
    <li className={`grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 border-t border-rule px-3 py-2.5 first:border-t-0 ${state === "upcoming" ? "" : "opacity-75"}`}>
      <div className="text-sm tabular-nums">
        <div className="font-semibold">{e.all_day ? "All day" : istTime(e.time_ist)}</div>
        <div className="text-[11px] text-muted">{e.all_day ? "" : "IST"}</div>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-brass" aria-label="High impact" title="High impact">★★★</span>
          <span className="text-sm font-semibold">{e.name}</span>
          <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-muted">{e.country || "Global"}</span>
          {state === "upcoming" && <span className="text-xs text-info">{countdown(Math.max(0, mins))}</span>}
          {state === "released" && <span className="text-xs text-up">Released</span>}
          {state === "past" && <span className="text-xs text-muted">Time passed, no actual value in the feed</span>}
        </div>
        {has && (
          <dl className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
            {e.actual && <div><dt className="inline">Actual </dt><dd className="inline font-semibold text-paper">{e.actual}</dd></div>}
            {e.forecast && <div><dt className="inline">Forecast </dt><dd className="inline text-paper">{e.forecast}</dd></div>}
            {e.previous && <div><dt className="inline">Previous </dt><dd className="inline text-paper">{e.previous}</dd></div>}
          </dl>
        )}
        {e.note && <p className="mt-0.5 text-[11px] text-muted">{e.note}</p>}
      </div>
    </li>
  );
}

/** High-impact events grouped by when, with no filters: the page only ever shows the three-star level. */
export function CalendarBody() {
  const q = useQuery({ queryKey: ["calendar"], queryFn: api.calendar, refetchInterval: 60_000, retry: false });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The calendar" e={q.error} />;
  const c = q.data;
  const total = c.sections.reduce((n, s) => n + s.events.length, 0);
  const nx = c.next;
  return (
    <div className="flex flex-col gap-3">
      {nx && (
        <section aria-label="Next event" className="rounded-[var(--radius-panel)] border border-brass bg-brass/10 p-3">
          <div className="text-xs uppercase tracking-wide text-muted">Next high-impact event</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-semibold">{nx.name}</span>
            <span className="text-sm text-muted">{nx.country || "Global"} · {istDay(nx.time_ist)}{nx.all_day ? "" : `, ${istTime(nx.time_ist)} IST`}</span>
            <span className="text-sm font-semibold text-info">{countdown(Math.max(0, Math.round((new Date(nx.time_ist).getTime() - now) / 60000)))}</span>
          </div>
        </section>
      )}
      {total === 0 && <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted">No high-impact events are stored for this month yet.</p>}
      {c.sections.map((s) => (
        <section key={s.key} aria-label={s.title} className="overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
          <h2 className="flex items-center justify-between border-b border-rule bg-slate-2 px-3 py-2 text-sm font-semibold">{s.title}<span className="text-xs font-normal text-muted">{s.events.length} {s.events.length === 1 ? "event" : "events"}</span></h2>
          {s.events.length === 0 ? <p className="px-3 py-3 text-sm text-muted">Nothing high-impact scheduled.</p> : (
            <>
              {s.events.map((e, i) => {
                const day = istDay(e.time_ist);
                const first = i === 0 || istDay(s.events[i - 1]!.time_ist) !== day;
                return (
                  <div key={e.id}>
                    {first && s.key !== "today" && s.key !== "tomorrow" && <div className="border-t border-rule bg-slate-2/50 px-3 py-1 text-xs font-semibold text-muted first:border-t-0">{day}</div>}
                    <ul><EventRow e={e} now={now} /></ul>
                  </div>
                );
              })}
            </>
          )}
        </section>
      ))}
      <p className="text-xs text-muted">
        {c.note} Sources: {c.sources.map((s) => `${s.name}${s.last_ok ? ` (checked ${fmtAge((now - new Date(s.last_ok).getTime()) / 1000)})` : s.last_error ? " (could not be read)" : " (not read yet)"}`).join("; ")}.
        Actual values appear only if the feed carries them. Moneycontrol is not used: it does not allow automated reading.
      </p>
    </div>
  );
}

const SEEN_KEY = "newsSeenAt";

function NewsList({ title, items, since }: { title: string; items: NewsItem[]; since: number | null }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <h2 className="border-b border-rule bg-slate-2 px-3 py-2 text-sm font-semibold">{title}</h2>
      {items.length === 0 ? <p className="p-3 text-sm text-muted">No headlines stored yet.</p> : (
        <ul>
          {items.map((n) => (
            <li key={n.id} className="border-t border-rule px-3 py-2.5 first:border-t-0">
              <a href={n.link} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold hover:text-brass hover:underline">
                {since != null && new Date(n.fetched).getTime() > since && <span className="mr-1.5 rounded-sm bg-brass px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase text-slate">New</span>}
                {n.title}
              </a>
              {n.summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.summary}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="rounded-full border border-rule px-2 py-0.5">{n.source}</span>
                <span>{n.section}</span><span>· {fmtAge(n.age_min * 60)}</span>
                {n.topics.map((t) => <span key={t} className="rounded-full bg-brass/15 px-2 py-0.5 text-brass">{t}</span>)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Indian and global headlines from the publishers' public RSS feeds: headline, a short summary and a link, nothing more. */
export function NewsBody() {
  const q = useQuery({ queryKey: ["news"], queryFn: api.news, refetchInterval: 60_000, retry: false });
  // "New" = stored after the page was last opened (kept in this browser), so items that arrive while it is open are marked too; null on a first visit
  const since = useRef<number | null>((() => { const v = Number(localStorage.getItem(SEEN_KEY)); return v > 0 ? v : null; })());
  useEffect(() => {
    const save = () => localStorage.setItem(SEEN_KEY, String(Date.now()));
    const hide = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("visibilitychange", hide); save(); };
  }, []);
  const [moving, setMoving] = useState(false);
  const age = useMemo(() => (q.data?.meta.last_poll_ok ? (Date.now() - new Date(q.data.meta.last_poll_ok).getTime()) / 1000 : null), [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The news" e={q.error} />;
  const n = q.data;
  const keep = (l: NewsItem[]) => (moving ? l.filter((i) => i.topics.length > 0) : l);
  const fresh = [...n.india, ...n.global].filter((i) => since.current != null && new Date(i.fetched).getTime() > since.current).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" role="status">{since.current == null ? "First visit: nothing is marked new yet." : fresh > 0 ? `${fresh} new since you last looked` : "Nothing new since you last looked"}</p>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} className="accent-[var(--brass)]" /> Market-moving topics only</label>
      </div>
      {n.meta.stale && <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">{age == null ? "No headlines have been fetched yet." : `The feeds were last read ${fmtAge(age)}.`} Headlines below may be out of date.</p>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <NewsList title="India" items={keep(n.india)} since={since.current} />
        <NewsList title="Global" items={keep(n.global)} since={since.current} />
      </div>
      <p className="text-xs text-muted">{n.meta.note} Sources: {n.meta.sources.join(", ")}. Moneycontrol is not included: it blocks automated reading.</p>
    </div>
  );
}
