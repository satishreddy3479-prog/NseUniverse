import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ForwardOverview, type ForwardPortfolioTrade, type ForwardVariant } from "../lib/api";
import { fmtAge, MISSING } from "../lib/format";
import { EQUITY_HEIGHT, portfolioEquityOption } from "../lib/portfolioCharts";
import { portfolioStats, type PortfolioStats } from "../lib/portfolioStats";
import { EChart, useChartColors } from "./EChart";

const IST = "Asia/Kolkata";
const inr = (v: number | null | undefined, signed = true) => (v == null ? MISSING : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const when = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso)) : MISSING);
const clock = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));

/** The exit rules in the order of the filter, with the short text of their chip. */
const RULES: [string, string][] = [
  ["hold", "No stop"], ["leg30", "Stop 30%"], ["leg40", "Stop 40%"], ["leg50", "Stop 50%"], ["leg60", "Stop 60%"], ["leg70", "Stop 70%"], ["leg80", "Stop 80%"],
  ["leg40_cost", "40% + cost"], ["comb15", "Combined +15%"], ["comb25", "Combined +25%"], ["comb40", "Combined +40%"],
];

const Loading = () => <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
const Panel = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section aria-label={title} className="rounded-[var(--radius-panel)] border border-rule bg-slate">
    <header className="border-b border-rule px-3 py-2"><h2 className="text-sm font-semibold">{title}</h2>{hint && <p className="text-xs text-muted">{hint}</p>}</header>
    <div className="p-2">{children}</div>
  </section>
);
function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([v, text]) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
            className={`min-h-9 rounded-sm border px-3 text-sm ${value === v ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{text}</button>
        ))}
      </div>
    </div>
  );
}
const Item = ({ label, value, sub, cls = "text-paper" }: { label: string; value: string; sub?: string; cls?: string }) => (
  <div className="min-w-0 rounded-sm border border-rule bg-slate-2/60 px-3 py-2">
    <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
    <div className={`num truncate text-base font-semibold ${cls}`}>{value}</div>
    {sub && <div className="break-words text-[11px] leading-snug text-muted" title={sub}>{sub}</div>}
  </div>
);

/** Measures of the closed trades that `portfolioStats` does not give: the smallest win and loss, the stop-hit rate and the average dip while open. */
function extras(rows: ForwardPortfolioTrade[]) {
  const wins = rows.filter((r) => r.net > 0), losses = rows.filter((r) => r.net < 0);
  const dips = rows.map((r) => r.worst).filter((v): v is number => v != null);
  return {
    lowestWin: wins.length ? Math.min(...wins.map((r) => r.net)) : null,
    smallestLoss: losses.length ? Math.max(...losses.map((r) => r.net)) : null,
    stopRate: rows.length ? (rows.filter((r) => r.stopped_at).length / rows.length) * 100 : null,
    avgDip: dips.length ? dips.reduce((a, b) => a + b, 0) / dips.length : null,
  };
}

function Stats({ s, rows }: { s: PortfolioStats; rows: ForwardPortfolioTrade[] }) {
  const x = extras(rows);
  const pct = (v: number | null) => (v == null ? MISSING : `${v.toFixed(1)}%`);
  const lossRate = s.count ? (s.losses / s.count) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="forward-stats">
      <Item label="Net P&L" value={inr(s.total)} sub={`${s.count} closed trades`} cls={tone(s.total)} />
      <Item label="Trades" value={String(s.count)} sub={`${s.wins} won · ${s.losses} lost${s.flat ? ` · ${s.flat} flat` : ""}`} />
      <Item label="Win rate" value={pct(s.winRate)} sub={`${s.wins} of ${s.count}`} cls="text-up" />
      <Item label="Loss rate" value={pct(lossRate)} sub={`${s.losses} of ${s.count}`} cls="text-down" />
      <Item label="Max drawdown" value={inr(-s.maxDrawdown, false)} sub={s.maxDrawdown > 0 ? "fall from the highest P&L reached" : "no fall yet"} cls={s.maxDrawdown > 0 ? "text-down" : "text-paper"} />
      <Item label="Current drawdown" value={inr(-s.currentDrawdown, false)} sub={s.currentDrawdown === 0 ? "at a new high" : `${s.drawdownTrades} trades under the peak`} cls={s.currentDrawdown > 0 ? "text-down" : "text-up"} />
      <Item label="Highest win" value={s.best ? inr(s.best.pnl) : MISSING} sub={s.best?.name} cls="text-up" />
      <Item label="Lowest win" value={inr(x.lowestWin)} sub="smallest winning trade" cls="text-up" />
      <Item label="Highest loss" value={s.worst ? inr(s.worst.pnl) : MISSING} sub={s.worst?.name} cls="text-down" />
      <Item label="Lowest loss" value={inr(x.smallestLoss)} sub="smallest losing trade" cls="text-down" />
      <Item label="Longest win streak" value={String(s.longestWin)} sub={s.current?.kind === "win" ? `now ${s.current.length} in a row` : undefined} cls="text-up" />
      <Item label="Longest loss streak" value={String(s.longestLoss)} sub={s.current?.kind === "loss" ? `now ${s.current.length} in a row` : undefined} cls="text-down" />
      <Item label="Average win / loss" value={`${inr(s.avgWin)} / ${inr(s.avgLoss)}`} sub={s.payoff == null ? "needs a win and a loss" : `payoff ${s.payoff.toFixed(2)} : 1`} />
      <Item label="Profit factor" value={s.profitFactor == null ? MISSING : s.profitFactor.toFixed(2)} sub={s.profitFactor == null ? "needs a loss and a win" : "gross profit / gross loss"} />
      <Item label="Expectancy" value={inr(s.expectancy)} sub="average per trade" cls={tone(s.expectancy)} />
      <Item label="Recovery factor" value={s.recoveryFactor == null ? MISSING : s.recoveryFactor.toFixed(2)} sub={s.recoveryFactor == null ? "needs a drawdown" : "net P&L / max drawdown"} />
      <Item label="Stop hit rate" value={pct(x.stopRate)} sub="trades where a stop fired" />
      <Item label="Average dip while open" value={inr(x.avgDip)} sub="deepest point of a trade, on average" cls="text-down" />
      <Item label="Best day" value={s.bestDay ? inr(s.bestDay.pnl) : MISSING} sub={s.bestDay?.day} cls="text-up" />
      <Item label="Worst day" value={s.worstDay ? inr(s.worstDay.pnl) : MISSING} sub={s.worstDay?.day} cls="text-down" />
    </div>
  );
}

function Equity({ s }: { s: PortfolioStats }) {
  const colors = useChartColors();
  const option = useMemo(() => portfolioEquityOption(s, colors), [s, colors]);
  if (s.count === 0) return <p className="p-3 text-sm text-muted">No closed trade for this selection yet.</p>;
  return <div className="w-full" style={{ height: EQUITY_HEIGHT }} data-testid="forward-equity"><EChart option={option} ariaLabel="Cumulative net P&L of the selected trades, the result of each trade and drawdown" /></div>;
}

function Log({ rows, s }: { rows: ForwardPortfolioTrade[]; s: PortfolioStats }) {
  if (rows.length === 0) return <p className="p-3 text-sm text-muted">No closed trade for this selection yet.</p>;
  const cum = new Map(rows.map((r, i) => [r.id, s.curve[i]?.cum ?? null]));
  const shown = [...rows].reverse().slice(0, 200);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm" aria-label="Closed trades">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr><th className="px-2 py-1.5">Opened</th><th className="px-2">Expiry</th><th className="px-2">Sold</th><th className="px-2 text-right">Premium</th><th className="px-2">Exit</th><th className="px-2 text-right">NIFTY move</th><th className="px-2 text-right">Dip</th><th className="px-2 text-right">Net P&L</th><th className="px-2 text-right">Cumulative</th></tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="border-t border-rule">
              <td className="whitespace-nowrap px-2 py-1.5">{when(r.trigger_at)}<div className="text-[11px] text-muted">seller {r.seller ?? MISSING} · {r.regime ?? "no regime"}</div></td>
              <td className="px-2 capitalize">{r.cohort} #{r.n}<div className="text-[11px] text-muted">{r.expiry}</div></td>
              <td className="px-2 tabular-nums">{r.ce_strike === r.pe_strike ? `${r.ce_strike} CE + PE` : `${r.ce_strike} CE + ${r.pe_strike} PE`}<div className="text-[11px] capitalize text-muted">{r.structure}</div></td>
              <td className="px-2 text-right tabular-nums">{(r.ce0 + r.pe0).toFixed(1)}<div className="text-[11px] text-muted">{r.ce0} + {r.pe0}</div></td>
              <td className="px-2">{r.reason}<div className="text-[11px] text-muted">{r.stopped_at ? `stop at ${r.stopped_at} · ` : ""}CE {r.ce_exit.toFixed(1)} · PE {r.pe_exit.toFixed(1)}</div></td>
              <td className="px-2 text-right tabular-nums">{r.net_move == null ? MISSING : `${r.net_move > 0 ? "+" : ""}${r.net_move.toFixed(0)}`}</td>
              <td className={`px-2 text-right tabular-nums ${tone(r.worst)}`}>{inr(r.worst, false)}</td>
              <td className={`px-2 text-right font-semibold tabular-nums ${tone(r.net)}`}>{inr(r.net)}<div className="text-[11px] font-normal text-muted">{r.gross != null ? `${inr(r.gross)} − ₹${Math.round(r.cost)}` : ""}</div></td>
              <td className={`px-2 text-right tabular-nums ${tone(cum.get(r.id))}`}>{inr(cum.get(r.id))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <p className="px-2 py-1 text-xs text-muted">The newest 200 of {rows.length} trades are listed; the statistics use all of them.</p>}
    </div>
  );
}

function Compare({ rules, selected, onPick, min }: { rules: ForwardVariant[]; selected: string; onPick: (r: string) => void; min: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-sm" aria-label="Stop-loss rules compared">
        <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-1.5">Rule</th><th className="px-2 text-right">Trades</th><th className="px-2 text-right">Win %</th><th className="px-2 text-right">Net P&L</th><th className="px-2 text-right">Average</th><th className="px-2 text-right">Max drawdown</th><th className="px-2 text-right">Profit factor</th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.variant} className={`cursor-pointer border-t border-rule hover:bg-slate-2/60 ${selected === r.variant ? "bg-brass/10" : ""}`} onClick={() => onPick(r.variant)} tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onPick(r.variant); }} aria-label={`Show the portfolio of ${r.label}`} aria-current={selected === r.variant}>
              <td className="px-2 py-1.5 font-medium">{r.label}{r.n > 0 && r.n < min && <span className="ml-2 rounded-full border border-rule px-1.5 text-[10px] text-warn">too few</span>}</td>
              <td className="px-2 text-right tabular-nums">{r.n}</td>
              <td className="px-2 text-right tabular-nums">{r.n ? `${r.win_rate}%` : MISSING}</td>
              <td className={`px-2 text-right font-semibold tabular-nums ${tone(r.total)}`}>{inr(r.total)}</td>
              <td className={`px-2 text-right tabular-nums ${tone(r.avg)}`}>{inr(r.avg)}</td>
              <td className={`px-2 text-right tabular-nums ${tone(r.max_drawdown)}`}>{inr(r.max_drawdown, false)}</td>
              <td className="px-2 text-right tabular-nums">{r.profit_factor == null ? MISSING : r.profit_factor}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-2 pt-1 text-xs text-muted">Same entries, different stop-loss rules, for the structure and expiry chosen above. Click a row to see that rule's portfolio.</p>
    </div>
  );
}

function Breakdown({ o, dim, setDim }: { o: ForwardOverview; dim: string; setDim: (d: string) => void }) {
  const b = o.breakdown;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
        <label className="flex items-center gap-2 text-sm text-muted">Break down by
          <select aria-label="Break down by" value={dim} onChange={(e) => setDim(e.target.value)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
            {Object.entries(b.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <span className="text-xs text-muted">For the selected stop-loss rule. A row with fewer than {b.min_trades} trades is marked too few.</span>
      </div>
      {b.rows.length === 0 ? <p className="p-3 text-sm text-muted">Nothing to break down yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" aria-label="Breakdown">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-1.5">{b.title}</th><th className="px-2 text-right">Trades</th><th className="px-2 text-right">Win %</th><th className="px-2 text-right">Average</th><th className="px-2 text-right">Net P&L</th><th className="px-2 text-right">Worst trade</th><th className="px-2 text-right">Stopped %</th></tr></thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.bucket} className="border-t border-rule">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">{r.bucket}{r.n < b.min_trades && <span className="ml-2 text-[11px] font-normal text-warn">too few</span>}</th>
                  <td className="px-2 text-right tabular-nums">{r.n}</td>
                  <td className="px-2 text-right tabular-nums">{r.win_rate == null ? MISSING : `${r.win_rate}%`}</td>
                  <td className={`px-2 text-right tabular-nums ${tone(r.avg)}`}>{inr(r.avg)}</td>
                  <td className={`px-2 text-right font-semibold tabular-nums ${tone(r.total)}`}>{inr(r.total)}</td>
                  <td className={`px-2 text-right tabular-nums ${tone(r.worst)}`}>{inr(r.worst)}</td>
                  <td className="px-2 text-right tabular-nums">{r.stop_rate == null ? MISSING : `${r.stop_rate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OpenNow({ o }: { o: ForwardOverview }) {
  const rule = o.filters.rule;
  if (o.open.length === 0) return <p className="p-3 text-sm text-muted">No open position. One opens the first time the seller score of the weekly or monthly expiry reaches 60 between 09:30 and 14:30; it closes at 15:20.</p>;
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {o.open.map((t) => {
        const m = t.variants[rule];
        return (
          <div key={t.id} className="rounded-sm border border-rule bg-slate-2 p-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <span className="font-semibold capitalize">{t.structure} · {t.cohort} · #{t.n}</span>
              <span className={`num font-semibold ${tone(m?.pnl)}`}>{m?.stopped_at ? "✕ " : ""}{inr(m?.pnl)}</span>
            </div>
            <div className="text-xs text-muted">Sold {t.ce_strike === t.pe_strike ? `${t.ce_strike} CE + PE` : `${t.ce_strike} CE + ${t.pe_strike} PE`} at {t.ce0} + {t.pe0} = {(t.ce0 + t.pe0).toFixed(2)} · opened {clock(t.trigger_at)} · seller {t.seller ?? MISSING} · NIFTY {t.spot0.toFixed(0)} → {t.spot == null ? MISSING : t.spot.toFixed(0)}</div>
            {m?.stopped_at && <div className="text-xs text-warn">A stop fired at {m.stopped_at} ({m.ce_open ? "call" : "put"}{!m.ce_open && !m.pe_open ? " and put" : ""} closed).</div>}
          </div>
        );
      })}
    </div>
  );
}

/** The forward test as a portfolio: pick the structure, the expiry and one stop-loss rule, and the page shows that rule's closed trades as a portfolio (equity curve, win and loss rates,
 *  drawdown, best and worst trades, streaks) with the rules compared and a breakdown by regime. Paper only. */
export function ForwardBody() {
  const [structure, setStructure] = useState<"all" | "straddle" | "strangle">("straddle");
  const [cohort, setCohort] = useState<"all" | "weekly" | "monthly">("all");
  const [rule, setRule] = useState("hold");
  const [dim, setDim] = useState("regime");
  const q = useQuery({ queryKey: ["forward", structure, cohort, rule, dim], queryFn: () => api.forward(structure, cohort, rule, dim), refetchInterval: 60_000, retry: false, placeholderData: (p) => p });
  const rows = q.data?.portfolio ?? [];
  const stats = useMemo(() => portfolioStats(rows.map((r) => ({ id: String(r.id), name: `${r.cohort} ${r.structure} #${r.n}, ${when(r.trigger_at)}`, closedAt: r.settled_at ?? r.trigger_at, pnl: r.net })), null), [rows]);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The forward test could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const o = q.data;
  const c = o.meta.counts;
  const min = o.meta.min_trades;
  const structureText = structure === "all" ? "Straddle and strangle" : structure === "straddle" ? "ATM straddle" : "Strangle ±50";
  const cohortText = cohort === "all" ? "weekly and monthly expiry" : `${cohort} expiry`;
  return (
    <div className="flex flex-col gap-3">
      <div role="note" className="rounded-sm border border-rule bg-slate p-3 text-sm">
        <div className="font-semibold">Paper portfolio, nothing is sent to a broker</div>
        <p className="mt-0.5 text-muted">Whenever the seller score of an expiry reaches 60 ({o.meta.setup.entry_window}), a short ATM straddle and a short strangle (call 50 above, put 50 below) are opened at the last traded prices of the newest stored sample, for the weekly and the monthly expiry; all close at 15:20 IST. After a trade the next one waits until the score has been below 60 for 30 minutes (at most 3 a day per expiry). Each stop-loss rule runs on the same entries. One lot of {o.meta.setup.lot}, after estimated charges.</p>
        <p className="mt-1 text-xs text-muted">
          {c.settled} settled · {c.open} open · {c.days} days · last check {o.meta.last_tick ? clock(o.meta.last_tick) + " IST" : "not yet"}{o.meta.last_error ? ` · last error: ${o.meta.last_error}` : ""}{!o.meta.enabled && " · switched off in the settings"}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-rule bg-slate p-3" aria-label="Filters">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Chips label="Structure" value={structure} onChange={setStructure} options={[["straddle", "Straddle"], ["strangle", "Strangle ±50"], ["all", "Both"]]} />
          <Chips label="Expiry" value={cohort} onChange={setCohort} options={[["all", "All"], ["weekly", "Weekly"], ["monthly", "Monthly"]]} />
        </div>
        <Chips label="Stop loss" value={rule} onChange={setRule} options={RULES} />
        <p className="text-xs text-muted" data-testid="forward-selection">Showing: <b className="text-paper">{structureText}</b> · {cohortText} · <b className="text-paper">{o.filters.rule_label}</b></p>
      </div>

      {stats.count < min && (
        <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">{stats.count === 0 ? "No closed trade for this selection yet. " : `Only ${stats.count} closed trade${stats.count === 1 ? "" : "s"} in this selection: `}below about {min} the figures swing on single days and say little about a rule. It builds up by itself, up to 12 positions a day when the score reaches 60.</p>
      )}
      <Panel title="Portfolio statistics" hint={`${structureText}, ${cohortText}, ${o.filters.rule_label}`}><Stats s={stats} rows={rows} /></Panel>
      <Panel title="Equity and drawdown" hint="Cumulative net P&L after each closed trade, the result of each trade, and the fall from the highest point."><Equity s={stats} /></Panel>
      <Panel title="Open now" hint="Marked at the last stored prices, before charges, for the selected stop-loss rule."><OpenNow o={o} /></Panel>
      <Panel title="Stop-loss rules compared" hint="Net of estimated charges, one lot."><Compare rules={o.rules} selected={o.filters.rule} onPick={setRule} min={min} /></Panel>
      <Panel title="By market regime and other conditions" hint="Where the selected rule works and where it does not."><Breakdown o={o} dim={dim} setDim={setDim} /></Panel>
      <Panel title="Closed trades" hint="Newest first."><Log rows={rows} s={stats} /></Panel>
      <p className="text-xs text-muted">
        Prices are the last traded prices of the stored one-minute samples (no bid or ask), and a stop is checked on each sample, so a touch between two samples is not seen. Charges are an estimate. Trades are intraday: they say nothing about holding overnight, gaps or expiry-day gamma. Trades are listed in the order they were opened, and trades that open together (a straddle and a strangle, weekly and monthly) follow one another in the streaks. Generated {fmtAge((Date.now() - new Date(o.generated_at).getTime()) / 1000)}.
      </p>
    </div>
  );
}
