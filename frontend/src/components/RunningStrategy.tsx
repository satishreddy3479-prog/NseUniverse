import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useExpiries } from "../lib/hooks";
import { isExited, NO_RULES, type Leg, type OptionType } from "../lib/strategy";
import { StrategyMtm } from "./StrategyMtm";
import { StrategyTimeChart } from "./StrategyTimeChart";

/** The strategy that is running now, as the server holds it, with the P&L the server computes from its live prices (right with no strategy page open). */
export function useRunningStrategy() {
  const run = useQuery({ queryKey: ["runningDoc"], queryFn: () => api.runningGet(), refetchInterval: 15_000, retry: false });
  const pnl = useQuery({ queryKey: ["runningPnl"], queryFn: () => api.runningPnl(), refetchInterval: 5_000, retry: false });
  const ex = useExpiries();
  const doc = run.data?.doc ?? null;
  const mult = doc?.mult ?? 1;
  const legs: Leg[] = useMemo(() => (doc?.legs ?? []).map((l) => ({ ...l, lots: l.lots * mult })), [doc, mult]);
  const collected = useMemo(() => [ex.data?.weekly, ex.data?.monthly].filter((e): e is string => !!e), [ex.data]);
  const p = pnl.data;
  const running = !!doc && !!p?.running;
  return { doc, legs, open: legs.filter((l) => l.enabled !== false && !isExited(l)), collected, pnl: p, running, loading: run.isPending || pnl.isPending, error: run.isError || pnl.isError };
}

function Empty({ children, testid }: { children: string; testid: string }) {
  return <p role="status" className="rounded-sm border border-rule bg-slate-2 p-3 text-sm text-muted" data-testid={testid}>{children}</p>;
}

/** The mark-to-market of the running strategy through the day (booked + open P&L), the same chart as the Strategy Builder's MTM tab. */
export function RunningMtmChart() {
  const r = useRunningStrategy();
  if (r.loading) return <Empty testid="running-loading">Loading the running strategy…</Empty>;
  if (r.error) return <p role="alert" className="text-sm text-down" data-testid="running-error">The running strategy could not be loaded.</p>;
  if (!r.running || !r.doc) return <Empty testid="running-none">No strategy is running. Build one in the Strategy Builder and its mark-to-market appears here.</Empty>;
  return <StrategyMtm legs={r.legs} historyExpiries={r.collected} lotSize={r.doc.lotSize ?? null} liveNow={r.pnl?.total ?? null} />;
}

/** The running strategy as one price through the day (and its P&L) against NIFTY, with averages, bands and what moved it; its stop and target lines are drawn from its own rules. */
export function RunningTimeChart() {
  const r = useRunningStrategy();
  const optionLegs = useMemo(() => r.open.filter((l) => l.type !== "FUT") as (Leg & { type: OptionType })[], [r.open]);
  if (r.loading) return <Empty testid="running-loading">Loading the running strategy…</Empty>;
  if (r.error) return <p role="alert" className="text-sm text-down" data-testid="running-error">The running strategy could not be loaded.</p>;
  if (!r.running || !r.doc) return <Empty testid="running-none">No strategy is running. Build one in the Strategy Builder and its chart appears here.</Empty>;
  if (optionLegs.length === 0) return <Empty testid="running-no-options">The running strategy has no open option leg to draw (its future is not in this chart).</Empty>;
  return <StrategyTimeChart legs={optionLegs} historyExpiries={r.collected} lotSize={r.doc.lotSize ?? null} modelDelta={null} rules={r.doc.rules ?? NO_RULES} />;
}
