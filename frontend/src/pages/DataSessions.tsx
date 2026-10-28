import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { fmtAge, fmtDateTimeIST, fmtExpiry, fmtInt } from "../lib/format";
import { useSnapshots, useStatus } from "../lib/hooks";
import type { ChainResponse } from "../lib/types";
import { ChainTable } from "../components/ChainTable";
import { CompletenessText, EmptyState, ErrorNote, Panel, Skeleton, SourceTag } from "../components/ui";
import { SnapshotTable } from "./Overview";

function Inspector({ data }: { data: ChainResponse }) {
  const s = data.snapshot;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-sm border border-warn/50 px-3 py-2 text-sm text-warn">
        {`Historical snapshot retrieved ${fmtDateTimeIST(s.retrieved_at)} (${fmtAge(data.age_seconds)}). These are not current prices.`}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
        <div><dt className="text-muted">Expiry</dt><dd>{fmtExpiry(s.expiry)}</dd></div>
        <div><dt className="text-muted">Chain</dt><dd><CompletenessText value={s.completeness} /></dd></div>
        <div><dt className="text-muted">Strikes (CE / PE)</dt><dd className="num">{s.rows.length} ({s.ce_count} / {s.pe_count})</dd></div>
        <div><dt className="text-muted">Lot size</dt><dd className="num">{fmtInt(s.lot_size)}</dd></div>
        <div><dt className="text-muted">Exchange timestamp</dt><dd className="text-muted">Not provided by source</dd></div>
      </dl>
      {s.warnings.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-warn">{s.warnings.length} data warnings</summary>
          <ul className="mt-1 list-disc pl-5 text-muted">{s.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <ChainTable rows={s.rows} showCalls showPuts />
      <p className="text-xs text-muted">
        ATM is the broker's own moneyness label. — means missing at source; * marks a value the source sent but that failed validation.
      </p>
      <a className="self-start text-sm text-info underline-offset-2 hover:underline" href={api.csvUrl(s.snapshot_id)}>
        Download CSV
      </a>
    </div>
  );
}

export function DataSessions() {
  const [params] = useSearchParams();
  const selected = params.get("snapshot") ?? undefined;
  const snapshots = useSnapshots();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const current = useStatus().data?.session_id;
  const detail = useQuery({
    queryKey: ["snapshot", selected],
    queryFn: () => api.snapshot(selected!),
    enabled: !!selected,
  });

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Data & sessions</h1>
        <p className="text-sm text-muted">Stored snapshots and backend sessions. Everything here is historical.</p>
      </div>

      {selected && (
        <Panel title="Snapshot inspector" actions={detail.data && <SourceTag source={detail.data.display_source} />}>
          {detail.isLoading ? <Skeleton className="h-40 w-full" />
            : detail.error ? <ErrorNote title="Could not load snapshot"
                message={detail.error instanceof ApiError ? detail.error.message : "Unknown error"} />
            : detail.data ? <Inspector data={detail.data} /> : null}
        </Panel>
      )}

      <Panel title="Snapshots">
        {snapshots.isLoading ? <Skeleton className="h-24 w-full" />
          : !snapshots.data?.length ? <EmptyState title="No snapshots stored">Capture one from Overview.</EmptyState>
          : <SnapshotTable rows={snapshots.data} selected={selected} />}
      </Panel>

      <Panel title="Backend sessions">
        {sessions.isLoading ? <Skeleton className="h-16 w-full" />
          : sessions.error ? <ErrorNote title="Could not load sessions" message="Backend request failed." />
          : (
            <div className="overflow-x-auto">
              <table className="num w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-rule">
                    <th className="py-2 pr-4 font-medium">Started (IST)</th>
                    <th className="py-2 pr-4 font-medium">Ended (IST)</th>
                    <th className="py-2 pr-4 text-right font-medium">Snapshots</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.data?.map((s) => (
                    <tr key={s.session_id} className="border-b border-rule/60">
                      <td className="py-2 pr-4">{fmtDateTimeIST(s.started_at)}</td>
                      <td className="py-2 pr-4">{s.ended_at ? fmtDateTimeIST(s.ended_at) : s.session_id === current ? <span className="text-up">Current session</span> : <span className="text-muted" title="The backend stopped without recording an end time">Not recorded</span>}</td>
                      <td className="py-2 pr-4 text-right">{s.snapshot_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
    </div>
  );
}
