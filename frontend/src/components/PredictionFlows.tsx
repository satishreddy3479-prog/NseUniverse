import { FlowsUpdate, useFlowsStatus } from "./FlowsUpdate";
import { fmtInt } from "../lib/format";
import { Panel } from "./ui";

const ROWS: { key: "fao_participant_oi" | "fao_participant_vol" | "fii_dii_cash"; name: string; note: string }[] = [
  { key: "fao_participant_oi", name: "F&O participant open interest", note: "Client, DII, FII, Pro positions, one NSE file per session" },
  { key: "fao_participant_vol", name: "F&O participant volume", note: "Client, DII, FII, Pro traded contracts, one NSE file per session" },
  { key: "fii_dii_cash", name: "FII/DII cash activity", note: "NSE feed shows only the latest day, so history builds up from the day collection started" },
];

/** NSE institutional-flow collection: what is stored, whether NSE let us in, and a manual run. */
export function PredictionFlows() {
  const q = useFlowsStatus();
  const s = q.data;
  return (
    <Panel title="Prediction data: NSE institutional flows">
      {q.isPending ? <p className="text-sm text-muted">Loading…</p>
        : q.error || !s ? <p className="text-sm text-muted">Not available: the running backend does not have this module yet.</p>
        : (
          <div className="space-y-3">
            <FlowsUpdate components={["participant_oi", "participant_vol", "cash"]} s={s} />
            <p className="text-sm text-muted">Source: {s.source}. {s.running && s.progress ? `Now: ${s.progress}.` : ""}</p>
            {s.blocked && <p role="alert" className="text-sm text-down" data-testid="flows-blocked">{s.blocked}</p>}
            {s.cash_note && <p className="text-sm text-warn" data-testid="flows-cash-note">{s.cash_note}</p>}
            {s.last_run && <p className="text-sm" data-testid="flows-last-run">Last run: {fmtInt(s.last_run.requests)} requests, {fmtInt(s.last_run.stored)} files stored, {fmtInt(s.last_run.missing)} not published{s.last_run.errors ? `, ${s.last_run.errors} errors` : ""}{s.last_run.rejected.length ? `, ${s.last_run.rejected.length} rejected by validation` : ""}.</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="NSE flows coverage">
                <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Data</th><th className="text-right font-normal">Sessions stored</th><th className="pl-4 text-left font-normal">From</th><th className="text-left font-normal">To</th></tr></thead>
                <tbody>
                  {ROWS.map((r) => {
                    const c = s.coverage[r.key];
                    return (
                      <tr key={r.key} className="border-t border-rule/50">
                        <td>{r.name}<span className="block text-xs text-muted">{r.note}</span></td>
                        <td className="num text-right">{c.files ? fmtInt(c.files) : "—"}</td>
                        <td className="num pl-4">{c.first ?? "—"}</td><td className="num">{c.last ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </Panel>
  );
}
