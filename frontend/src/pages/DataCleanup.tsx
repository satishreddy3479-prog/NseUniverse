import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "../components/Info";
import { Panel } from "../components/ui";
import { api, type CleanupCandidate } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";

const size = (b: number): string => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} B`);
const n = (v: number): string => v.toLocaleString("en-IN");
const TONE = { ok: "border-up/50 text-up", watch: "border-warn/50 text-warn", low: "border-warn/70 text-warn", critical: "border-down/60 text-down" } as const;

/** What the server stores, what today holds and exactly what could be removed, with a preview before anything goes. */
export function DataCleanup() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cleanup"], queryFn: api.cleanupOverview, refetchInterval: 60_000, retry: false });
  const [picked, setPicked] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const run = useMutation({
    mutationFn: (items: string[]) => api.cleanupRun(items),
    onSuccess: () => { setReview(false); setUnderstood(false); setPicked([]); void qc.invalidateQueries({ queryKey: ["cleanup"] }); void qc.invalidateQueries({ queryKey: ["storage"] }); },
  });
  const o = q.data;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const chosen: CleanupCandidate[] = o ? o.candidates.filter((c) => picked.includes(c.id)) : [];
  const chosenBytes = chosen.reduce((t, c) => t + c.bytes, 0);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <h1 className="text-xl font-semibold">Data clean-up</h1>
      {q.isPending ? <p className="text-sm text-muted">Measuring the server…</p>
        : q.isError || !o ? <p role="alert" className="text-sm text-down">The storage overview is not available from the backend.</p>
        : (
          <>
            <Panel title="Disk">
              <div className="flex flex-col gap-2" data-testid="cleanup-disk">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                  <span className={`rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase ${TONE[o.pressure]}`}>Disk {o.pressure}</span>
                  <span><span className="num text-paper">{o.disk.free_gb} GB</span> free of {(o.disk.total_bytes / 1e9).toFixed(0)} GB</span>
                  <span>Our data <span className="num text-paper">{size(o.data_bytes)}</span> · logs {size(o.logs_bytes)}</span>
                  <span>Grows about <span className="num text-paper">{size(o.growth_bytes_per_day)}</span>/day{o.runway_days != null ? ` · about ${n(o.runway_days)} days of room` : ""}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-sm bg-slate-2" role="img" aria-label={`${size(o.disk.total_bytes - o.disk.free_bytes)} used of ${size(o.disk.total_bytes)}`}>
                  <div className="h-full bg-info" style={{ width: `${Math.min(100, ((o.disk.total_bytes - o.disk.free_bytes) / o.disk.total_bytes) * 100)}%` }} />
                </div>
              </div>
            </Panel>

            <Panel title="Today's data">
              <div className="flex flex-col gap-2 text-sm" data-testid="cleanup-today">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Tile label="Samples today" value={n(o.today.samples)} sub={o.today.expiries.map((e) => `${e.expiry}: ${n(e.samples)}`).join(" · ") || "none yet"} />
                  <Tile label="Contract rows" value={n(o.today.contract_rows)} sub={`about ${size(o.today.contract_bytes_estimate)}`} />
                  <Tile label="Snapshot files" value={n(o.today.snapshot_files)} sub={size(o.today.snapshot_bytes)} />
                  <Tile label="Intraday ML rows" value={n(o.today.intraday.feature_rows)} sub={`${n(o.today.intraday.scores)} scores · ${n(o.today.intraday.summaries)} summaries`} />
                </div>
                <p className="text-xs text-muted">{o.today.note}</p>
              </div>
            </Panel>

            <Panel title="What could be removed">
              <div className="flex flex-col gap-3" data-testid="cleanup-candidates">
                <p className="text-xs text-muted">Only data the verified daily archive already holds, or that can be created again. Sizes are measured now. Nothing is removed until you review and confirm below.</p>
                <ul className="divide-y divide-rule/60">
                  {o.candidates.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
                      <input id={`c-${c.id}`} type="checkbox" className="mt-1" checked={picked.includes(c.id)} disabled={!c.enabled || c.bytes === 0}
                        onChange={() => toggle(c.id)} aria-label={`Select: ${c.label}`} />
                      <label htmlFor={`c-${c.id}`} className="min-w-0 flex-1">
                        <span className={`text-sm ${c.enabled && c.bytes > 0 ? "text-paper" : "text-muted"}`}>{c.label}</span>
                        <span className="block text-xs text-muted">{c.why_safe}</span>
                        {c.blocked > 0 && <span className="block text-xs text-warn">{c.blocked} day{c.blocked === 1 ? "" : "s"} kept because the archive does not cover {c.blocked === 1 ? "it" : "them"} yet{c.blocked_detail?.[0] ? ` (${c.blocked_detail[0].day}: ${c.blocked_detail[0].reason})` : ""}.</span>}
                        {!c.enabled && <span className="block text-xs text-muted">Switched off in the settings (0 days).</span>}
                      </label>
                      <span className="num text-sm text-paper">{c.bytes === 0 ? "nothing to remove" : size(c.bytes)}
                        <span className="block text-right text-xs text-muted">{c.rows != null ? `${n(c.rows)} rows` : `${n(c.files)} file${c.files === 1 ? "" : "s"}`}</span></span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span>Could free <span className="num text-paper">{size(o.removable_bytes)}</span></span>
                  {!review ? (
                    <button type="button" disabled={chosen.length === 0} onClick={() => setReview(true)}
                      className="rounded-sm border border-brass bg-brass/15 px-3 py-1.5 text-paper hover:bg-brass/25 disabled:opacity-40">Review {chosen.length ? `${chosen.length} selected` : "selection"}</button>
                  ) : (
                    <div className="flex w-full flex-col gap-2 rounded-sm border border-warn/50 bg-warn/5 p-3" data-testid="cleanup-review">
                      <div className="font-semibold text-warn">This will remove about {size(chosenBytes)}:</div>
                      <ul className="list-disc pl-5 text-xs text-paper">{chosen.map((c) => <li key={c.id}>{c.label}: {c.rows != null ? `${n(c.rows)} rows` : `${n(c.files)} files`}, {size(c.bytes)}</li>)}</ul>
                      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand this cannot be undone; the daily archive keeps a verified copy of what is removed from the database and snapshots.</label>
                      <div className="flex gap-2">
                        <button type="button" disabled={!understood || run.isPending} onClick={() => run.mutate(picked)}
                          className="rounded-sm border border-down/70 bg-down/10 px-3 py-1.5 text-down hover:bg-down/20 disabled:opacity-40">{run.isPending ? "Removing…" : "Remove now"}</button>
                        <button type="button" onClick={() => { setReview(false); setUnderstood(false); }} className="rounded-sm border border-rule px-3 py-1.5 text-muted hover:text-paper">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                {run.isError && <p role="alert" className="text-sm text-down">Clean-up failed: {run.error instanceof Error ? run.error.message : "unknown error"}. Nothing was changed by the failed step.</p>}
                {run.isSuccess && <p className="text-sm text-up" data-testid="cleanup-done">Done. The list above is measured again.</p>}
                <p className="text-xs text-muted">Every night after the close the same checks run automatically: raw responses older than {o.policy.raw_days} days and normalized files older than {o.policy.normalized_days} days are removed once archived. Per-contract rows older than the last {o.policy.contract_row_sessions} sessions are only reported until switched on in the server settings.</p>
              </div>
            </Panel>

            <Panel title="What is stored">
              <ul className="divide-y divide-rule/60 text-sm" data-testid="cleanup-stores">
                {[...o.stores.map((s) => ({ name: s.name, holds: s.holds, keep: s.keep, bytes: s.bytes, extra: Object.entries(s.tables).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${n(v)}`).join(" · ") })),
                  ...o.files.map((f) => ({ name: f.name, holds: f.holds, keep: f.keep, bytes: f.bytes, extra: `${n(f.files)} file${f.files === 1 ? "" : "s"}` }))].map((s) => (
                  <li key={s.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                    <span className="min-w-0 flex-1"><span className="text-paper">{s.name}</span><span className="block text-xs text-muted">{s.holds}</span><span className="block text-xs text-muted">Rule: {s.keep}</span></span>
                    <span className="num text-right text-paper">{size(s.bytes)}<span className="block max-w-[28ch] text-xs text-muted">{s.extra}</span></span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Never removed">
              <ul className="flex flex-col gap-1 text-sm">
                {o.never_deleted.map((d) => <li key={d.name}><span className="text-paper">{d.name}</span> <span className="text-xs text-muted">— {d.why}</span></li>)}
              </ul>
              <p className="mt-2 text-xs text-muted">Last automatic runs: {Object.entries(o.last_runs).map(([k, v]) => `${k}: ${v ? "ran" : "not yet"}`).join(" · ")}. Overview measured {fmtDateTimeIST(new Date().toISOString())}.</p>
            </Panel>
          </>
        )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-rule bg-slate-2/60 px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted">{label}<Info term={label} /></div>
      <div className="num text-base font-semibold text-paper">{value}</div>
      {sub && <div className="truncate text-[11px] text-muted" title={sub}>{sub}</div>}
    </div>
  );
}
