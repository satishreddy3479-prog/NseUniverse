import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import type { FlowsStatus } from "../lib/types";
import { Button } from "./ui";

export type FlowsComponent = "participant_oi" | "participant_vol" | "cash";
const NAMES: Record<FlowsComponent, string> = { participant_oi: "F&O participant open interest", participant_vol: "F&O participant volume", cash: "FII/DII cash" };
const COVERAGE: Record<FlowsComponent, "fao_participant_oi" | "fao_participant_vol" | "fii_dii_cash"> = { participant_oi: "fao_participant_oi", participant_vol: "fao_participant_vol", cash: "fii_dii_cash" };

export function useFlowsStatus() {
  return useQuery({
    queryKey: ["flows-status"], queryFn: api.flowsStatus, retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
  });
}

/** "Update now" plus, for each source: newest session stored, last successful automatic check, last manual update. */
export function FlowsUpdate({ components, s }: { components: FlowsComponent[]; s: FlowsStatus }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: api.flowsRefresh,
    onSettled: () => { for (const k of ["flows-status", "cash", "flows-latest"]) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  const busy = s.running || run.isPending;
  const allStored = (s.missing_expected ?? []).length === 0;
  return (
    <div className="space-y-2" data-testid="flows-update">
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={() => run.mutate()} title="Look for any file NSE has published and not stored yet. Stored values are never overwritten.">{busy ? "Updating…" : "Update now"}</Button>
        {s.expected_session && (
          <span className="text-xs text-muted" data-testid="flows-expected">
            Newest session expected: <span className="num text-paper">{s.expected_session}</span>.{" "}
            {allStored ? "Everything for it is stored; automatic checks have stopped until the next session." : `Still missing: ${(s.missing_expected ?? []).map((c) => NAMES[c as FlowsComponent] ?? c).join(", ")}. Checked automatically every 30 minutes from 18:30 IST until published.`}
          </span>
        )}
      </div>
      <ul className="space-y-1 text-xs text-muted">
        {components.map((c) => {
          const r = s.components?.[c];
          const cov = s.coverage[COVERAGE[c]];
          return (
            <li key={c} data-testid={`flows-run-${c}`}>
              <span className="text-paper">{NAMES[c]}</span>: newest stored <span className="num text-paper">{cov.last ?? "—"}</span>
              {" · "}last successful automatic check <span className="num text-paper">{r?.last_auto_ok ? fmtDateTimeIST(r.last_auto_ok.at) : "none yet"}</span>
              {" · "}last manual update <span className="num text-paper">{r?.last_manual_ok ? fmtDateTimeIST(r.last_manual_ok.at) : "none yet"}</span>
              {r?.last && !r.last.ok && <span className="text-warn"> · last attempt failed: {r.last.note}</span>}
              {r?.last?.ok && r.last.note && r.last.newest_session && s.expected_session && r.last.newest_session < s.expected_session && <span> · {r.last.note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Self-contained version for pages that do not already load the flows status. */
export function FlowsUpdateLoader({ components }: { components: FlowsComponent[] }) {
  const q = useFlowsStatus();
  if (!q.data) return null;
  return <FlowsUpdate components={components} s={q.data} />;
}
