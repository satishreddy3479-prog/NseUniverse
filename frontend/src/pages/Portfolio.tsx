import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { mergeRows, type LiveMode } from "../components/ChainTable";
import { useThrottledVersion } from "../components/dashboard/DashContext";
import { EChart, useChartColors } from "../components/EChart";
import { Info } from "../components/Info";
import { Panel } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTimeIST, fmtInt } from "../lib/format";
import { portfolioStats, type PortfolioStats } from "../lib/portfolioStats";
import { EQUITY_HEIGHT, portfolioEquityOption } from "../lib/portfolioCharts";
import { isExited, strategyPnl, type Leg, type OptionType } from "../lib/strategy";
import { useStreamStatus } from "../lib/useLive";
import { CLOSED_KEY, SAVE_KEY, WORKING_KEY, type Closed, type Saved } from "./StrategyBuilder";

const money = (v: number | null, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");

function readLocal<T>(key: string): T[] { try { return JSON.parse(localStorage.getItem(key) ?? "[]") as T[]; } catch { return []; } }
type Working = { legs: Leg[]; expiry: string | null; name: string; loaded: string | null; baseline: Leg[]; at: number };
function readWorking(): Working | null { try { const w = JSON.parse(localStorage.getItem(WORKING_KEY) ?? "null") as Working | null; return w && Array.isArray(w.legs) ? w : null; } catch { return null; } }

/** The strategy builder's positions in one place: live mark-to-market of every running strategy and the booked P&L of closed ones. */
export function Portfolio() {
  const navigate = useNavigate();
  const server = useQuery({ queryKey: ["portfolio-strategies"], queryFn: api.strategies, refetchInterval: 15_000, retry: false });
  // the server's list when it answers, otherwise this browser's copy (the builder keeps both in step)
  const saved = (server.data?.saved as unknown as Saved[] | undefined) ?? readLocal<Saved>(SAVE_KEY);
  const closed = (server.data?.closed as unknown as Closed[] | undefined) ?? readLocal<Closed>(CLOSED_KEY);
  const working = readWorking();
  const draft = working && working.expiry && working.legs.some((l) => !isExited(l)) && !working.loaded ? working : null;

  const expiries = useMemo(() => [...new Set([...saved.map((s) => s.expiry), ...(draft?.expiry ? [draft.expiry] : [])])].sort(), [saved, draft?.expiry]);
  const chains = useQueries({ queries: expiries.map((e) => ({ queryKey: ["chain", e], queryFn: () => api.optionChain(e), refetchInterval: 15_000, retry: false })) });
  const { stream } = useStreamStatus();
  const streamActive = !!stream && ["streaming", "waiting_for_data", "reconnecting"].includes(stream.state);
  const version = useThrottledVersion(400);
  const books = useMemo(() => {
    const out = new Map<string, { priceOf: (k: number, t: OptionType) => number | null; lot: number | null; live: boolean; at: string | null }>();
    expiries.forEach((e, i) => {
      const snap = chains[i]?.data?.snapshot;
      if (!snap) { out.set(e, { priceOf: () => null, lot: null, live: false, at: null }); return; }
      const mode: LiveMode = !streamActive ? "off" : stream?.effective_state === "streaming" ? "fresh" : "stale";
      const rows = mergeRows(snap.rows, mode);
      out.set(e, {
        lot: snap.lot_size, live: mode === "fresh", at: snap.retrieved_at,
        priceOf: (k, t) => { const q = rows.find((r) => r.strike === k); const x = t === "CE" ? q?.call : q?.put; return x?.ltp != null && x.ltp > 0 ? x.ltp : null; },
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiries, chains.map((c) => c.dataUpdatedAt).join(","), streamActive, stream?.effective_state, version]);

  const rows = useMemo(() => {
    const mk = (name: string, expiry: string, legs: Leg[], key: string, isDraft: boolean) => {
      const b = books.get(expiry);
      const p = b?.lot ? strategyPnl(legs, b.priceOf, b.lot) : { booked: legs.reduce((t, l) => t + (l.realised ?? 0), 0), open: null as number | null, total: null as number | null, openLegs: legs.filter((l) => l.enabled !== false && !isExited(l)).length };
      return { key, name, expiry, legs: legs.filter((l) => l.enabled !== false).length, ...p, live: !!b?.live, at: b?.at ?? null, isDraft };
    };
    const list = saved.map((s) => mk(s.name, s.expiry, s.legs, `s-${s.name}`, false)).filter((r) => r.openLegs > 0);
    if (draft?.expiry) list.unshift(mk(draft.name || "Current strategy (not saved)", draft.expiry, draft.legs, "draft", true));
    return list;
  }, [saved, draft, books]);

  const knownTotals = rows.filter((r) => r.total != null);
  const runningTotal = knownTotals.reduce((t, r) => t + (r.total as number), 0);
  const closedTotal = closed.reduce((t, c) => t + c.pnl, 0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [capital, setCapital] = useState<number | null>(() => { try { const v = Number(localStorage.getItem("nse.portfolio.capital.v1")); return v > 0 ? v : null; } catch { return null; } });
  const stats = useMemo(() => portfolioStats(closed.map((c) => ({ id: c.id, name: c.name, closedAt: c.closedAt, pnl: c.pnl })), capital), [closed, capital]);
  const cumulative = useMemo(() => new Map(stats.curve.map((p, i) => [stats.curve[i]!.label + p.name, p.cum])), [stats]);

  const openInBuilder = (r: (typeof rows)[number]) => {
    if (!r.isDraft) {
      const s = saved.find((x) => x.name === r.name)!;
      if (draft && confirm !== r.key) { setConfirm(r.key); return; } // an unsaved strategy is in the builder: ask once before replacing it
      try { localStorage.setItem(WORKING_KEY, JSON.stringify({ legs: s.legs, expiry: s.expiry, name: "", loaded: s.name, baseline: s.legs, at: Date.now() })); } catch { /* the builder then opens as it was */ }
    }
    navigate("/strategy");
  };

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <h1 className="text-xl font-semibold">Strategy portfolio</h1>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="portfolio-tiles">
        <Tile label="Running strategies (live)" value={money(knownTotals.length ? runningTotal : null)} cls={tone(knownTotals.length ? runningTotal : null)}
          sub={`${rows.length} running${rows.length > knownTotals.length ? ` · ${rows.length - knownTotals.length} without a price` : ""}`} />
        <Tile label="Closed strategies" value={money(closedTotal)} cls={tone(closedTotal)} sub={`${closed.length} closed`} />
        <Tile label="Total P&L" value={money(knownTotals.length || closed.length ? runningTotal + closedTotal : null)} cls={tone(runningTotal + closedTotal)} sub="running + closed" />
        <Tile label="Booked in running" value={money(rows.reduce((t, r) => t + r.booked, 0))} cls={tone(rows.reduce((t, r) => t + r.booked, 0))} sub="exits, stops, targets, rolls" />
      </div>

      <Panel title="Running strategies">
        {rows.length === 0 ? <p className="text-sm text-muted">No running strategy. Build one in the Strategy builder and save it; it appears here with its live profit or loss.</p> : (
          <div className="overflow-x-auto" data-testid="portfolio-running">
            <table className="w-full text-sm" aria-label="Running strategies">
              <thead className="text-xs text-muted"><tr>{["Strategy", "Expiry", "Legs open", "Booked", "Open P&L", "MTM (total)", "Prices"].map((h) => <th key={h} className="px-2 py-1 text-left font-normal first:pl-0">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="cursor-pointer border-t border-rule/50 hover:bg-slate-2/60" onClick={() => openInBuilder(r)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") openInBuilder(r); }} aria-label={`Open ${r.name} in the strategy builder`}>
                    <td className="py-2 pr-2 text-paper">{r.name}{r.isDraft && <span className="ml-2 rounded-sm border border-warn/50 px-1 text-[10px] text-warn">not saved</span>}
                      {confirm === r.key && <div className="text-[11px] text-warn">An unsaved strategy is open in the builder; click again to replace it.</div>}</td>
                    <td className="num px-2">{r.expiry}</td>
                    <td className="num px-2">{r.openLegs} of {r.legs}</td>
                    <td className={`num px-2 ${tone(r.booked)}`}>{money(r.booked)}</td>
                    <td className={`num px-2 ${tone(r.open)}`}>{money(r.open)}</td>
                    <td className={`num px-2 font-semibold ${tone(r.total)}`}>{money(r.total)}</td>
                    <td className="px-2 text-xs text-muted">{r.live ? <span className="text-up">live</span> : r.at ? `stored ${fmtDateTimeIST(r.at)}` : "no chain"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">Click a row to open the strategy in the builder for adjustments. Open P&L is each open leg's price against its entry premium; booked is what exits, stops, targets and rolls already realised. Where a price is missing the open P&L is shown as — and is not counted.</p>
          </div>
        )}
      </Panel>

      <Panel title="Performance of closed strategies" actions={
        <label className="flex items-center gap-2 text-xs text-muted">Capital for % figures (₹)
          <input aria-label="Capital for percentage figures" inputMode="numeric" className="num w-28 rounded-sm border border-rule bg-slate-2 px-2 py-1 text-right text-paper"
            placeholder="optional" defaultValue={capital ?? ""} onBlur={(e) => { const v = Number(e.target.value.replace(/,/g, "")); const next = v > 0 ? v : null; setCapital(next); try { next ? localStorage.setItem("nse.portfolio.capital.v1", String(next)) : localStorage.removeItem("nse.portfolio.capital.v1"); } catch { /* this visit only */ } }} />
        </label>}>
        {stats.count === 0 ? <p className="text-sm text-muted" data-testid="portfolio-stats-empty">No closed strategy yet. These figures are computed only from strategies you have closed (their booked P&L); nothing is estimated.</p> : <PerformancePanel stats={stats} capital={capital} runningTotal={knownTotals.length ? runningTotal : null} />}
      </Panel>

      <Panel title="Closed strategies">
        {closed.length === 0 ? <p className="text-sm text-muted">Nothing closed yet. Exit all in the strategy builder moves a strategy here.</p> : (
          <div className="overflow-x-auto" data-testid="portfolio-closed">
            <table className="w-full text-sm" aria-label="Closed strategies">
              <thead className="text-xs text-muted"><tr>{["Strategy", "Closed", "Legs", "Realised P&L", "Cumulative"].map((h) => <th key={h} className="px-2 py-1 text-left font-normal first:pl-0">{h}</th>)}</tr></thead>
              <tbody>
                {closed.map((c) => (
                  <tr key={c.id} className="border-t border-rule/50">
                    <td className="py-2 pr-2 text-paper">{c.name}</td>
                    <td className="num px-2 text-xs">{fmtDateTimeIST(c.closedAt)}</td>
                    <td className="num px-2">{c.legs.length}</td>
                    <td className={`num px-2 font-semibold ${tone(c.pnl)}`}>{money(c.pnl)}{c.stale && <span className="ml-2 text-xs font-normal text-warn" title="Exit prices were stored prices, not live">stale prices</span>}</td>
                    <td className={`num px-2 ${tone(cumulative.get(c.closedAt + c.name) ?? null)}`}>{money(cumulative.get(c.closedAt + c.name) ?? null)}</td>
                  </tr>
                ))}
                <tr className="border-t border-rule"><td colSpan={3} className="py-2 text-right text-xs text-muted">Total</td><td className={`num px-2 font-semibold ${tone(closedTotal)}`}>{money(closedTotal)}</td><td /></tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Tile({ label, value, sub, cls = "text-paper" }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-rule bg-slate-2/60 px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted">{label}<Info term={label} /></div>
      <div className={`num truncate text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="break-words text-[11px] leading-snug text-muted" title={sub}>{sub}</div>}
    </div>
  );
}


function PerformancePanel({ stats, capital, runningTotal }: { stats: PortfolioStats; capital: number | null; runningTotal: number | null }) {
  const colors = useChartColors();
  const pctOf = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
  const opt = useMemo(() => portfolioEquityOption(stats, colors), [stats, colors]);
  const item = (label: string, value: string, sub?: string, cls = "text-paper") => (
    <div key={label} className="rounded-sm border border-rule bg-slate-2/60 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num text-base font-semibold ${cls}`}>{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>
  );
  const s = stats;
  return (
    <div className="flex flex-col gap-3" data-testid="portfolio-stats">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {item("Net P&L (closed)", money(s.total), capital ? `${s.returnPct?.toFixed(2)}% of capital` : "no capital entered", tone(s.total))}
        {item("Win rate", pctOf(s.winRate), `${s.wins} won · ${s.losses} lost${s.flat ? ` · ${s.flat} flat` : ""}`)}
        {item("Expectancy", money(s.expectancy), "average per closed strategy", tone(s.expectancy))}
        {item("Profit factor", s.profitFactor == null ? "—" : s.profitFactor.toFixed(2), s.profitFactor == null ? "needs a loss and a win" : `${money(s.grossProfit)} / ${money(Math.abs(s.grossLoss), false)}`)}
        {item("Average win / loss", `${money(s.avgWin)} / ${money(s.avgLoss)}`, s.payoff == null ? "needs a win and a loss" : `payoff ${s.payoff.toFixed(2)} : 1`)}
        {item("Max drawdown", money(-s.maxDrawdown, false), capital ? `${pctOf(s.maxDrawdownPct)} of capital` : "from the highest P&L reached", s.maxDrawdown > 0 ? "text-down" : "text-paper")}
        {item("Best strategy", s.best ? money(s.best.pnl) : "—", s.best?.name, "text-up")}
        {item("Worst strategy", s.worst ? money(s.worst.pnl) : "—", s.worst?.name, "text-down")}
        {item("Longest win streak", String(s.longestWin), s.current?.kind === "win" ? `now ${s.current.length} in a row` : undefined, "text-up")}
        {item("Longest loss streak", String(s.longestLoss), s.current?.kind === "loss" ? `now ${s.current.length} in a row` : undefined, "text-down")}
        {item("Current drawdown", money(-s.currentDrawdown, false), s.currentDrawdown === 0 ? "at a new high" : `${s.drawdownTrades} closes under the peak`, s.currentDrawdown > 0 ? "text-down" : "text-up")}
        {item("Recovery factor", s.recoveryFactor == null ? "—" : s.recoveryFactor.toFixed(2), s.recoveryFactor == null ? "needs a drawdown" : "net P&L / max drawdown")}
      </div>
      <div className="w-full" style={{ height: EQUITY_HEIGHT }} data-testid="portfolio-equity"><EChart option={opt} ariaLabel="Cumulative closed P&L, the result of each closed strategy, and drawdown" /></div>
      <p className="text-[11px] text-muted">
        Computed only from the {s.count} closed strateg{s.count === 1 ? "y" : "ies"} (booked P&L, in order of closing); the curve starts at zero and has one point per close, evenly spaced (not to time scale).
        Drawdown is the fall from the highest cumulative P&L reached. Expectancy = win rate × average win + loss rate × average loss = net P&L ÷ closed strategies.
        {s.bestDay && s.worstDay ? ` Best day ${money(s.bestDay.pnl)} (${s.bestDay.day}), worst day ${money(s.worstDay.pnl)} (${s.worstDay.day}).` : ""}
        {runningTotal != null ? ` Running strategies add ${money(runningTotal)} live and provisional (not in these figures).` : ""}
        {s.count < 10 ? " With so few closed strategies these figures are not statistically meaningful." : ""}
      </p>
    </div>
  );
}
