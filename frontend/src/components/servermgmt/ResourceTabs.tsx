import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { MISSING } from "../../lib/format";
import { serverApi, type ExplorerEntry, type MetricRow } from "../../lib/serverApi";
import { EChart, useChartColors } from "../EChart";
import { Async, Badge, Card, Stat, Table, ago, btn, bytes, count, dur, field, num, pct, ratio, useServerQuery, when } from "./common";

// ------------------------------------------------------------------ Filesystem explorer
export function ExplorerTab() {
  const [area, setArea] = useState("project");
  const [path, setPath] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "mtime">("size");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const areas = useServerQuery(["explorer-areas"], () => serverApi.explorer(), 300_000);
  const dir = useServerQuery(["explorer", area, path], () => serverApi.explorer(area, path), 120_000);
  const snap = useServerQuery(["latest-files"], async () => {
    const h = await serverApi.history({ sort: "desc", size: 5 });
    const r = h.rows.find((x) => x.status !== "failed");
    return r ? serverApi.snapshot(r.id) : null;
  }, 300_000);
  const crumbs = path.split("/").filter(Boolean);
  const entries = useMemo(() => {
    const e = (dir.data?.entries ?? []).filter((x) => (!q || x.name.toLowerCase().includes(q.toLowerCase())) && (!kind || x.kind === kind));
    const key = { name: (a: ExplorerEntry, b: ExplorerEntry) => a.name.localeCompare(b.name), size: (a: ExplorerEntry, b: ExplorerEntry) => (b.size ?? -1) - (a.size ?? -1), mtime: (a: ExplorerEntry, b: ExplorerEntry) => b.mtime_utc.localeCompare(a.mtime_utc) }[sort];
    return [...e].sort(key);
  }, [dir.data, q, kind, sort]);
  return (
    <div className="flex flex-col gap-3" data-testid="sm-explorer">
      <Card title="Approved areas" note="Only these roots can be browsed: no other part of the server is reachable, links are not followed, and file contents are never shown or edited here.">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(areas.data?.areas ?? []).map((a) => <button key={a.id} type="button" disabled={!a.exists} aria-pressed={area === a.id} className={btn(area === a.id)} onClick={() => { setArea(a.id); setPath(""); }}>{a.label}{a.exists ? "" : " (not found)"}</button>)}
        </div>
      </Card>
      <Card title={`/${area}${path ? `/${path}` : ""}`} actions={
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Filter by name" placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className={field} />
          <select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)} className={field}><option value="">All types</option><option value="dir">Folders</option><option value="file">Files</option><option value="link">Links</option></select>
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={field}><option value="size">Largest first</option><option value="mtime">Newest first</option><option value="name">Name</option></select>
        </div>}>
        <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted">
          <button type="button" className="text-info underline" onClick={() => setPath("")}>{area}</button>
          {crumbs.map((c, i) => <span key={i}> / <button type="button" className="text-info underline" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
        </div>
        <Async q={dir} what="Directory">{(d) => (
          <>
            <Table testId="sm-explorer-table" head={["Name", "Type", "Size", "Files", "Modified", "Class", "Cleanup"]} min="46rem"
              rows={entries.map((e) => [
                e.kind === "dir" ? <button key="n" type="button" className="text-info underline" onClick={() => setPath(e.path)}>{e.name}/</button> : e.name,
                e.kind, <span key="s">{bytes(e.size)}{e.partial ? " (partial)" : ""}</span>, count(e.files), when(e.mtime_utc), e.class,
                e.protected ? <Badge key="p" kind="info">protected</Badge> : <Badge key="p" kind="warning">regenerable</Badge>,
              ])} empty="This folder is empty or nothing matches the filter." />
            {d.truncated && <p className="mt-2 text-xs text-warn">Only the first 500 entries are listed.</p>}
            <p className="mt-2 text-[11px] text-muted">Folder sizes come from a bounded scan (about two seconds); a size marked partial is a lower bound. “Regenerable” items can only be removed by the approved clean-up rules in Maintenance, never from here.</p>
          </>
        )}</Async>
      </Card>
      <Card title="Largest files (latest snapshot)" note="From the most recent stored snapshot, not a live scan.">
        <Async q={snap} what="Largest files">{(s) => !s ? <p className="text-sm text-muted">No snapshot yet.</p> : (
          <Table head={["Path", "Size", "Modified", "Class", "Protected"]} rows={s.files.slice(0, 25).map((f) => [`${f.area}/${f.rel_path}`, bytes(f.size), when(f.mtime_utc), f.cls, f.protected ? "yes" : "no"])} />
        )}</Async>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ CPU and RAM
const HOURS = [{ h: 1, l: "1 hour" }, { h: 6, l: "6 hours" }, { h: 24, l: "24 hours" }, { h: 168, l: "7 days" }, { h: 720, l: "30 days" }] as const;
/** Per-second rate between consecutive samples of a cumulative counter; a reset (reboot) or missing value gives a gap. */
export function rates(rows: MetricRow[], pick: (r: MetricRow) => number | null): (number | null)[] {
  return rows.map((r, i) => {
    if (i === 0) return null;
    const a = pick(rows[i - 1]!), b = pick(r), dt = (Date.parse(r.ts_utc) - Date.parse(rows[i - 1]!.ts_utc)) / 1000;
    return a == null || b == null || dt <= 0 || b < a ? null : (b - a) / dt;
  });
}
export function ResourcesTab() {
  const c = useChartColors();
  const [hours, setHours] = useState<number>(24);
  const m = useServerQuery(["metrics", hours], () => serverApi.metrics(hours), 60_000);
  const top = useServerQuery(["procs-top"], () => serverApi.processes({ sort: "rss", limit: 5 }), 60_000);
  const topCpu = useServerQuery(["procs-top-cpu"], () => serverApi.processes({ sort: "cpu", limit: 5 }), 60_000);
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } };
  const legend = { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 };
  return (
    <div className="flex flex-col gap-3" data-testid="sm-resources">
      <Card title="History" actions={<div className="flex flex-wrap gap-1">{HOURS.map((x) => <button key={x.h} type="button" aria-pressed={hours === x.h} className={btn(hours === x.h)} onClick={() => setHours(x.h)}>{x.l}</button>)}</div>} note={m.data?.note}>
        <Async q={m} what="Resource history">{(d) => {
          const rows = d.rows;
          if (rows.length < 2) return <p className="text-sm text-muted" data-testid="sm-resources-empty">Not enough samples in this period yet ({rows.length}). One is recorded every few minutes while the application runs.</p>;
          const x = { type: "category", data: rows.map((r) => r.ts_utc), axisLabel: { color: c.muted, hideOverlap: true, formatter: (v: string) => new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short", hour12: false }) }, axisLine: { lineStyle: { color: c.rule } } };
          const memPct = rows.map((r) => ratio(r.mem_total != null && r.mem_avail != null ? r.mem_total - r.mem_avail : null, r.mem_total));
          const cpuOpt = { grid: { left: 46, right: 16, top: 34, bottom: 28 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(1)}%`) }, legend, xAxis: x, yAxis: { type: "value", min: 0, max: 100, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
            series: [{ name: "CPU use", type: "line", showSymbol: false, connectNulls: false, data: rows.map((r) => r.cpu_pct), lineStyle: { color: c.brass, width: 1.6 }, itemStyle: { color: c.brass } }, { name: "Memory in use", type: "line", showSymbol: false, connectNulls: false, data: memPct, lineStyle: { color: c.info, width: 1.6 }, itemStyle: { color: c.info } }] };
          const loadOpt = { grid: { left: 46, right: 16, top: 34, bottom: 28 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : v.toFixed(2)) }, legend, xAxis: x, yAxis: { type: "value", axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
            series: [["Load 1 min", "load1", c.down], ["Load 5 min", "load5", c.brass], ["Load 15 min", "load15", c.info]].map(([n, k, col]) => ({ name: n, type: "line", showSymbol: false, connectNulls: false, data: rows.map((r) => r[k as "load1"]), lineStyle: { color: col, width: 1.4 }, itemStyle: { color: col } })) };
          const ioOpt = { grid: { left: 64, right: 16, top: 34, bottom: 28 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : `${bytes(v)}/s`) }, legend, xAxis: x, yAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => bytes(v, 0) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
            series: [["Network in", rates(rows, (r) => r.net_rx), c.up], ["Network out", rates(rows, (r) => r.net_tx), c.down], ["Disk read", rates(rows, (r) => r.io_read), c.info], ["Disk write", rates(rows, (r) => r.io_write), c.brass]].map(([n, data, col]) => ({ name: n, type: "line", showSymbol: false, connectNulls: false, data, lineStyle: { color: col, width: 1.3 }, itemStyle: { color: col } })) };
          const last = rows[rows.length - 1]!;
          return (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Samples" value={count(d.samples)} sub={d.stride > 1 ? `every ${d.stride}th shown` : "all shown"} /><Stat label="Newest" value={<span className="text-sm">{when(last.ts_utc)}</span>} /><Stat label="Swap" value={last.swap_total ? `${bytes(last.swap_used)} / ${bytes(last.swap_total)}` : last.swap_total === 0 ? "none" : MISSING} /><Stat label="Application memory" value={bytes(last.app_rss)} sub="this backend process" /></div>
              <div style={{ height: 220 }}><EChart option={cpuOpt} ariaLabel="CPU and memory use over time" /></div>
              <div style={{ height: 200 }}><EChart option={loadOpt} ariaLabel="Load average over time" /></div>
              <div style={{ height: 220 }}><EChart option={ioOpt} ariaLabel="Network and disk throughput over time" /></div>
              <p className="text-[11px] text-muted">CPU is the change between consecutive samples; throughput is the change in the kernel's cumulative counters divided by the time between samples. A restart or a missing reading leaves a gap.</p>
            </div>
          );
        }}</Async>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Top processes by memory"><Async q={top} what="Processes">{(d) => !d.available ? <p className="text-sm text-muted">{d.reason}</p> : <Table head={["PID", "Name", "Memory", "% of RAM"]} rows={d.rows.map((p) => [p.pid, p.name, bytes(p.rss), pct(p.mem_pct)])} />}</Async></Card>
        <Card title="Top processes by CPU (average since start)"><Async q={topCpu} what="Processes">{(d) => !d.available ? <p className="text-sm text-muted">{d.reason}</p> : <Table head={["PID", "Name", "CPU % (lifetime)", "CPU time"]} rows={d.rows.map((p) => [p.pid, p.name, pct(p.cpu_pct_lifetime), dur(p.cpu_seconds)])} />}</Async></Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Processes
export function ProcessesTab() {
  const [sort, setSort] = useState("rss");
  const [q, setQ] = useState("");
  const p = useServerQuery(["procs", sort, q], () => serverApi.processes({ sort, q, limit: 100 }), 30_000);
  return (
    <Card title="Processes" actions={<div className="flex gap-2"><input aria-label="Filter processes" placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className={field} /><select aria-label="Sort processes" value={sort} onChange={(e) => setSort(e.target.value)} className={field}><option value="rss">Memory</option><option value="cpu">CPU</option><option value="name">Name</option><option value="pid">PID</option></select></div>}
      note="Read-only. Command lines and environments are never read (they can contain credentials), and there is no way to stop a process from this page.">
      <Async q={p} what="Processes">{(d) => !d.available ? <p className="text-sm text-muted" data-testid="sm-procs-unavailable">{d.reason}</p> : (
        <Table testId="sm-procs" head={["PID", "Name", "State", "Memory", "% of RAM", "CPU % (lifetime)", "Running for"]} min="44rem" rows={d.rows.map((r) => [r.pid, r.name, r.state, bytes(r.rss), pct(r.mem_pct), pct(r.cpu_pct_lifetime), dur(r.runtime_s)])} />
      )}</Async>
    </Card>
  );
}

// ------------------------------------------------------------------ Logs
export function LogsTab() {
  const src = useServerQuery(["log-sources"], serverApi.logSources, 120_000);
  const [source, setSource] = useState("");
  const [level, setLevel] = useState(""), [q, setQ] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const name = source || src.data?.sources.find((s) => !s.rotated)?.name || src.data?.sources[0]?.name || "";
  const logs = useServerQuery(["logs", name, level, q, before], () => serverApi.logs({ source: name, level, q, limit: 200, before }), 30_000);
  const enabled = name !== "";
  return (
    <Card title="Logs" actions={
      <div className="flex flex-wrap gap-2">
        <select aria-label="Log file" value={name} onChange={(e) => { setSource(e.target.value); setBefore(null); }} className={field}>{(src.data?.sources ?? []).map((s) => <option key={s.name} value={s.name}>{s.name} ({bytes(s.bytes)})</option>)}</select>
        <select aria-label="Severity" value={level} onChange={(e) => { setLevel(e.target.value); setBefore(null); }} className={field}><option value="">All levels</option><option value="WARNING">Warning and above</option><option value="ERROR">Error and above</option></select>
        <input aria-label="Search logs" placeholder="Search text" value={q} onChange={(e) => { setQ(e.target.value); setBefore(null); }} className={field} />
      </div>} note="Only files in the application's log directory are listed. Credentials and tokens are masked before they leave the server. The search is a plain text match, never a command. Each request reads a bounded window from the end of the file.">
      {!enabled ? <p className="text-sm text-muted" data-testid="sm-logs-none">{src.isPending ? "Looking for log files…" : "No log files were found in the log directory."}</p> : (
        <Async q={logs} what="Logs">{(d) => (
          <div data-testid="sm-logs">
            <p className="mb-2 text-xs text-muted">{d.rows.length} line(s), newest first, from a file of {bytes(d.file_bytes)}.</p>
            {d.rows.length === 0 ? <p className="text-sm text-muted">No line matches in this window.</p> : (
              <ul className="max-h-[32rem] overflow-auto font-mono text-[11px]">
                {d.rows.map((r, i) => <li key={i} className="flex gap-2 border-t border-rule/40 py-0.5"><span className="shrink-0 text-muted">{r.ts ? when(r.ts).replace(" IST", "") : ""}</span>{r.level && <Badge kind={r.level === "ERROR" || r.level === "CRITICAL" ? "critical" : r.level === "WARNING" ? "warning" : "info"}>{r.level}</Badge>}<span className="break-all text-paper">{r.raw}</span></li>)}
              </ul>
            )}
            {d.next_before != null && <button type="button" className={`${btn()} mt-2`} onClick={() => setBefore(d.next_before)}>Older lines</button>}
            {before != null && <button type="button" className={`${btn()} ml-2 mt-2`} onClick={() => setBefore(null)}>Back to newest</button>}
          </div>
        )}</Async>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Services
export function ServicesTab() {
  const s = useServerQuery(["services"], serverApi.services, 30_000);
  const qc = useQueryClient();
  return (
    <div className="flex flex-col gap-3" data-testid="sm-services">
      <Card title="Services" actions={<button type="button" className={btn()} onClick={() => void qc.invalidateQueries({ queryKey: ["server", "services"] })}>Check now</button>}
        note="Status is read with fixed, read-only commands for an approved list of services. Restarting is a separate, confirmed action in Maintenance, and only nse-universe can ever be restarted.">
        <Async q={s} what="Services">{(d) => (
          <>
            <Table head={["Service", "State", "Since", "Restarts", "Memory", "Restartable"]} min="40rem"
              rows={d.services.map((x) => [x.name, x.available ? <Badge key="a" kind={x.active === "active" ? "ok" : "critical"}>{x.active}{x.sub ? ` / ${x.sub}` : ""}</Badge> : <span key="a" className="text-muted" title={x.reason}>unavailable{x.reason ? `: ${x.reason}` : ""}</span>, x.since ?? MISSING, count(x.restarts), bytes(x.memory_bytes), x.manageable ? "yes, via the helper" : "no"])} />
            <p className="mt-2 text-xs text-muted">Application health: {d.health ? <Badge kind={d.health.ok ? "ok" : "critical"}>{d.health.status}</Badge> : MISSING} {d.health?.ms != null && `${d.health.ms} ms`} · Helper: {d.helper.installed ? <Badge kind={d.helper.stale ? "warning" : "ok"}>{d.helper.stale ? "installed, not seen recently" : "installed"}</Badge> : <span title={d.helper.reason}>not installed (see docs/server-management.md)</span>}</p>
            {d.last_restart && <p className="mt-1 text-xs text-muted" data-testid="sm-last-restart">Last restart result: {JSON.stringify(d.last_restart)}</p>}
          </>
        )}</Async>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Jobs
export function JobsTab() {
  const j = useServerQuery(["jobs"], serverApi.jobs, 60_000);
  return (
    <Card title="Background jobs" note="The monitoring collector's own runs, and the daily-price downloader's last status as the application reports it.">
      <Async q={j} what="Jobs">{(d) => (
        <div className="flex flex-col gap-3" data-testid="sm-jobs">
          <p className="text-xs text-muted">Schedule: system metrics every {Math.round(d.schedule.metrics_every_s / 60)} min; daily storage snapshot at {d.schedule.daily_snapshot_ist} IST.</p>
          <Table head={["Run", "Job", "Started", "Finished", "Status", "Detail"]} min="44rem" empty="No collector run has been recorded yet."
            rows={d.collector_runs.map((r) => [r.id, r.kind, when(r.started_utc), r.finished_utc ? when(r.finished_utc) : MISSING, <Badge key="s" kind={r.status === "running" ? "info" : r.status}>{r.status}</Badge>, r.detail ?? ""])} />
          {d.daily_prices && <details className="text-xs text-muted"><summary className="cursor-pointer text-paper">Daily price downloader status</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(d.daily_prices, null, 1).slice(0, 4000)}</pre></details>}
        </div>
      )}</Async>
    </Card>
  );
}

// ------------------------------------------------------------------ Cache
export function CacheTab() {
  const c = useServerQuery(["cache"], serverApi.cache, 120_000);
  return (
    <Card title="Cache" note={c.data?.note}>
      <Async q={c} what="Cache">{(d) => (
        <Table testId="sm-cache" head={["Location", "Kind", "Files", "Size", "Where", "Cleanable", "Rule"]} min="50rem" empty="No cache location was found."
          rows={d.items.map((i) => [i.name, i.class, count(i.files), bytes(i.bytes), i.where, i.cleanable ? <Badge key="c" kind="warning">preview first</Badge> : <Badge key="c" kind="info">measured only</Badge>, i.rule])} />
      )}</Async>
    </Card>
  );
}

// ------------------------------------------------------------------ Releases
export function ReleasesTab() {
  const r = useServerQuery(["releases"], serverApi.releases, 120_000);
  return (
    <Card title="Releases and deployments" note={r.data?.rollback}>
      <Async q={r} what="Releases">{(d) => !d.available ? <p className="text-sm text-muted" data-testid="sm-releases-none">No releases directory was found on this host (it exists on the production server).</p> : (
        <div className="flex flex-col gap-2" data-testid="sm-releases">
          <p className="text-xs text-muted">Active release: <b className="text-paper">{d.active ?? MISSING}</b> · health {d.health ? <Badge kind={d.health.ok ? "ok" : "critical"}>{d.health.status}</Badge> : MISSING}</p>
          <Table head={["Release", "Created", "Size (last snapshot)", "Status"]} rows={d.releases.map((x) => [x.id, when(x.created_utc), bytes(x.bytes), x.active ? <Badge key="a" kind="ok">active</Badge> : "kept"])} />
          <p className="text-[11px] text-muted">Releases are never changed or deleted from here. “Created” is the folder's modification time, which is the deployment time on this server.</p>
        </div>
      )}</Async>
    </Card>
  );
}

export { num, ago };
