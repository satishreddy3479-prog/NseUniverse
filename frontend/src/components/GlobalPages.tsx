import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CalEvent, type GlobalItem, type NewsItem } from "../lib/api";
import { fmtAge, MISSING } from "../lib/format";
import { EChart, useChartColors } from "./EChart";
import { QuickLinks } from "./ToolMenu";
import { Loading } from "./Loading";

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
function StatusChip({ status, delay }: { status: string; delay?: number }) {
  const base = STATUS[status] ?? { label: status, dot: "bg-down" };
  const s = status === "live" && delay && delay < 60 ? { ...base, label: `Live · ${delay} min delay` } : base; // the source feed is behind real time by about this much
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

function Card({ it, onOpen }: { it: GlobalItem; onOpen: () => void }) {
  const has = it.price != null;
  const d = it.decimals;
  const up = (it.change ?? 0) >= 0;
  return (
    <div className="flex flex-col rounded-[var(--radius-panel)] border border-rule bg-slate transition-colors hover:border-muted">
      <button type="button" onClick={onOpen} disabled={!has} aria-label={`Open chart of ${it.name}`} className="flex flex-col gap-1 p-3 pb-2 text-left disabled:opacity-60">
        <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{it.name}</span><StatusChip status={it.status} delay={it.delay_min} /></span>
        <span className="text-xl font-semibold tabular-nums">{has ? `${num(it.price as number, d)}${it.yield ? "%" : ""}` : MISSING}</span>
        <span className={`text-sm tabular-nums ${tone(it.change)}`}>
          {it.change == null ? "No reference close" : it.yield && it.bp != null ? `${signed(it.bp, 1)} bp` : `${signed(it.change, d)} (${signed(it.change_pct ?? 0, 2)}%)`}
        </span>
        {has && it.spark ? <Spark values={it.spark} up={up} /> : null}
        <span className="text-[11px] text-muted">{has ? `${it.status === "live" ? "Updated" : "Last price"} ${fmtAge(it.age_s)}` : "No price stored yet"}</span>
        {it.note && <span className="text-[11px] text-muted">{it.note}</span>}
      </button>
      <div className="mx-3 mb-3 flex gap-2">
        <button type="button" onClick={onOpen} disabled={!has} className="inline-flex min-h-9 flex-1 items-center justify-center rounded-sm border border-brass bg-brass/10 px-3 text-sm text-paper hover:bg-brass/20 disabled:opacity-50">View chart</button>
        {it.chart_url && (
          <a href={it.chart_url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${it.name} at its source`}
            className="inline-flex min-h-9 items-center justify-center rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper hover:border-brass hover:text-brass">Source ↗</a>
        )}
      </div>
    </div>
  );
}

const RANGES = [{ h: 24, label: "1D" }, { h: 72, label: "3D" }, { h: 168, label: "7D" }] as const;
const GAP_MS = 90 * 60_000; // a longer silence between two prices is a closed market: the line breaks there instead of joining them

function SeriesChart({ item, hours }: { item: GlobalItem; hours: number }) {
  const colors = useChartColors();
  const q = useQuery({ queryKey: ["globalSeries", item.key, hours], queryFn: () => api.globalSeries(item.key, hours), refetchInterval: 60_000, retry: false });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The chart" e={q.error} />;
  const s = q.data;
  if (s.prices.length < 2) return <p className="p-4 text-sm text-muted">Not enough stored one-minute prices yet to draw {item.name}.</p>;
  const d = item.decimals;
  const data: [number, number | null][] = [];
  s.times.forEach((t, i) => {
    const ms = new Date(t).getTime();
    const prev = data.length ? data[data.length - 1]![0] : null;
    if (prev != null && ms - prev > GAP_MS) data.push([prev + 60_000, null]);
    data.push([ms, s.prices[i]!]);
  });
  const multiDay = hours > 24;
  const stamp = (v: number) => new Intl.DateTimeFormat("en-IN", { ...(multiDay ? { day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(v));
  const ref = s.prev_close;
  const option = {
    animation: false, grid: { left: 60, right: 14, top: 16, bottom: 28 },
    tooltip: { trigger: "axis", formatter: (p: { value: [number, number | null] }[]) => { const v = p[0]?.value; return v && v[1] != null ? `${stamp(v[0])} IST<br/><b>${num(v[1], d)}</b>` : ""; } },
    xAxis: { type: "time", axisLabel: { color: colors.muted, hideOverlap: true, formatter: (v: number) => stamp(v) }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: (v: number) => num(v, d) }, splitLine: { lineStyle: { color: colors.rule, opacity: 0.5 } } },
    series: [{
      name: item.name, type: "line", showSymbol: false, connectNulls: false, data, lineStyle: { width: 2, color: colors.brass }, itemStyle: { color: colors.brass },
      markLine: ref != null ? { silent: true, symbol: "none", lineStyle: { color: colors.muted, type: "dashed" }, label: { color: colors.muted, formatter: `Prev close ${num(ref, d)}`, position: "insideEndTop" }, data: [{ yAxis: ref }] } : undefined,
    }],
  };
  return <EChart option={option} ariaLabel={`${item.name}, last ${hours / 24} day${hours > 24 ? "s" : ""} of one-minute prices (times in IST)`} className="h-[min(60vh,420px)] w-full" />;
}

/** The chart of one symbol over the stored prices, full screen on a phone: 1, 3 or 7 days, the previous close as a dashed line, and a link to the symbol at its source. */
function ChartSheet({ item, onClose }: { item: GlobalItem; onClose: () => void }) {
  const [hours, setHours] = useState<number>(24);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${item.name} chart`} onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full flex-col gap-2 overflow-y-auto rounded-t-[var(--radius-panel)] border border-rule bg-slate p-3 sm:max-w-[900px] sm:rounded-[var(--radius-panel)]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{item.name}</h2>
            <p className="text-sm tabular-nums">
              {item.price != null ? `${num(item.price, item.decimals)}${item.yield ? "%" : ""}` : MISSING}
              {item.change != null && <span className={`ml-2 ${tone(item.change)}`}>{item.yield && item.bp != null ? `${signed(item.bp, 1)} bp` : `${signed(item.change, item.decimals)} (${signed(item.change_pct ?? 0, 2)}%)`}</span>}
              <span className="ml-2"><StatusChip status={item.status} delay={item.delay_min} /></span>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close chart" className="min-h-9 min-w-9 rounded-sm border border-rule bg-slate-2 px-2 text-lg leading-none hover:border-brass">×</button>
        </div>
        <div role="group" aria-label="Range" className="flex flex-wrap items-center gap-2">
          {RANGES.map((r) => (
            <button key={r.h} type="button" aria-pressed={hours === r.h} onClick={() => setHours(r.h)}
              className={`min-h-9 rounded-sm border px-3 text-sm ${hours === r.h ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{r.label}</button>
          ))}
          {item.chart_url && <a href={item.chart_url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex min-h-9 items-center rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper hover:border-brass hover:text-brass">Open at source ↗</a>}
        </div>
        <SeriesChart item={item} hours={hours} />
        <p className="text-[11px] text-muted">One-minute prices stored by this app, times in IST. A gap in the line is a closed market. The dashed line is the previous close the change is measured from.</p>
      </div>
    </div>
  );
}

/** US futures, cash indices, rates, commodities and Asia on one board, with each quote's own age and status. */
export function GlobalBody() {
  const q = useQuery({ queryKey: ["globalOverview"], queryFn: api.globalOverview, refetchInterval: 30_000, retry: false });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The global board" e={q.error} />;
  const o = q.data;
  const all = o.groups.flatMap((g) => g.items);
  const sel = all.find((i) => i.key === open && i.price != null) ?? null;
  const nothing = !all.some((i) => i.price != null);
  return (
    <div className="flex flex-col gap-3">
      {(o.meta.stale || o.meta.last_error) && (
        <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">
          {o.meta.last_poll_ok ? `The last successful update was ${fmtAge(o.meta.last_poll_age_s)}.` : "No successful update yet."} {o.meta.last_error ? `Last error: ${o.meta.last_error}.` : ""} Prices below keep their own age.
        </p>
      )}
      {nothing && <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted">No global prices have been stored yet. The server fetches them every minute during Indian market hours and the US session, and every five minutes otherwise.</p>}
      {o.groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.key} aria-label={g.title}>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</h2>
          {g.key === "india_adr" && <p className="mb-1.5 text-xs text-muted" data-testid="adr-note">US-listed Indian companies, in dollars, against the previous US close. They trade 20:00 to 02:30 IST (winter), so in the morning they show how Indian stocks were priced overnight. An ADR is not the NSE price: its ratio to the share and the rupee move it too.</p>}
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-4">
            {g.items.map((it) => <Card key={it.key} it={it} onOpen={() => setOpen(it.key)} />)}
          </div>
        </section>
      ))}
      {sel && <ChartSheet item={sel} onClose={() => setOpen(null)} />}
      <p className="text-xs text-muted">
        {o.meta.source}. A closed cash index shows its official close; a market that trades shows the latest one-minute price. Change is computed here from the stored previous close: US index futures from the 16:00 New York cash close, the others from the previous session. A future that has rolled to a new contract can show a one-off jump. GIFT Nifty is the near-month NIFTY future at NSE IX.
      </p>
    </div>
  );
}

function countdown(min: number): string {
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return h < 24 ? `in ${h} h ${m} min` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

const readingNumber = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v.replace(/[%,KMBT]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** Where the actual came out against the forecast (a plain comparison of the two numbers, not a judgement of good or bad). */
function verdict(actual: string | null, forecast: string | null): string | null {
  const a = readingNumber(actual), f = readingNumber(forecast);
  if (a == null || f == null) return null;
  return a > f ? "above forecast" : a < f ? "below forecast" : "in line with forecast";
}
function Reading({ label, value, pending, verdict: v, tone }: { label: string; value: string | null; pending?: boolean; verdict?: string | null; tone?: "up" | "down" | "flat" }) {
  return (
    <div className="rounded-sm bg-slate-2 px-2 py-1">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`tabular-nums ${value ? `font-semibold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-paper"}` : "text-muted"}`} title={value ? undefined : pending ? "Not released yet" : "Not published by the source"}>{value ?? (pending ? "Pending" : MISSING)}</dd>
      {v && <dd className="text-[11px] text-muted">{v}</dd>}
    </div>
  );
}

/** Releases that are a statement or a speech: they never carry an actual figure, so a missing one is not a gap in the feed. */
const TEXT_RELEASE = /minutes|speech|speaks|testifies|press conference|meeting|statement/i;
function EventRow({ e, now }: { e: CalEvent; now: number }) {
  const mins = Math.round((new Date(e.time_ist).getTime() - now) / 60000);
  const state = e.state === "upcoming" && mins < 0 ? "past" : e.state;
  return (
    <li className={`grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 border-t border-rule px-3 py-2.5 first:border-t-0 ${state === "upcoming" ? "" : "opacity-75"}`}>
      <div className="text-sm tabular-nums">
        <div className="font-semibold">{e.all_day ? "All day" : istTime(e.time_ist)}</div>
        <div className="text-[11px] text-muted">{e.all_day ? "" : "IST"}</div>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-brass" aria-label={e.impact === "high" ? "High impact" : "Medium impact"} title={e.impact === "high" ? "High impact" : "Medium impact (India)"}>{e.impact === "high" ? "★★★" : "★★☆"}</span>
          <span className="text-sm font-semibold">{e.name}</span>
          <span className="rounded-full border border-rule px-2 py-0.5 text-[11px] text-muted">{e.country || "Global"}</span>
          {state === "upcoming" && <span className="text-xs text-info">{countdown(Math.max(0, mins))}</span>}
          {state === "released" && e.outcome && <span data-testid="outcome-badge" className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${e.outcome.tone === "up" ? "border-up/60 bg-up/10 text-up" : e.outcome.tone === "down" ? "border-down/60 bg-down/10 text-down" : "border-warn/60 bg-warn/10 text-warn"}`} title="The actual against the forecast: a plain comparison of the two numbers, not what it does to the market">{e.outcome.label}{e.outcome.status !== "INLINE" ? ` ${e.outcome.diff_text}` : ""}</span>}
          {state === "released" && !e.outcome && <span className="text-xs text-up">Reported</span>}
          {state === "past" && <span className="text-xs text-muted">{TEXT_RELEASE.test(e.name) ? "Time passed: a statement, not a figure" : "Time passed, no actual value in the feed"}</span>}
        </div>
        <dl className="mt-1.5 grid max-w-[460px] grid-cols-3 gap-2 text-sm" aria-label="Readings">
          <Reading label="Previous" value={e.previous} />
          <Reading label="Forecast" value={e.forecast} />
          <Reading label="Actual" value={e.actual} pending={state === "upcoming"} verdict={verdict(e.actual, e.forecast)} tone={e.outcome?.tone} />
        </dl>
        {e.note && <p className="mt-0.5 text-[11px] text-muted">{e.note}</p>}
      </div>
    </li>
  );
}

/** High-impact events grouped by when, with no filters: the page only ever shows the three-star level. */
export function CalendarBody() {
  const q = useQuery({ queryKey: ["calendar"], queryFn: api.calendar, refetchInterval: 60_000, retry: false });
  const [who, setWho] = useState<"all" | "India" | "US">("all");
  const [view, setView] = useState<"all" | "reported" | "upcoming">("all");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The calendar" e={q.error} />;
  const c = q.data;
  const shownByView = (e: CalEvent) => view === "all" || (view === "reported" ? e.state === "released" : e.state === "upcoming");
  const sections = c.sections.map((s) => ({ ...s, events: s.events.filter((e) => (who === "all" || e.country === who) && shownByView(e)) }));
  const total = sections.reduce((n, s) => n + s.events.length, 0);
  const nx = sections.flatMap((s) => s.events).find((e) => e.state === "upcoming" && new Date(e.time_ist).getTime() >= now - 60_000) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <QuickLinks />
      <div role="group" aria-label="Which events" className="flex flex-wrap items-center gap-2">
        {([["all", "All events"], ["reported", "Reported outcomes"], ["upcoming", "Upcoming"]] as const).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
            className={`min-h-9 rounded-sm border px-3 text-sm ${view === v ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{label}</button>
        ))}
      </div>
      <div role="group" aria-label="Country" className="flex flex-wrap items-center gap-2">
        {([["all", "All"], ["India", "India"], ["US", "US"]] as const).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={who === v} onClick={() => setWho(v)}
            className={`min-h-9 rounded-sm border px-3 text-sm ${who === v ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{label}</button>
        ))}
      </div>
      {nx && (
        <section aria-label="Next event" className="rounded-[var(--radius-panel)] border border-brass bg-brass/10 p-3">
          <div className="text-xs uppercase tracking-wide text-muted">Next event{who === "all" ? "" : ` · ${who}`}</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-semibold">{nx.name}</span>
            <span className="text-sm text-muted">{nx.country || "Global"} · {istDay(nx.time_ist)}{nx.all_day ? "" : `, ${istTime(nx.time_ist)} IST`}</span>
            <span className="text-sm font-semibold text-info">{countdown(Math.max(0, Math.round((new Date(nx.time_ist).getTime() - now) / 60000)))}</span>
          </div>
        </section>
      )}
      {total === 0 && <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted">{who === "all" ? "No events are stored yet." : `No ${who} events are stored in the coming weeks.`}</p>}
      {sections.map((s) => (
        <section key={s.key} aria-label={s.title} className="overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
          <h2 className="flex items-center justify-between border-b border-rule bg-slate-2 px-3 py-2 text-sm font-semibold">{s.title}<span className="text-xs font-normal text-muted">{s.events.length} {s.events.length === 1 ? "event" : "events"}</span></h2>
          {s.events.length === 0 ? <p className="px-3 py-3 text-sm text-muted">{view === "all" ? "Nothing scheduled." : view === "reported" ? "No reported outcome here." : "Nothing upcoming here."}</p> : (
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
const READ_KEY = "nse-universe.news-read";
const READ_KEEP_MS = 7 * 24 * 3_600_000; // the server keeps headlines 48 hours; a read mark is remembered longer than that and then dropped

/** Headlines marked read in this browser: {headline id: when}. Entries older than a week are dropped. */
function loadRead(now = Date.now()): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === "number" && now - at < READ_KEEP_MS));
  } catch {
    return {};
  }
}

interface ReadApi { read: Record<string, number>; mark: (ids: string[]) => void; unmark: (id: string) => void }

function NewsList({ title, items, since, reads, empty }: { title: string; items: NewsItem[]; since: number | null; reads: ReadApi; empty: string }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <h2 className="border-b border-rule bg-slate-2 px-3 py-2 text-sm font-semibold">{title}</h2>
      {items.length === 0 ? <p className="p-3 text-sm text-muted">{empty}</p> : (
        <ul>
          {items.map((n) => {
            const isRead = reads.read[n.id] != null;
            return (
            <li key={n.id} data-read={isRead ? "true" : "false"} className={`border-t border-rule px-3 py-2.5 first:border-t-0 ${isRead ? "opacity-60" : ""}`}>
              {/* opening the headline (click, middle click or Enter) marks it read */}
              <a href={n.link} target="_blank" rel="noopener noreferrer" onClick={() => reads.mark([n.id])} onAuxClick={() => reads.mark([n.id])}
                className={`text-sm hover:text-brass hover:underline ${isRead ? "font-normal" : "font-semibold"}`}>
                {!isRead && since != null && new Date(n.fetched).getTime() > since && <span className="mr-1.5 rounded-sm bg-brass px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase text-slate">New</span>}
                {n.title}
              </a>
              {n.summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.summary}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="rounded-full border border-rule px-2 py-0.5">{n.source}</span>
                <span>{n.section}</span><span>· {fmtAge(n.age_min * 60)}</span>
                {n.topics.map((t) => <span key={t} className="rounded-full bg-brass/15 px-2 py-0.5 text-brass">{t}</span>)}
                <button type="button" onClick={() => (isRead ? reads.unmark(n.id) : reads.mark([n.id]))} aria-pressed={isRead} aria-label={`${isRead ? "Mark as unread" : "Mark as read"}: ${n.title}`}
                  className="ml-auto min-h-7 rounded-sm border border-rule px-2 text-[11px] text-muted hover:border-brass hover:text-paper">{isRead ? "Mark unread" : "Mark read"}</button>
              </div>
            </li>
            );
          })}
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
  const [hideRead, setHideRead] = useState(false);
  const [read, setRead] = useState<Record<string, number>>(() => loadRead());
  const save = (next: Record<string, number>) => { try { localStorage.setItem(READ_KEY, JSON.stringify(next)); } catch { /* storage unavailable: kept for this visit only */ } return next; };
  const reads: ReadApi = {
    read,
    mark: (ids) => setRead((cur) => { const at = Date.now(); const next = { ...loadRead(), ...cur }; let changed = false; for (const id of ids) if (next[id] == null) { next[id] = at; changed = true; } return changed ? save(next) : cur; }),
    unmark: (id) => setRead((cur) => { const next = { ...loadRead(), ...cur }; delete next[id]; return save(next); }),
  };
  const age = useMemo(() => (q.data?.meta.last_poll_ok ? (Date.now() - new Date(q.data.meta.last_poll_ok).getTime()) / 1000 : null), [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The news" e={q.error} />;
  const n = q.data;
  const keep = (l: NewsItem[]) => l.filter((i) => (!moving || i.topics.length > 0) && (!hideRead || read[i.id] == null));
  const all = [...n.india, ...n.global];
  const unread = all.filter((i) => read[i.id] == null);
  const fresh = unread.filter((i) => since.current != null && new Date(i.fetched).getTime() > since.current).length;
  return (
    <div className="flex flex-col gap-3">
      <QuickLinks />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" role="status">{since.current == null ? "First visit: nothing is marked new yet." : fresh > 0 ? `${fresh} new since you last looked` : "Nothing new since you last looked"} · {unread.length} unread of {all.length}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} className="accent-[var(--brass)]" /> Market-moving topics only</label>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={hideRead} onChange={(e) => setHideRead(e.target.checked)} className="accent-[var(--brass)]" /> Hide read</label>
          <button type="button" disabled={unread.length === 0} onClick={() => reads.mark(unread.map((i) => i.id))}
            className="min-h-9 rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper hover:border-brass disabled:opacity-40">Mark all as read</button>
        </div>
      </div>
      {n.meta.stale && <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">{age == null ? "No headlines have been fetched yet." : `The feeds were last read ${fmtAge(age)}.`} Headlines below may be out of date.</p>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <NewsList title="India" items={keep(n.india)} since={since.current} reads={reads} empty={n.india.length ? "Nothing to show with these filters." : "No headlines stored yet."} />
        <NewsList title="Global" items={keep(n.global)} since={since.current} reads={reads} empty={n.global.length ? "Nothing to show with these filters." : "No headlines stored yet."} />
      </div>
      <p className="text-xs text-muted">{n.meta.note} Sources: {n.meta.sources.join(", ")}. Moneycontrol is not included: it blocks automated reading.</p>
    </div>
  );
}
