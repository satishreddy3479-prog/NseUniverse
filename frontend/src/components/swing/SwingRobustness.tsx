import { useMemo } from "react";
import { EChart, useChartColors } from "../EChart";
import { Panel } from "../ui";
import { robustnessOption } from "../../lib/swingCharts";
import { exitLabel, pct, plain, rupees, SECTOR_NAME } from "../../lib/swing";
import type { SwingGroupRow, SwingReport, SwingRobustRow } from "../../lib/types";
import { Stat, TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

function GroupTable({ title, rows, name }: { title: string; rows: SwingGroupRow[]; name: (k: string) => string }) {
  return (
    <div className={TABLE_WRAP}>
      <table className="num w-full min-w-[420px] text-sm">
        <caption className="mb-1 text-left text-xs font-medium text-muted">{title}</caption>
        <thead className={THEAD}>
          <tr><th scope="col" className="px-2 py-1.5 text-left font-medium">Group</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Trades</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Won</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Avg R</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">P&amp;L, % of ₹10 L</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-rule">
              <th scope="row" className={`${TD_L} font-normal text-paper`}>{name(String(r.key))}</th>
              <td className={TD}>{r.trades}</td>
              <td className={TD}>{r.win_rate_pct.toFixed(0)}%</td>
              <td className={TD}>{plain(r.avg_r)}</td>
              <td className={`${TD} ${r.pnl >= 0 ? "text-up" : "text-down"}`}>{pct(r.pnl_pct_of_capital)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plain-language read of the minimum-score runs, built from the numbers in the report. */
export function sensitivity(rows: SwingRobustRow[]): string {
  if (rows.length < 2) return "";
  const r = rows.map((x) => x.gross_return_pct);
  const spread = Math.max(...r) - Math.min(...r);
  const list = rows.map((x) => `${x.label.replace("  (rule)", " (rule)")}: ${pct(x.gross_return_pct, 0)}`).join(" · ");
  return spread > 25
    ? `Before costs: ${list}. Nearby scores give results ${spread.toFixed(0)} points apart, so the result depends heavily on the exact threshold: a promising research result, not proof of a lasting edge.`
    : `Before costs: ${list}. Nearby scores give similar results (${spread.toFixed(0)} points apart).`;
}

export function SwingRobustness({ report }: { report: SwingReport }) {
  const colors = useChartColors();
  const scoreRows = useMemo(() => report.robustness.filter((r) => r.group === "Minimum score"), [report.robustness]);
  const scoreOpt = useMemo(() => robustnessOption(scoreRows, colors), [scoreRows, colors]);
  const groups = useMemo(() => [...new Set(report.robustness.map((r) => r.group))], [report.robustness]);
  const c = report.concentration;
  const o = report.original_ledger;
  const g = report.kpis.gross;
  return (
    <>
      <Panel title="Profit is concentrated in a few trades">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="Total profit (before costs)" value={rupees(c.total_pnl)} />
          <Stat label="From the 10 best trades" value={rupees(c.top10_pnl)} sub={c.top10_share_pct == null ? undefined : `${c.top10_share_pct.toFixed(0)}% of the total`} />
          <Stat label="Everything else (all other trades)" value={rupees(c.pnl_without_top10)} tone={c.pnl_without_top10 >= 0 ? "up" : "down"} />
          <Stat label="Trades" value={String(g.trades)} sub={`${plain(g.win_rate_pct, 1)}% won`} />
        </div>
        <p className="mt-3 max-w-[75ch] text-sm text-muted">
          This is how breakout trend systems usually look: many small losses, a few large winners. It also means a different
          set of trades, or missing a handful of them, changes the result a lot.
        </p>
      </Panel>

      <Panel title="Change one rule slightly and watch the result">
        <div className="h-[260px]"><EChart option={scoreOpt} ariaLabel="Return by minimum score, before and after costs" /></div>
        <p className="mt-2 text-xs text-muted">Minimum score for a signal (★ = the rule). Return over the full test period, start ₹10 L.</p>
        {groups.map((gr) => (
          <div key={gr} className={`mt-4 ${TABLE_WRAP}`}>
            <table className="num w-full min-w-[620px] text-sm">
              <caption className="mb-1 text-left text-xs font-medium text-muted">{gr}</caption>
              <thead className={THEAD}>
                <tr><th scope="col" className="px-2 py-1.5 text-left font-medium">Variant</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Trades</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Before costs</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">After costs</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Worst drawdown</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Profit factor (before / after)</th></tr>
              </thead>
              <tbody>
                {report.robustness.filter((r) => r.group === gr).map((r) => (
                  <tr key={r.label} className="border-t border-rule">
                    <th scope="row" className={`${TD_L} font-normal text-paper`}>{r.label}</th>
                    <td className={TD}>{r.trades}</td>
                    <td className={TD}>{pct(r.gross_return_pct)}</td>
                    <td className={TD}>{pct(r.net_return_pct)}</td>
                    <td className={TD}>−{r.gross_max_dd_pct.toFixed(1)}%</td>
                    <td className={TD}>{plain(r.gross_profit_factor)} / {plain(r.net_profit_factor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="mt-3 max-w-[75ch] text-sm text-muted" data-testid="score-sensitivity">{sensitivity(scoreRows)}</p>
      </Panel>

      <Panel title="This rebuild vs the original author's ledger">
        <div className={TABLE_WRAP}>
          <table className="num w-full min-w-[520px] text-sm">
            <caption className="sr-only">Comparison with the original ledger</caption>
            <thead className={THEAD}>
              <tr><th scope="col" className="px-2 py-1.5 text-left font-medium">Measure</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Original ledger</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">This rebuild, before costs</th></tr>
            </thead>
            <tbody>
              {[
                ["Return", pct(o.return_pct), pct(g.return_pct)],
                ["Worst drawdown", `−${o.max_drawdown_pct.toFixed(1)}%`, `−${g.max_drawdown_pct.toFixed(1)}%`],
                ["Profit factor", plain(o.profit_factor), plain(g.profit_factor)],
                ["Win rate", `${o.win_rate_pct.toFixed(1)}%`, `${plain(g.win_rate_pct, 1)}%`],
                ["Trades", String(o.trades), String(g.trades)],
                ["Costs", o.costs, "none (see After costs)"],
                ["Prices", o.prices, "split-adjusted, tradable"],
              ].map(([m, a, b]) => (
                <tr key={m} className="border-t border-rule"><th scope="row" className={`${TD_L} font-normal text-paper`}>{m}</th><td className={TD}>{a}</td><td className={TD}>{b}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{o.source}. {o.note}</p>
      </Panel>

      <Panel title="Where the results come from">
        <div className="grid gap-4 lg:grid-cols-2">
          <GroupTable title="By entry year" rows={report.by_year} name={(k) => k} />
          <GroupTable title="By pattern" rows={report.by_archetype} name={(k) => k.replace("_", " ").toLowerCase()} />
          <GroupTable title="By sector index" rows={report.by_sector} name={(k) => SECTOR_NAME[k] ?? k} />
          <GroupTable title="By exit" rows={report.by_exit_reason} name={exitLabel} />
        </div>
      </Panel>
    </>
  );
}
