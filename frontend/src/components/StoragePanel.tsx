import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import { Panel } from "./ui";

function size(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

const TONE = { ok: "border-up/50 text-up", watch: "border-warn/50 text-warn", low: "border-warn/70 text-warn", critical: "border-down/60 text-down" } as const;
const CLASS_TONE: Record<string, string> = { core: "text-up", "verified copy": "text-info", backup: "text-info", cache: "text-muted", regenerable: "text-warn" };

/** Where the disk goes, what the after-close job did, and what pruning would do (nothing without approval). */
export function StoragePanel() {
  const q = useQuery({ queryKey: ["storage"], queryFn: api.storageStatus, refetchInterval: 60_000, retry: false });
  const s = q.data;
  return (
    <Panel title="Storage and end-of-day">
      {q.isLoading ? <p className="text-sm text-muted">Measuring…</p>
        : q.isError || !s ? <p role="alert" className="text-sm text-down">Storage status is not available from the backend.</p>
        : (
          <div className="flex flex-col gap-4" data-testid="storage-panel">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className={`rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase ${TONE[s.pressure]}`}>Disk {s.pressure}</span>
              <span>{s.disk.free_gb} GB free of {(s.disk.total_bytes / 1e9).toFixed(0)} GB</span>
              <span>Data {size(s.data_dir_bytes)} · logs {size(s.logs_bytes)}</span>
              <span title={s.growth_note}>Grows about {size(s.growth_bytes_per_day)}/day{s.runway_days != null ? ` · about ${s.runway_days} days of room` : ""}</span>
            </div>
            <ul className="divide-y divide-rule/60 text-sm">
              {s.categories.filter((c) => c.files > 0 || c.bytes > 0).map((c) => (
                <li key={c.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                  <span className="min-w-0"><span className="text-paper">{c.name}</span> <span className={`text-xs ${CLASS_TONE[c.class] ?? "text-muted"}`}>{c.class}</span></span>
                  <span className="num text-paper">{size(c.bytes)} <span className="text-xs text-muted">{c.files} file{c.files === 1 ? "" : "s"}</span></span>
                  <span className="basis-full text-xs text-muted">{c.rule}</span>
                </li>
              ))}
            </ul>
            <div className="rounded-sm border border-rule bg-slate-2 p-3 text-sm" data-testid="eod-status">
              <h3 className="mb-1 font-semibold text-paper">After the market closes</h3>
              <p className="text-muted">
                {s.end_of_day.enabled ? `Each finished session is checked, archived and summarised after ${s.end_of_day.runs_after_ist} IST.` : "The end-of-day job is turned off."}
                {s.end_of_day.backups_enabled ? ` Databases are backed up after ${s.end_of_day.backup_after_ist} IST.` : " Backups are made by the server's own nightly job."}
              </p>
              <p className="mt-1">{s.end_of_day.sessions_archived} sessions archived · {s.end_of_day.complete_sessions} complete{s.end_of_day.pending_days.length ? ` · waiting: ${s.end_of_day.pending_days.join(", ")}` : ""}</p>
              <p className="text-xs text-muted">
                Last run {s.end_of_day.last_attempt_at ? fmtDateTimeIST(s.end_of_day.last_attempt_at) : "not yet"}: {s.end_of_day.last_result.state}
                {s.end_of_day.last_backup ? ` · backup ${s.end_of_day.last_backup.day} ${s.end_of_day.last_backup.ok ? "verified" : "FAILED"}` : ""}
              </p>
              <p className="mt-1 text-xs text-muted">{s.daily_models.when}. Intraday model: {s.daily_models.intraday_model}.</p>
            </div>
            <p className="text-xs text-muted" data-testid="prune-note">
              Snapshot files: {s.end_of_day.snapshot_retention.raw_days || s.end_of_day.snapshot_retention.normalized_days
                ? `retention is on (verbatim payloads ${s.end_of_day.snapshot_retention.raw_days || "kept"} days, parsed snapshots ${s.end_of_day.snapshot_retention.normalized_days || "kept"} days; only days with a verified archive).`
                : `all kept; nothing is removed without your approval. With a ${s.snapshot_pruning_plan.older_than_days}-day limit, ${s.snapshot_pruning_plan.files} files (${size(s.snapshot_pruning_plan.bytes)}) would qualify today.`}
            </p>
          </div>
        )}
    </Panel>
  );
}
