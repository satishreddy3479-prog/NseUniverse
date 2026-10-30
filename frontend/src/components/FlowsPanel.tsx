import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtInt } from "../lib/format";
import { FlowsUpdateLoader } from "./FlowsUpdate";
import { groupedBarsOption } from "../lib/chartOptions";
import { EChart, useChartColors } from "./EChart";
import { Panel } from "./ui";

const GROUPS = ["FII", "DII", "Pro", "Client"] as const;

function net(m: Record<string, number> | undefined, long: string, short: string): number | null {
  return m && long in m && short in m ? m[long]! - m[short]! : null;
}
function tone(v: number | null): string {
  return v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "";
}

/** Stored NSE participant-wise F&O positions (long minus short), exactly as NSE published them. */
export function FlowsPanel() {
  const q = useQuery({ queryKey: ["flows-latest"], queryFn: api.flowsLatest, retry: false, staleTime: 60_000 });
  const colors = useChartColors();
  const days = q.data?.open_interest ?? [];
  const asc = [...days].sort((a, b) => (a.session < b.session ? -1 : 1));
  const gcol = { FII: colors.info, DII: colors.brass, Pro: colors.up, Client: colors.down } as const;
  return (
    <Panel title="Institutional positions — NSE F&O participant open interest (net = long − short, contracts)">
      <div className="mb-3"><FlowsUpdateLoader components={["participant_oi", "participant_vol"]} /></div>
      {q.isPending ? <p className="text-sm text-muted">Loading…</p>
        : q.error ? <p className="text-sm text-muted">Not available: the running backend does not have this module yet.</p>
        : days.length === 0 ? <p className="text-sm text-muted" data-testid="flows-empty">No NSE participant files stored yet. They download by themselves (Settings → Prediction data: NSE institutional flows).</p>
        : (
          <div className="space-y-3">
            <div className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="flows-chart">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">Net index futures by participant (long − short, contracts)</p>
              <div className="h-52"><EChart ariaLabel="Net index futures by participant and session" option={groupedBarsOption(asc.map((d) => d.session),
                GROUPS.map((g) => ({ name: g, color: gcol[g], values: asc.map((d) => net(d.participants[g], "Future Index Long", "Future Index Short")) })), colors, (v) => `${fmtInt(v)} contracts`)} /></div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Net index futures by participant">
                <thead className="text-xs text-muted">
                  <tr><th className="text-left font-normal">Session</th>{GROUPS.map((g) => <th key={g} className="text-right font-normal">{g} net index futures</th>)}<th className="text-right font-normal">FII net index calls</th><th className="text-right font-normal">FII net index puts</th></tr>
                </thead>
                <tbody>
                  {days.map((d) => {
                    const fii = d.participants.FII;
                    const calls = net(fii, "Option Index Call Long", "Option Index Call Short");
                    const puts = net(fii, "Option Index Put Long", "Option Index Put Short");
                    return (
                      <tr key={d.session} className="border-t border-rule/50 num">
                        <td>{d.session}</td>
                        {GROUPS.map((g) => { const v = net(d.participants[g], "Future Index Long", "Future Index Short"); return <td key={g} className={`text-right ${tone(v)}`}>{v == null ? "—" : fmtInt(v)}</td>; })}
                        <td className={`text-right ${tone(calls)}`}>{calls == null ? "—" : fmtInt(calls)}</td>
                        <td className={`text-right ${tone(puts)}`}>{puts == null ? "—" : fmtInt(puts)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">Source: NSE participant-wise open interest file for each session, published after the close. FII/DII cash-market buy/sell values are not shown: NSE refuses automated access to that feed.</p>
          </div>
        )}
    </Panel>
  );
}
