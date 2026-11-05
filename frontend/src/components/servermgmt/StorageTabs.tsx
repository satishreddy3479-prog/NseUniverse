import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { serverApi, type CompareResult, type HistoryRow, type Overview } from "../../lib/serverApi";
import { MISSING } from "../../lib/format";
import { EChart, useChartColors } from "../EChart";
import { Async, Badge, Bar, Card, Stat, Table, ago, btn, bytes, count, dur, field, num, pct, ratio, signedBytes, useServerQuery, when } from "./common";

// ------------------------------------------------------------------ Overview
export function OverviewTab({ o, onJump }: { o: Overview; onJump: (tab: string) => void }) {
  const s = o.sample;
  const qc = useQueryClient();
  const diskPct = ratio(s?.disk_used, s?.disk_total);
  const ramUsed = s && s.mem_total != null && s.mem_avail != null ? s.mem_total - s.mem_avail : null;
  const ramPct = ratio(ramUsed, s?.mem_total);
  const swapPct = ratio(s?.swap_used, s?.swap_total);
  const th = o.thresholds;
  const parts = o.latest_parts;
  const g = o.growth;
  const fc = useServerQuery(["forecast"], serverApi.forecast, 300_000);
  return (
    <div className="flex flex-col gap-3" data-testid="sm-overview">
      <Card title="Collection status" actions={<button type="button" className={btn()} onClick={() => void qc.invalidateQueries({ queryKey: ["server"] })}>Reload</button>}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span>{s ? <>Live sample <b className="text-paper">{when(s.ts_utc)}</b> ({ago(o.sample_age_s)})</> : "No metric sample has been recorded yet."}</span>
          {o.stale && <Badge kind="warning">stale</Badge>}
          {s && s.status !== "ok" && <Badge kind={s.status === "failed" ? "failed" : "partial"}>{s.status}</Badge>}
          {s?.error && <span className="text-xs text-warn">{s.error}</span>}
          <span>Latest storage snapshot: {o.latest_snapshot ? <><b className="text-paper">{o.latest_snapshot.snapshot_date}</b> <Badge kind={o.latest_snapshot.status}>{o.latest_snapshot.status}</Badge></> : "none yet"}</span>
          {o.scan_running && <Badge kind="info">scan running: {o.scan_running}</Badge>}
          <span>Application health: {o.health ? <Badge kind={o.health.ok ? "ok" : "critical"}>{o.health.status}{o.health.ms != null ? ` ${o.health.ms} ms` : ""}</Badge> : MISSING}</span>
        </div>
        {o.alerts.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="sm-open-alerts">
            {o.alerts.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm"><Badge kind={a.level}>{a.level}</Badge><span className="text-paper">{a.title}</span><span className="text-xs text-muted">{a.detail}</span></li>)}
          </ul>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Disk" note="Filesystem figures include the operating system and everything else on the disk, not only NSE Universe.">
          <Stat label="Used" value={bytes(s?.disk_used)} sub={`${pct(diskPct)} of ${bytes(s?.disk_total)}`} tone={diskPct != null && th.disk_crit_pct != null && diskPct >= th.disk_crit_pct ? "text-down" : undefined} />
          <div className="mt-2"><Bar value={diskPct} warn={th.disk_warn_pct} crit={th.disk_crit_pct} label="Disk used" /></div>
          <div className="mt-2 text-xs text-muted">Available <b className="num text-paper">{bytes(s?.disk_avail)}</b></div>
        </Card>
        <Card title="Memory" note="Used = total minus available memory; file cache the system can give back is not counted as used.">
          <Stat label="In use" value={bytes(ramUsed)} sub={`${pct(ramPct)} of ${bytes(s?.mem_total)}`} />
          <div className="mt-2"><Bar value={ramPct} warn={th.ram_warn_pct} crit={th.ram_crit_pct} label="Memory in use" /></div>
          <div className="mt-2 text-xs text-muted">Available <b className="num text-paper">{bytes(s?.mem_avail)}</b> · Swap {s?.swap_total ? `${bytes(s.swap_used)} of ${bytes(s.swap_total)} (${pct(swapPct)})` : s?.swap_total === 0 ? "none configured" : MISSING}</div>
        </Card>
        <Card title="CPU and load" note="CPU is the change between two samples; the first after a restart has none.">
          <Stat label="CPU use" value={pct(s?.cpu_pct)} sub={`${o.host.logical_cores ?? MISSING} logical cores${o.host.model ? ` · ${o.host.model}` : ""}`} />
          <div className="mt-2"><Bar value={s?.cpu_pct ?? null} warn={th.cpu_warn_pct} label="CPU use" /></div>
          <div className="mt-2 text-xs text-muted">Load {num(s?.load1)} · {num(s?.load5)} · {num(s?.load15)} (1, 5, 15 min)</div>
        </Card>
        <Card title="Host">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Uptime" value={dur(o.host.uptime_s)} />
            <Stat label="Hostname" value={<span className="text-sm">{o.host.hostname ?? MISSING}</span>} />
            <div className="col-span-2 text-muted">{o.host.os ?? MISSING} · kernel {o.host.kernel ?? MISSING}</div>
          </div>
        </Card>
      </div>

      <Card title="NSE Universe storage" actions={<button type="button" className={btn()} onClick={() => onJump("storage")}>Storage analytics</button>}
        note={`Measured by our own scan of three approved areas (project root, data, logs), counted separately so nothing is added twice. History began ${o.history_started ?? "— (no snapshot yet)"}; the scan runs daily at the configured time and on request, never when this page loads.`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" data-testid="sm-storage-cards">
          <Stat label="NSE total" value={bytes(o.latest_snapshot?.nse_bytes)} sub={o.latest_snapshot ? `${o.latest_snapshot.snapshot_date} · ${o.latest_snapshot.status}` : "no snapshot"} />
          <Stat label="Project root" value={bytes(parts.project)} />
          <Stat label="Data" value={bytes(parts.data)} />
          <Stat label="Logs" value={bytes(parts.logs)} />
          <Stat label="Cache dir" value={bytes(parts["project/cache"])} />
          <Stat label="Releases" value={bytes(parts["project/releases"])} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="sm-growth-cards">
          <Stat label="Change vs previous day" value={signedBytes(g?.d_fs_used)} sub={g ? (g.comparable ? `filesystem, ${g.prev_date ?? MISSING} → ${g.snapshot_date}` : "not comparable: previous day missing, partial or different method") : "no snapshot"} />
          <Stat label="NSE change vs previous day" value={signedBytes(g?.d_nse_bytes)} sub="our three areas" />
          <Stat label="Average growth, 7 days" value={fc.data ? signedBytes(fc.data.avg_7d ?? null) : MISSING} sub={fc.data?.avg_7d == null ? "needs more daily snapshots" : "per day, net"} />
          <Stat label="Average growth, 30 days" value={fc.data ? signedBytes(fc.data.avg_30d ?? null) : MISSING} sub={fc.data?.avg_30d == null ? "needs more daily snapshots" : "per day, net"} />
        </div>
        <p className="mt-2 text-xs text-muted">{fc.data ? (fc.data.available ? `At the recent rate the filesystem reaches ${fc.data.threshold_pct}% in about ${fc.data.days_to_threshold} days.` : `Forecast unavailable: ${fc.data.reason}.`) : "Forecast loading…"} Monitoring database: {bytes(o.own_db_bytes)}.</p>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Storage analytics
const RANGES = [{ id: 7, label: "7 days" }, { id: 30, label: "30 days" }, { id: 90, label: "90 days" }, { id: 365, label: "365 days" }, { id: 0, label: "Custom" }] as const;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000));

function fullAxis(rows: HistoryRow[]): string[] {
  if (rows.length === 0) return [];
  const out: string[] = [];
  for (let d = rows[0]!.snapshot_date; d <= rows[rows.length - 1]!.snapshot_date; d = addDays(d, 1)) out.push(d);
  return out;
}
const valueOf = (r: HistoryRow, key: string): number | null => (r.status === "failed" ? null : key === "fs_used" || key === "fs_avail" || key === "nse_bytes" ? r[key] : r.parts[key] ?? null);

export function StorageTab({ o }: { o: Overview }) {
  const c = useChartColors();
  const [range, setRange] = useState<number>(30);
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [series, setSeries] = useState("fs_used");
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState(""), [page, setPage] = useState(1);
  const [pick, setPick] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [cmp, setCmp] = useState<CompareResult | null>(null);
  const [cmpErr, setCmpErr] = useState<string | null>(null);
  const today = o.now_utc.slice(0, 10);
  const df = range === 0 ? from : addDays(today, -range), dt = range === 0 ? to : "";
  const all = useServerQuery(["history-all", df, dt], () => serverApi.history({ date_from: df, date_to: dt, sort: "asc", size: 1000 }), 120_000);
  const tbl = useServerQuery(["history", df, dt, q, sort, page], () => serverApi.history({ date_from: df, date_to: dt, q, sort, page, size: 20 }), 120_000);
  const snap = useQuery({ queryKey: ["server", "snapshot", open], queryFn: () => serverApi.snapshot(open!), enabled: open != null, retry: false });

  const rows = all.data?.rows ?? [];
  const axis = useMemo(() => fullAxis(rows), [rows]);
  const byDate = useMemo(() => new Map(rows.map((r) => [r.snapshot_date, r])), [rows]);
  const keys = useMemo(() => ["fs_used", "fs_avail", "nse_bytes", ...[...new Set(rows.flatMap((r) => Object.keys(r.parts)))].sort()], [rows]);
  const label = (k: string) => ({ fs_used: "Filesystem used", fs_avail: "Filesystem available", nse_bytes: "NSE total (3 areas)" }[k] ?? k);
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } };
  const xAxis = { type: "category", data: axis, axisLabel: { color: c.muted, hideOverlap: true, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: c.rule } } };
  const trend = useMemo(() => ({
    grid: { left: 64, right: 20, top: 24, bottom: 32 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : bytes(v)) }, xAxis,
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: (v: number) => bytes(v, 0) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{ name: label(series), type: "line", showSymbol: axis.length < 60, connectNulls: false, data: axis.map((d) => (byDate.has(d) ? valueOf(byDate.get(d)!, series) : null)), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } }],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [axis, byDate, series, c]);
  const rolling = (n: number) => axis.map((_d, i) => {
    const w = axis.slice(Math.max(0, i - n + 1), i + 1).map((x) => byDate.get(x)?.d_fs_used).filter((v): v is number => v != null);
    return w.length >= Math.min(3, n) ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
  const change = useMemo(() => ({
    grid: { left: 64, right: 20, top: 36, bottom: 32 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : signedBytes(v)) }, xAxis,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    yAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => bytes(v, 0) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      { name: "Daily net change", type: "bar", data: axis.map((d) => { const v = byDate.get(d)?.d_fs_used ?? null; return v == null ? null : { value: v, itemStyle: { color: v >= 0 ? c.down : c.up } }; }) },
      { name: "7-day average", type: "line", showSymbol: false, connectNulls: false, data: rolling(7), lineStyle: { color: c.info, width: 1.6 }, itemStyle: { color: c.info } },
      { name: "30-day average", type: "line", showSymbol: false, connectNulls: false, data: rolling(30), lineStyle: { color: c.brass, width: 1.6, type: "dashed" }, itemStyle: { color: c.brass } },
    ],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [axis, byDate, c]);

  const togglePick = (id: number) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1]!, id] : [...p, id]));
  const doCompare = async () => {
    setCmpErr(null);
    const [a, b] = [...pick].sort((x, y) => x - y);
    try { setCmp(await serverApi.compare(a!, b!)); } catch (e) { setCmp(null); setCmpErr(e instanceof Error ? e.message : "comparison failed"); }
  };
  const forecast = useServerQuery(["forecast"], serverApi.forecast, 300_000);
  const t = tbl.data;
  return (
    <div className="flex flex-col gap-3" data-testid="sm-storage">
      <Card title="Range" actions={<a className={btn()} href="/api/server/storage/history.csv" download>Download CSV</a>} note={all.data?.note}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {RANGES.map((r) => <button key={r.id} type="button" aria-pressed={range === r.id} className={btn(range === r.id)} onClick={() => { setRange(r.id); setPage(1); }}>{r.label}</button>)}
          {range === 0 && <>
            <label>From <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} /></label>
            <label>To <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} className={field} /></label>
          </>}
          <span>Storage is measured once per IST day (plus manual scans), so there is no 24-hour view here; see CPU and RAM for hourly data.</span>
        </div>
        {(all.data?.missing_dates.length ?? 0) > 0 && <p className="mt-2 text-xs text-warn" data-testid="sm-missing-dates">No snapshot on {all.data!.missing_dates.length} date(s): {all.data!.missing_dates.slice(0, 12).join(", ")}{all.data!.missing_dates.length > 12 ? "…" : ""}. They are shown as gaps, not as zero.</p>}
      </Card>

      <Card title="Forecast" note={forecast.data ? `${forecast.data.method}. ${forecast.data.observations} comparable daily observation(s)${forecast.data.since ? ` since ${forecast.data.since}` : ""}.` : undefined}>
        <Async q={forecast} what="Forecast">{(f) => f.available ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="sm-forecast">
            <Stat label={`Days to ${f.threshold_pct}% used`} value={`about ${f.days_to_threshold}`} />
            <Stat label="Average growth, 7 days" value={signedBytes(f.avg_7d ?? null)} sub="per day, net" />
            <Stat label="Average growth, 30 days" value={signedBytes(f.avg_30d ?? null)} sub={f.avg_30d == null ? "not enough days" : "per day, net"} />
            <Stat label="Projected used in 30 days" value={bytes(f.projection?.["30"])} />
            <Stat label="Projected used in 90 days" value={bytes(f.projection?.["90"])} />
          </div>
        ) : <p className="text-sm text-muted" data-testid="sm-forecast-unavailable">Forecast unavailable: {f.reason}.</p>}</Async>
      </Card>

      <Card title="Trend" actions={<select aria-label="Series" value={series} onChange={(e) => setSeries(e.target.value)} className={field}>{keys.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>}
        note="Dates without a usable snapshot are gaps in the line. Sizes are logical file bytes from our own scan; the filesystem lines come from the operating system.">
        <Async q={all} what="Storage history">{() => axis.length === 0 ? <p className="text-sm text-muted">No snapshot in this range.</p> : <div style={{ height: 280 }} data-testid="sm-trend"><EChart option={trend} ariaLabel={`${label(series)} by day`} /></div>}</Async>
      </Card>
      <Card title="Daily net change" note="Net change in filesystem use between consecutive complete snapshots (red = more space used, green = less). It is not the number of bytes written that day. A day with no comparable previous day has no bar.">
        {axis.length === 0 ? <p className="text-sm text-muted">No snapshot in this range.</p> : <div style={{ height: 240 }}><EChart option={change} ariaLabel="Daily net storage change" /></div>}
      </Card>

      <Card title="Daily storage history" actions={
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Search history" placeholder="Search date or status" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className={field} />
          <button type="button" className={btn()} onClick={() => setSort((s) => (s === "asc" ? "desc" : "asc"))}>Date {sort === "asc" ? "oldest first" : "newest first"}</button>
          <button type="button" className={btn()} disabled={pick.length !== 2} onClick={() => void doCompare()}>Compare selected ({pick.length}/2)</button>
        </div>}>
        <Async q={tbl} what="Storage history">{() => (t?.rows.length ?? 0) === 0 ? <p className="text-sm text-muted" data-testid="sm-history-empty">{t?.note}</p> : (
          <>
            <Table testId="sm-history-table" min="64rem" head={["", "Date", "Total disk used", "Available", "Project size", "Data", "Cache", "Releases", "Logs", "Change vs previous day", "Status"]}
              rows={t!.rows.map((r) => [
                <input key="p" type="checkbox" aria-label={`Select ${r.snapshot_date}`} checked={pick.includes(r.id)} onChange={() => togglePick(r.id)} />,
                <button key="d" type="button" className="text-info underline" onClick={() => setOpen(r.id)}>{r.snapshot_date}</button>,
                bytes(r.fs_used), bytes(r.fs_avail), bytes(r.parts.project), bytes(r.parts.data), bytes(r.parts["project/cache"]), bytes(r.parts["project/releases"]), bytes(r.parts.logs),
                <span key="c" className={r.d_fs_used == null ? "text-muted" : r.d_fs_used > 0 ? "text-down" : "text-up"} title={r.comparable ? "" : "previous day missing, partial or a different method"}>{signedBytes(r.d_fs_used)}</span>,
                <Badge key="s" kind={r.status}>{r.status}{r.kind !== "daily" ? ` (${r.kind})` : ""}</Badge>,
              ])} />
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <button type="button" className={btn()} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span>Page {t!.page} of {Math.max(1, Math.ceil(t!.total / t!.size))} · {t!.total} day(s)</span>
              <button type="button" className={btn()} disabled={page * t!.size >= t!.total} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </>
        )}</Async>
      </Card>

      {cmpErr && <p role="alert" className="text-sm text-down">{cmpErr}</p>}
      {cmp && (
        <Card title={`Compare ${cmp.a.snapshot_date} → ${cmp.b.snapshot_date}`} actions={<button type="button" className={btn()} onClick={() => setCmp(null)}>Close</button>} note={cmp.note ?? undefined}>
          <div data-testid="sm-compare">
            <p className="mb-2 text-xs text-muted">Collection status: {cmp.a.snapshot_date} {cmp.a.status}, {cmp.b.snapshot_date} {cmp.b.status}.</p>
            <Table head={["Directory", cmp.a.snapshot_date, cmp.b.snapshot_date, "Change", "Change %"]} rows={cmp.rows.map((r) => [r.name, bytes(r.before), bytes(r.after), signedBytes(r.change), r.change_pct == null ? MISSING : `${r.change_pct > 0 ? "+" : ""}${r.change_pct}%`])} />
            {cmp.files.length > 0 && <>
              <h3 className="mb-1 mt-3 text-xs font-semibold text-paper">Files that changed (largest files tracked)</h3>
              <Table head={["Path", "Before", "After", "Change", "Class", "Protected", "Note"]} rows={cmp.files.slice(0, 25).map((f) => [`${f.area}/${f.path}`, bytes(f.before), bytes(f.after), signedBytes(f.change), f.cls, f.protected ? "yes" : "no", f.note ?? ""])} />
            </>}
          </div>
        </Card>
      )}
      {open != null && (
        <Card title={`Snapshot detail`} actions={<button type="button" className={btn()} onClick={() => setOpen(null)}>Close</button>}>
          <Async q={snap} what="Snapshot">{(d) => (
            <div data-testid="sm-snapshot">
              <p className="mb-2 text-xs text-muted">{d.snapshot.snapshot_date} · {d.snapshot.kind} · {d.snapshot.status} · {count(d.snapshot.files)} files, {count(d.snapshot.dirs)} directories · scan took {num(d.snapshot.duration_s)} s · taken {when(d.snapshot.ts_utc)}{d.snapshot.error ? ` · ${d.snapshot.error}` : ""}</p>
              <Table head={["Area", "Folder", "Size", "On disk", "Files"]} rows={d.dirs.map((x) => [x.area, x.name || "(total)", bytes(x.bytes), bytes(x.alloc), count(x.files)])} />
              <h3 className="mb-1 mt-3 text-xs font-semibold text-paper">Largest files</h3>
              <Table head={["Path", "Size", "Modified", "Class", "Protected"]} rows={d.files.slice(0, 30).map((f) => [`${f.area}/${f.rel_path}`, bytes(f.size), when(f.mtime_utc), f.cls, f.protected ? "yes" : "no"])} />
              <p className="mt-2 text-[11px] text-muted">Method: {d.snapshot.method}. File names and sizes only; no file contents are read or stored. Only the largest files are tracked, so growth of small files appears in the folder totals, not as separate rows.</p>
            </div>
          )}</Async>
        </Card>
      )}
    </div>
  );
}
