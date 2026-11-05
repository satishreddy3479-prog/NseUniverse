import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DataCleanup } from "../../pages/DataCleanup";
import { serverApi, ServerApiError, type OpSpec } from "../../lib/serverApi";
import { Async, Badge, Card, Table, btn, field, useServerQuery, when } from "./common";

const RISK: Record<string, string> = { low: "ok", medium: "warning", high: "critical" };

// ------------------------------------------------------------------ Maintenance
function OpCard({ op, retention }: { op: OpSpec; retention: Record<string, number> }) {
  const qc = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [yes, setYes] = useState(false);
  const [out, setOut] = useState<{ status: string; verification: string | null; at: string; mode: string; result?: unknown } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (o: { dry_run?: boolean; confirm?: boolean }) => serverApi.run(op.id, { ...o, service: op.id === "restart_service" ? "nse-universe" : undefined }),
    onSuccess: (r) => { setOut(r); setErr(null); setArmed(false); setYes(false); void qc.invalidateQueries({ queryKey: ["server"] }); },
    onError: (e) => setErr(e instanceof ServerApiError ? e.message : "The request failed."),
  });
  return (
    <div className="rounded-sm border border-rule bg-slate-2 p-3" data-testid={`sm-op-${op.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-paper">{op.title}</h3><Badge kind={RISK[op.risk]!}>{op.risk} risk</Badge></div>
      <dl className="mt-1 text-xs text-muted"><dt className="inline">Target: </dt><dd className="inline text-paper">{op.target}</dd><br /><dt className="inline">Effect: </dt><dd className="inline">{op.effect}</dd></dl>
      {op.id === "retention_cleanup" && <p className="mt-1 text-xs text-muted" data-testid="sm-retention-preview">Would remove now: {Object.entries(retention).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!op.confirm && <button type="button" className={btn()} disabled={run.isPending} onClick={() => run.mutate({})}>{run.isPending ? "Running…" : "Run"}</button>}
        {op.confirm && (op.preview || op.id === "restart_service") && <button type="button" className={btn()} disabled={run.isPending} onClick={() => run.mutate({ dry_run: true })}>Preview</button>}
        {op.confirm && !armed && <button type="button" className={btn()} onClick={() => setArmed(true)}>Run…</button>}
        {op.confirm && armed && (
          <>
            <label className="flex items-center gap-1 text-xs text-paper"><input type="checkbox" checked={yes} onChange={(e) => setYes(e.target.checked)} /> I understand: {op.effect}</label>
            <button type="button" className={btn(true)} disabled={!yes || run.isPending} onClick={() => run.mutate({ confirm: true })}>Confirm and run</button>
            <button type="button" className={btn()} onClick={() => { setArmed(false); setYes(false); }}>Cancel</button>
          </>
        )}
      </div>
      {err && <p role="alert" className="mt-2 text-xs text-down">{err}</p>}
      {out && <p className="mt-2 text-xs text-muted" data-testid={`sm-op-result-${op.id}`}><Badge kind={out.status === "ok" ? "ok" : out.status === "queued" ? "info" : "warning"}>{out.mode === "preview" ? "preview" : out.status}</Badge> {out.verification} · {when(out.at)}</p>}
    </div>
  );
}

export function MaintenanceTab() {
  const m = useServerQuery(["maintenance"], serverApi.maintenance, 60_000);
  return (
    <div className="flex flex-col gap-3" data-testid="sm-maintenance">
      <Card title="Maintenance operations" note="Every operation is recorded in the audit history with its target, effect and the verification of the result. Destructive ones show what they would do first and need explicit confirmation.">
        <Async q={m} what="Maintenance">{(d) => (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 lg:grid-cols-2">{d.operations.map((o) => <OpCard key={o.id} op={o} retention={d.retention_preview} />)}</div>
            <p className="text-xs text-muted">Downloads: <a className="text-info underline" href="/api/server/diagnostics/bundle" download>diagnostic bundle (zip, secrets masked)</a> · <a className="text-info underline" href="/api/server/storage/history.csv" download>storage history (CSV)</a></p>
            {!d.helper.installed && <p className="text-xs text-warn" data-testid="sm-helper-missing">Service restart is unavailable until the privileged helper is installed on the server: {d.helper.reason}</p>}
          </div>
        )}</Async>
      </Card>
      <Card title="Data clean-up (existing rules, preview first)" note="This is the existing clean-up: it lists exactly what would be removed and only removes data the verified archive already holds or that can be regenerated.">
        <DataCleanup embedded />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Alerts
export function AlertsTab() {
  const [all, setAll] = useState(false);
  const a = useServerQuery(["alerts", all], () => serverApi.alerts(all), 30_000);
  return (
    <Card title="Alerts" actions={<button type="button" aria-pressed={all} className={btn(all)} onClick={() => setAll((x) => !x)}>{all ? "Showing history" : "Open alerts only"}</button>} note="An alert stays one row while its condition lasts (the count is how many checks saw it) and closes itself when the condition clears. Thresholds are in Configuration.">
      <Async q={a} what="Alerts">{(d) => (
        <Table testId="sm-alerts" head={["Level", "Alert", "Detail", "First seen", "Last seen", "Checks", "State"]} min="48rem" empty="No alerts."
          rows={d.alerts.map((x) => [<Badge key="l" kind={x.level}>{x.level}</Badge>, x.title, x.detail ?? "", when(x.first_utc), when(x.last_utc), x.count, x.resolved_utc ? `resolved ${when(x.resolved_utc)}` : <Badge key="o" kind="warning">open</Badge>])} />
      )}</Async>
    </Card>
  );
}

// ------------------------------------------------------------------ Audit
export function AuditTab() {
  const [page, setPage] = useState(0);
  const size = 25;
  const a = useServerQuery(["audit", page], () => serverApi.audit(size, page * size), 30_000);
  return (
    <Card title="Audit history" note="Every management action, including refused ones. Rows are never edited from the website.">
      <Async q={a} what="Audit history">{(d) => (
        <>
          <Table testId="sm-audit" head={["When", "Who", "Operation", "Target", "Mode", "Result", "Verification"]} min="52rem" empty="No management action has been recorded yet."
            rows={d.rows.map((r) => [when(r.ts_utc), r.actor, r.op, r.target ?? "", r.mode, <Badge key="s" kind={r.status === "ok" ? "ok" : r.status === "queued" ? "info" : "warning"}>{r.status}</Badge>, r.verification ?? r.detail ?? ""])} />
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <button type="button" className={btn()} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <span>{d.total} record(s)</span>
            <button type="button" className={btn()} disabled={(page + 1) * size >= d.total} onClick={() => setPage((p) => p + 1)}>Older</button>
          </div>
        </>
      )}</Async>
    </Card>
  );
}

// ------------------------------------------------------------------ Configuration
const GROUPS: [string, string[]][] = [
  ["Collection", ["sample_interval_s", "daily_snapshot_hour", "daily_snapshot_minute", "scan_timeout_s", "inventory_max_files"]],
  ["Alert thresholds", ["disk_warn_pct", "disk_crit_pct", "disk_free_crit_gb", "growth_warn_mb_day", "ram_warn_pct", "ram_crit_pct", "cpu_warn_pct", "forecast_threshold_pct", "forecast_min_days"]],
  ["Retention (this module's own history only)", ["metrics_retention_days", "snapshot_retention_days", "inventory_retention_days", "audit_retention_days"]],
];
export function ConfigTab() {
  const qc = useQueryClient();
  const c = useServerQuery(["config"], serverApi.config, 300_000);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => serverApi.saveConfig(values),
    onSuccess: () => { setDraft({}); setMsg({ ok: true, text: "Saved." }); void qc.invalidateQueries({ queryKey: ["server"] }); },
    onError: (e) => setMsg({ ok: false, text: e instanceof ServerApiError ? e.message : "Saving failed." }),
  });
  return (
    <Card title="System configuration" note="Reporting timezone is Asia/Kolkata. Values are checked on the server against the limits shown; a rejected change leaves everything as it was. Nothing secret is stored here.">
      <Async q={c} what="Configuration">{(d) => {
        const val = (k: string) => draft[k] ?? String(d.values[k]);
        const submit = () => {
          const values: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(draft)) values[k] = k in d.lists ? v.split(",").map((s) => s.trim()).filter(Boolean) : Number(v);
          save.mutate(values);
        };
        return (
          <form className="flex flex-col gap-4" data-testid="sm-config" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {GROUPS.map(([title, keys]) => (
              <fieldset key={title}><legend className="mb-1 text-xs font-semibold text-paper">{title}</legend>
                <div className="grid gap-2 md:grid-cols-2">
                  {keys.filter((k) => d.schema[k]).map((k) => { const s = d.schema[k]!; return (
                    <label key={k} className="flex flex-col gap-0.5 text-xs text-muted">{s.description} <span className="text-[10px]">({s.min}–{s.max}, default {s.default})</span>
                      <input aria-label={s.description} type="number" step="any" min={s.min} max={s.max} value={val(k)} onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))} className={field} />
                    </label>); })}
                </div>
              </fieldset>
            ))}
            <fieldset><legend className="mb-1 text-xs font-semibold text-paper">Lists (comma separated)</legend>
              <div className="grid gap-2 md:grid-cols-3">
                {Object.keys(d.lists).map((k) => (
                  <label key={k} className="flex flex-col gap-0.5 text-xs text-muted">{k.replace(/_/g, " ")}
                    <input aria-label={k.replace(/_/g, " ")} value={draft[k] ?? (d.values[k] as string[]).join(", ")} onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))} className={field} />
                  </label>))}
              </div>
              <p className="mt-1 text-[11px] text-muted">Excluded folders and patterns are left out of every storage total (empty by default, so everything counts). Manageable services can only ever contain nse-universe.</p>
            </fieldset>
            <div className="flex items-center gap-3">
              <button type="submit" className={btn(true)} disabled={save.isPending || Object.keys(draft).length === 0}>Save changes</button>
              {Object.keys(draft).length > 0 && <button type="button" className={btn()} onClick={() => { setDraft({}); setMsg(null); }}>Discard</button>}
              {msg && <span role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</span>}
            </div>
          </form>
        );
      }}</Async>
    </Card>
  );
}
