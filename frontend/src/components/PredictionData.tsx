import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDateTimeIST, fmtInt } from "../lib/format";
import { Button, Panel } from "./ui";

/** Daily price history used by the prediction models: what exists, what is missing, and a refresh.
 *  It also refreshes by itself once a day after the close; nothing here needs a restart. */
export function PredictionData() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["history-status"],
    queryFn: api.historyStatus,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 30_000),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: api.historyRefresh,
    onSettled: () => void qc.invalidateQueries({ queryKey: ["history-status"] }),
  });
  const s = q.data;
  const run = s?.last_run;
  const sum = run?.summary;
  return (
    <Panel
      title="Prediction data: daily price history"
      actions={
        <Button disabled={!s || s.running || refresh.isPending} onClick={() => refresh.mutate()}
          title="Download new daily bars now (also runs by itself once a day after the close)">
          {s?.running ? "Downloading…" : "Download now"}
        </Button>
      }
    >
      {q.isPending ? <p className="text-sm text-muted">Loading…</p>
        : q.error || !s ? <p className="text-sm text-muted">Not available: the running backend does not have the prediction module yet.</p>
        : (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Source: {s.source}. {s.enabled ? "Updates by itself after 18:30 IST on trading days." : "Automatic updates are off (HISTORY_AUTOFETCH=false)."}
              {s.running && s.progress ? ` Now: ${s.progress}.` : ""}
            </p>
            {run && (
              <p className="text-sm" data-testid="history-last-run">
                Last run {fmtDateTimeIST(run.started_at)}:{" "}
                {sum ? `${sum.ok_symbols} symbols OK, ${fmtInt(sum.new_bars)} new bars` : "in progress"}
                {sum && sum.failed_symbols.length > 0 && <span className="text-down"> · failed: {sum.failed_symbols.join(", ")}</span>}
                {sum && sum.empty_symbols.length > 0 && <span className="text-warn"> · no data: {sum.empty_symbols.join(", ")}</span>}
                {sum && sum.disagreements > 0 && <span className="text-warn"> · {sum.disagreements} bars differ from what is stored (logged, not applied)</span>}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Price history coverage">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="text-left font-normal">Series</th><th className="text-left font-normal">Yahoo ticker</th>
                    <th className="text-right font-normal">Bars</th><th className="text-left pl-4 font-normal">From</th>
                    <th className="text-left font-normal">To</th><th className="text-left font-normal">Close time checked</th>
                  </tr>
                </thead>
                <tbody>
                  {s.symbols.map((x) => (
                    <tr key={x.key} className="border-t border-rule/50">
                      <td>{x.name}</td>
                      <td className="num text-muted">{x.yahoo}</td>
                      <td className="num text-right">{x.has_data ? fmtInt(x.bars) : "—"}</td>
                      <td className="num pl-4">{x.first ?? "—"}</td>
                      <td className="num">{x.last ?? "—"}</td>
                      <td className={x.timing_verified ? "text-up" : "text-muted"}>{x.timing_verified ? "Yes" : "Not yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              Series whose close time is not yet checked are stored but not used as prediction inputs. Yahoo data is unofficial and for personal use.
            </p>
          </div>
        )}
    </Panel>
  );
}
