/**
 * Statistics of the closed strategies, computed only from what was booked (each closed strategy's realised P&L in rupees).
 * No capital base is stored for the builder, so drawdown is in rupees from the highest cumulative P&L reached (the curve starts at
 * zero). Percentages are of a capital the user types in (kept in this browser) and are missing without one. A measure that needs a loss, a win or two trades and does
 * not have one is null, never zero.
 */
export interface ClosedPoint { id: string; name: string; closedAt: string; pnl: number }

export interface PortfolioStats {
  count: number; wins: number; losses: number; flat: number;
  winRate: number | null; total: number;
  grossProfit: number; grossLoss: number;
  avgWin: number | null; avgLoss: number | null; payoff: number | null; profitFactor: number | null;
  expectancy: number | null;
  best: ClosedPoint | null; worst: ClosedPoint | null;
  longestWin: number; longestLoss: number; current: { kind: "win" | "loss"; length: number } | null;
  maxDrawdown: number; maxDrawdownPct: number | null; returnPct: number | null; currentDrawdown: number; peak: number;
  drawdownTrades: number; recoveryFactor: number | null;
  bestDay: { day: string; pnl: number } | null; worstDay: { day: string; pnl: number } | null;
  curve: { t: number; label: string; cum: number; dd: number; name: string; pnl: number }[];
}

const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

export function portfolioStats(closed: ClosedPoint[], capital: number | null = null): PortfolioStats {
  const rows = [...closed].filter((c) => Number.isFinite(c.pnl) && Number.isFinite(Date.parse(c.closedAt))).sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const wins = rows.filter((r) => r.pnl > 0), losses = rows.filter((r) => r.pnl < 0);
  const grossProfit = wins.reduce((t, r) => t + r.pnl, 0), grossLoss = losses.reduce((t, r) => t + r.pnl, 0);
  const total = rows.reduce((t, r) => t + r.pnl, 0);
  const avgWin = wins.length ? grossProfit / wins.length : null, avgLoss = losses.length ? grossLoss / losses.length : null;
  // streaks: a flat trade (exactly zero) ends both
  let longestWin = 0, longestLoss = 0, run = 0, kind: "win" | "loss" | null = null;
  for (const r of rows) {
    const k = r.pnl > 0 ? "win" : r.pnl < 0 ? "loss" : null;
    if (k != null && k === kind) run++; else { run = k == null ? 0 : 1; kind = k; }
    if (kind === "win") longestWin = Math.max(longestWin, run);
    if (kind === "loss") longestLoss = Math.max(longestLoss, run);
  }
  // the equity curve starts at zero before the first close; drawdown is measured from the highest point reached (zero included)
  let cum = 0, peak = 0, maxDd = 0, underWater = 0, longestDd = 0;
  const curve: PortfolioStats["curve"] = [];
  for (const r of rows) {
    cum += r.pnl;
    if (cum > peak) { peak = cum; underWater = 0; } else underWater++; // closed strategies since the last new high
    longestDd = Math.max(longestDd, underWater);
    const dd = peak - cum;
    maxDd = Math.max(maxDd, dd);
    curve.push({ t: Date.parse(r.closedAt), label: r.closedAt, cum, dd, name: r.name, pnl: r.pnl });
  }
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(istDay(r.closedAt), (byDay.get(istDay(r.closedAt)) ?? 0) + r.pnl);
  const days = [...byDay.entries()].map(([day, pnl]) => ({ day, pnl })).sort((a, b) => a.pnl - b.pnl);
  const last = rows.length ? (rows[rows.length - 1]!.pnl > 0 ? "win" : rows[rows.length - 1]!.pnl < 0 ? "loss" : null) : null;
  let curLen = 0;
  if (last) for (let i = rows.length - 1; i >= 0 && (rows[i]!.pnl > 0 ? "win" : rows[i]!.pnl < 0 ? "loss" : null) === last; i--) curLen++;
  const sorted = [...rows].sort((a, b) => a.pnl - b.pnl);
  return {
    count: rows.length, wins: wins.length, losses: losses.length, flat: rows.length - wins.length - losses.length,
    winRate: rows.length ? (wins.length / rows.length) * 100 : null, total, grossProfit, grossLoss, avgWin, avgLoss,
    payoff: avgWin != null && avgLoss != null ? avgWin / Math.abs(avgLoss) : null,
    profitFactor: losses.length && grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null,
    // expectancy per closed strategy: win rate x average win + loss rate x average loss (= total / count)
    expectancy: rows.length ? total / rows.length : null,
    best: sorted.length && sorted[sorted.length - 1]!.pnl > 0 ? sorted[sorted.length - 1]! : null,
    worst: sorted.length && sorted[0]!.pnl < 0 ? sorted[0]! : null,
    longestWin, longestLoss, current: last && curLen ? { kind: last, length: curLen } : null,
    maxDrawdown: maxDd, maxDrawdownPct: capital != null && capital > 0 ? (maxDd / capital) * 100 : null, returnPct: capital != null && capital > 0 && rows.length ? (total / capital) * 100 : null, currentDrawdown: peak - cum, peak,
    drawdownTrades: longestDd, recoveryFactor: maxDd > 0 ? total / maxDd : null,
    bestDay: days.length && days[days.length - 1]!.pnl > 0 ? days[days.length - 1]! : null,
    worstDay: days.length && days[0]!.pnl < 0 ? days[0]! : null,
    curve,
  };
}
