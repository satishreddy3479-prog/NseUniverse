import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { equityOption } from "../lib/chartOptions";
import { fmtDateTimeIST, fmtInt } from "../lib/format";
import type { CostModel, Leg } from "../lib/strategy";
import type { BacktestBucket, BacktestRequest } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { Button, Panel } from "./ui";

const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const field = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

function Bucket({ title, b }: { title: string; b: Record<string, BacktestBucket> }) {
  const rows = Object.entries(b);
  if (!rows.length) return null;
  return (
    <table className="w-full text-sm" aria-label={title}>
      <caption className="mb-1 text-left text-xs text-muted">{title}</caption>
      <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Group</th><th className="text-right font-normal">Trades</th><th className="text-right font-normal">Net P&L</th><th className="text-right font-normal">Win rate</th><th className="pl-3 text-left font-normal">Reliability</th></tr></thead>
      <tbody>{rows.map(([k, v]) => <tr key={k} className="num border-t border-rule/50"><td>{k}</td><td className="text-right">{v.n}</td><td className={`text-right ${tone(v.net_pnl)}`}>{money(v.net_pnl)}</td><td className="text-right">{v.win_rate}%</td><td className="pl-3 text-xs text-warn">{v.enough_data ? "" : "too few trades to conclude"}</td></tr>)}</tbody>
    </table>
  );
}

/** Historical test on the option prices this app has stored. Only controls the engine implements are shown. */
export function BacktestPanel({ legs, lotSize, atm, strikes, costs }: { legs: Leg[]; lotSize: number | null; atm: number | null; strikes: number[]; costs: CostModel }) {
  const colors = useChartColors();
  const av = useQuery({ queryKey: ["strategy-availability"], queryFn: api.strategyAvailability, retry: false, staleTime: 60_000 });
  const [expiry, setExpiry] = useState<"nearest" | "next">("nearest");
  const [entry, setEntry] = useState("09:20");
  const [exit, setExit] = useState("15:15");
  const [wait, setWait] = useState(5);
  const [sl, setSl] = useState<{ mode: "rupees" | "pct_of_premium"; value: string }>({ mode: "rupees", value: "" });
  const [tp, setTp] = useState<{ mode: "rupees" | "pct_of_premium"; value: string }>({ mode: "rupees", value: "" });
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const sorted = useMemo(() => [...strikes].sort((a, b) => a - b), [strikes]);
  const atmIdx = atm == null ? -1 : sorted.indexOf(atm);
  const specs = legs.map((l) => ({ l, off: atmIdx < 0 ? null : sorted.indexOf(l.strike) - atmIdx }));
  const blocker =
    legs.length === 0 ? "Build a strategy above first."
    : new Set(legs.map((l) => l.expiry)).size > 1 ? "The historical test supports one expiry per strategy; calendar and diagonal spreads cannot be tested yet."
    : atmIdx < 0 || specs.some((s) => s.off == null || s.off < -50 || s.off > 50) ? "Legs must sit on strikes listed in the stored chain."
    : lotSize == null ? "No lot size in the stored chain." : null;

  const req: BacktestRequest | null = blocker ? null : {
    legs: specs.map((s) => ({ type: s.l.type, action: s.l.action, lots: s.l.lots, offset_steps: s.off as number })),
    expiry, entry_time: entry, exit_time: exit, max_wait_minutes: wait,
    stop_loss: sl.value ? { mode: sl.mode, value: Number(sl.value) } : null, target: tp.value ? { mode: tp.mode, value: Number(tp.value) } : null,
    start: start || null, end: end || null,
    costs: { brokerage_per_order: costs.brokeragePerOrder, stt_sell_pct: costs.sttSellPct, exchange_pct: costs.exchangePct, sebi_pct: costs.sebiPct, stamp_buy_pct: costs.stampBuyPct, gst_pct: costs.gstPct, slippage_per_unit: costs.slippagePerUnit },
  };
  const run = useMutation({ mutationFn: (r: BacktestRequest) => api.strategyBacktest(r) });
  const res = run.data;
  const usable = av.data?.sessions.filter((s) => s.usable) ?? [];

  return (
    <Panel title="4 · Historical test on stored option prices">
      <div className="space-y-3">
        <div className="rounded-sm border border-info/40 bg-info/5 px-3 py-2 text-sm" data-testid="bt-availability">
          {av.isPending ? "Checking what option history is stored…" : av.error || !av.data ? "Could not read the stored history." : (
            <>
              <b className="text-paper">Data available:</b> {usable.length} usable session{usable.length === 1 ? "" : "s"}
              {usable.length ? ` (${usable[0]!.session}${usable.length > 1 ? ` to ${usable[usable.length - 1]!.session}` : ""})` : ""}
              {av.data.sessions.length > usable.length ? `, ${av.data.sessions.length - usable.length} with too few samples` : ""}. {av.data.source}
              <div className="mt-1 text-xs text-muted">A test over so few sessions shows how the rules behave, not whether a strategy has an edge. Option price history from before collection began is not available, so multi-year results cannot be produced.</div>
            </>
          )}
        </div>
        {blocker && <p className="text-sm text-muted" data-testid="bt-blocker">{blocker}</p>}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs text-muted">Expiry traded<select className={field} value={expiry} onChange={(e) => setExpiry(e.target.value as "nearest" | "next")} aria-label="Backtest expiry"><option value="nearest">Nearest to come</option><option value="next">The one after</option></select></label>
          <label className="flex flex-col gap-1 text-xs text-muted">Entry time (IST)<input type="time" className={field} value={entry} onChange={(e) => setEntry(e.target.value)} aria-label="Entry time" /></label>
          <label className="flex flex-col gap-1 text-xs text-muted">Exit time (IST)<input type="time" className={field} value={exit} onChange={(e) => setExit(e.target.value)} aria-label="Exit time" /></label>
          <label className="flex flex-col gap-1 text-xs text-muted" title="How long after the entry time the test may wait for a sample with every leg priced">Max wait (min)<input type="number" min={0} max={60} className={field} value={wait} onChange={(e) => setWait(Number(e.target.value))} aria-label="Max wait" /></label>
          <label className="flex flex-col gap-1 text-xs text-muted">From<input type="date" className={field} value={start} onChange={(e) => setStart(e.target.value)} aria-label="From date" /></label>
          <label className="flex flex-col gap-1 text-xs text-muted">To<input type="date" className={field} value={end} onChange={(e) => setEnd(e.target.value)} aria-label="To date" /></label>
          {([["Stop-loss", sl, setSl], ["Target", tp, setTp]] as const).map(([label, v, set]) => (
            <div key={label} className="flex gap-1 sm:col-span-3 lg:col-span-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-muted">{label} (blank = none)<input type="number" min={0} className={field} value={v.value} onChange={(e) => set({ ...v, value: e.target.value })} aria-label={label} /></label>
              <label className="flex flex-col gap-1 text-xs text-muted">Unit<select className={field} value={v.mode} onChange={(e) => set({ ...v, mode: e.target.value as "rupees" | "pct_of_premium" })} aria-label={`${label} unit`}><option value="rupees">₹ on the strategy</option><option value="pct_of_premium">% of premium traded</option></select></label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted">Each stored session is one trade: enter at the first sample at or after the entry time, check stop-loss then target on every later sample, close at the exit time. Costs and slippage come from the assumptions in section 3. Re-entry, trailing stops, indicator rules and adjustments are not implemented, so they are not offered.</p>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!req || run.isPending} onClick={() => req && run.mutate(req)}>{run.isPending ? "Running…" : "Run test"}</Button>
          {run.error && <p role="alert" className="text-sm text-down">{run.error instanceof ApiError ? run.error.message : "The test could not run."}</p>}
        </div>

        {res && (
          <div className="space-y-4" data-testid="bt-result">
            <ul className="space-y-1 text-sm text-warn">{res.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4 lg:grid-cols-6" data-testid="bt-metrics">
              {([
                ["Trades", String(res.metrics.trades)], ["Win rate", res.metrics.win_rate == null ? "—" : `${res.metrics.win_rate}%`], ["Wins / losses", `${res.metrics.wins} / ${res.metrics.losses}`],
                ["Gross P&L", money(res.metrics.gross_pnl), res.metrics.gross_pnl], ["Net P&L (after costs)", money(res.metrics.net_pnl), res.metrics.net_pnl], ["Average trade", money(res.metrics.avg_trade), res.metrics.avg_trade],
                ["Average win", money(res.metrics.avg_win), res.metrics.avg_win], ["Average loss", money(res.metrics.avg_loss), res.metrics.avg_loss], ["Profit factor", res.metrics.profit_factor == null ? "—" : res.metrics.profit_factor.toFixed(2)],
                ["Max drawdown", money(-res.metrics.max_drawdown), -res.metrics.max_drawdown], ["Largest win", money(res.metrics.largest_win), res.metrics.largest_win], ["Largest loss", money(res.metrics.largest_loss), res.metrics.largest_loss],
                ["Avg holding (min)", res.metrics.avg_minutes_held == null ? "—" : String(res.metrics.avg_minutes_held)],
              ] as [string, string, number?][]).map(([k, v, t]) => <div key={k} className="border-b border-rule/50 py-1"><dt className="text-xs text-muted">{k}</dt><dd className={`num text-[15px] font-medium ${t == null ? "text-paper" : tone(t)}`}>{v}</dd></div>)}
            </dl>
            {res.metrics.sharpe_note && <p className="text-xs text-muted">Risk-adjusted ratio {res.metrics.sharpe_note}.</p>}
            {res.equity_curve.length > 0 && <div className="h-[220px]"><EChart option={equityOption(res.equity_curve, colors)} ariaLabel="Equity curve" /></div>}
            <div className="grid gap-4 lg:grid-cols-2">
              <Bucket title="Expiry day versus other days" b={res.by_expiry_day} />
              <Bucket title="Direction of NIFTY between entry and exit (known only afterwards)" b={res.by_day_direction} />
            </div>
            <p className="text-xs text-muted">{res.regime_note}</p>
            {Object.keys(res.monthly_net).length > 0 && <p className="text-sm">Monthly net: {Object.entries(res.monthly_net).map(([m, v]) => <span key={m} className="mr-3 num">{m} <span className={tone(v)}>{money(v)}</span></span>)}</p>}
            {res.trades.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="Backtest trades">
                  <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Session</th><th className="text-left font-normal">Entry</th><th className="text-left font-normal">Exit</th><th className="text-left font-normal">Why</th><th className="text-left font-normal">Legs (entry → exit)</th><th className="text-right font-normal">Gross</th><th className="text-right font-normal">Costs</th><th className="text-right font-normal">Net</th></tr></thead>
                  <tbody>{res.trades.map((t) => (
                    <tr key={t.session} className="num border-t border-rule/50">
                      <td>{t.session}</td><td>{fmtDateTimeIST(t.entry_at)}</td><td>{fmtDateTimeIST(t.exit_at)}</td>
                      <td>{t.exit_reason === "time" ? "exit time" : t.exit_reason === "stop_loss" ? "stop-loss" : "target"}{t.samples_skipped_missing_price ? ` · ${t.samples_skipped_missing_price} unpriced sample(s) skipped` : ""}</td>
                      <td className="text-xs">{t.legs.map((g) => `${g.action} ${g.lots}× ${g.strike}${g.type} ${g.entry} → ${g.exit}`).join("; ")}</td>
                      <td className={`text-right ${tone(t.gross)}`}>{money(t.gross)}</td><td className="text-right text-muted">{money(-t.costs)}</td><td className={`text-right ${tone(t.net)}`}>{money(t.net)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
            {[...res.skipped_sessions, ...res.unpriced_sessions].length > 0 && (
              <details><summary className="cursor-pointer text-sm text-info">Sessions not traded ({res.skipped_sessions.length + res.unpriced_sessions.length})</summary>
                <ul className="mt-1 space-y-0.5 text-xs text-muted">{[...res.skipped_sessions, ...res.unpriced_sessions].map((s) => <li key={s.session + s.reason}><span className="num text-paper">{s.session}</span>: {s.reason}</li>)}</ul></details>
            )}
            <p className="text-[11px] text-muted" data-testid="bt-repro">Reproducible: configuration {res.config_hash}, stored data {res.data_fingerprint}, {res.data.sessions_with_enough_samples.length} session(s). Prices: {res.data.price_source}.</p>
          </div>
        )}
      </div>
    </Panel>
  );
}
