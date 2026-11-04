import { useMemo } from "react";
import { EChart, useChartColors } from "../EChart";
import { Panel } from "../ui";
import { drawdownOption, equityOption, yearReturnsOption } from "../../lib/swingCharts";
import { BASIS_LABEL, exitLabel, pct, plain, rupees, signedRupees, type Basis } from "../../lib/swing";
import type { SwingReport } from "../../lib/types";
import { Stat, TD, TD_L, TABLE_WRAP, THEAD } from "./shared";

export function SwingOverview({ report, basis }: { report: SwingReport; basis: Basis }) {
  const colors = useChartColors();
  const k = report.kpis[basis];
  const eq = useMemo(() => equityOption(report, basis, colors), [report, basis, colors]);
  const dd = useMemo(() => drawdownOption(report, basis, colors), [report, basis, colors]);
  const yr = useMemo(() => yearReturnsOption(report, basis, colors), [report, basis, colors]);
  const c = report.concentration;
  const beats = k.return_pct > k.nifty_return_pct;
  return (
    <>
      <section aria-label="Key figures" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={`Return, ${report.meta.period_start} to ${report.meta.data_through}`} value={pct(k.return_pct)} sub={`NIFTY 50: ${pct(k.nifty_return_pct)}`} tone={beats ? "up" : "down"} />
        <Stat label="Annual return (CAGR)" value={pct(k.cagr_pct)} sub={`NIFTY 50: ${pct(k.nifty_cagr_pct)}`} />
        <Stat label="Worst drawdown" value={`−${k.max_drawdown_pct.toFixed(1)}%`} sub={`Calmar ${plain(k.calmar)}`} />
        <Stat label="Profit factor" value={plain(k.profit_factor)} sub="gross profit ÷ gross loss" />
        <Stat label="Trades" value={String(k.trades)} sub={`${plain(k.win_rate_pct, 1)}% won`} />
        <Stat label="Average win ÷ average loss" value={plain(k.avg_win_over_avg_loss)} />
        <Stat label="Average R per trade" value={plain(k.avg_r)} sub="R = initial risk" />
        <Stat label="Holding days, winners / losers" value={`${plain(k.avg_hold_win, 1)} / ${plain(k.avg_hold_loss, 1)}`} />
        <Stat label="Final value of ₹10 L" value={rupees(k.final_equity)} sub={signedRupees(k.net_profit)} />
        <Stat label="Costs assumed" value={basis === "net" ? `${report.meta.cost_per_side_pct}% per side` : "none"} sub={BASIS_LABEL[basis]} />
      </section>

      <div role="note" className="rounded-sm border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
        <p className="font-medium text-warn">Read this before trusting the numbers</p>
        <p className="mt-1 text-paper">
          The ten best trades make {c.top10_share_pct == null ? "—" : `${c.top10_share_pct.toFixed(0)}%`} of the profit; without them the result is{" "}
          <span className="num">{signedRupees(c.pnl_without_top10)}</span> on ₹10 L (before costs). The universe is today&apos;s Chartink list, so survivorship flatters the test.
          See the Robustness and Rules tabs.
        </p>
      </div>

      <Panel title={`Portfolio value vs NIFTY 50 (${BASIS_LABEL[basis].toLowerCase()})`}>
        <div className="h-[340px]"><EChart option={eq} ariaLabel="Equity curve of the swing engine against NIFTY 50" /></div>
        <p className="mt-2 text-xs text-muted">Daily mark-to-market, start ₹10 L. Drag the slider or scroll to zoom. Data through {report.meta.data_through}.</p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Drawdown from the previous peak">
          <div className="h-[200px]"><EChart option={dd} ariaLabel="Drawdown of the swing engine" /></div>
        </Panel>
        <Panel title="Calendar-year return">
          <div className="h-[200px]"><EChart option={yr} ariaLabel="Calendar-year returns, swing engine against NIFTY 50" /></div>
        </Panel>
      </div>

      <Panel title="How trades ended (before costs)">
        <div className={TABLE_WRAP}>
          <table className="num w-full min-w-[520px] text-sm">
            <caption className="sr-only">Trades grouped by exit reason</caption>
            <thead className={THEAD}>
              <tr><th scope="col" className="px-2 py-1.5 text-left font-medium">Exit</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Trades</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Won</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Avg R</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">P&amp;L, % of ₹10 L</th></tr>
            </thead>
            <tbody>
              {[...report.by_exit_reason].sort((a, b) => b.pnl - a.pnl).map((r) => (
                <tr key={r.key} className="border-t border-rule">
                  <td className={TD_L}>{exitLabel(String(r.key))}</td>
                  <td className={TD}>{r.trades}</td>
                  <td className={TD}>{r.win_rate_pct.toFixed(0)}%</td>
                  <td className={TD}>{plain(r.avg_r)}</td>
                  <td className={`${TD} ${r.pnl >= 0 ? "text-up" : "text-down"}`}>{pct(r.pnl_pct_of_capital)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Day-1 cuts are losses taken early; the stop exits include the trailing-stop winners.</p>
      </Panel>
    </>
  );
}
