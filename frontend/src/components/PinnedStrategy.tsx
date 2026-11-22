import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtInt } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { isExited, legName, type Leg } from "../lib/strategy";
import { StrategyMtm } from "./StrategyMtm";

const money = (v: number | null | undefined) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-paper");

/**
 * The running strategy on the Home page: its P&L now and its mark-to-market through the day, pinned under the market summary while it is running (at least one
 * leg open). The P&L is the server's own, from its live prices, so it is right with no strategy page open; the chart is the same one as the builder's MTM tab.
 * Nothing is shown when no strategy is running.
 */
export function PinnedStrategy() {
  const run = useQuery({ queryKey: ["runningDoc"], queryFn: () => api.runningGet(), refetchInterval: 15_000, retry: false });
  const pnl = useQuery({ queryKey: ["runningPnl"], queryFn: () => api.runningPnl(), refetchInterval: 5_000, retry: false });
  const ex = useExpiries();
  const doc = run.data?.doc ?? null;
  const mult = doc?.mult ?? 1;
  const legs: Leg[] = useMemo(() => (doc?.legs ?? []).map((l) => ({ ...l, lots: l.lots * mult })), [doc, mult]);
  const collected = useMemo(() => [ex.data?.weekly, ex.data?.monthly].filter((e): e is string => !!e), [ex.data]);
  const p = pnl.data;
  if (!doc || !p?.running) return null;
  const open = legs.filter((l) => l.enabled !== false && !isExited(l));
  return (
    <section aria-label="Running strategy" className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="pinned-strategy">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-paper">Running strategy{p.name ? ` · ${p.name}` : ""}</h2>
          <p className="text-xs text-muted" data-testid="pinned-legs">{open.length} open leg{open.length === 1 ? "" : "s"}: {open.map((l) => `${l.action === "BUY" ? "+" : "−"}${l.lots}× ${legName(l)}`).join(", ")}</p>
        </div>
        <div className="text-right">
          <div className={`num text-2xl font-semibold ${tone(p.total)}`} data-testid="pinned-pnl">{money(p.total)}</div>
          <div className="num text-xs text-muted" data-testid="pinned-split">
            {p.total == null ? `no live price for ${p.missing.join(", ")}` : `booked ${money(p.booked)} · open ${money(p.open)}`}{p.live ? "" : " · market closed: last prices"}
          </div>
        </div>
      </header>
      <StrategyMtm legs={legs} historyExpiries={collected} lotSize={doc.lotSize ?? null} liveNow={p.total} />
      <Link to="/strategy" className="self-start text-sm font-semibold text-accent hover:underline">Open in the Strategy Builder →</Link>
    </section>
  );
}
