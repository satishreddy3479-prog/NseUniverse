import { useEffect, useMemo, useState } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { buildClosedMtm, legsForMtm, pointsOf, statsOf, type ClosedLike, type StoredMtm } from "../lib/closedMtm";
import type { Mtm } from "../lib/strategyMtm";
import { EChart, useChartColors } from "./EChart";
import { Loading } from "./Loading";
import { buildOption, dayHhmm, hhmmss, money, tone } from "./StrategyMtm";

const SOURCE: Record<StoredMtm["source"], string> = {
  live: "the live ticks the page saw while the strategy ran",
  stored: "the stored one-minute prices from the entry to the close",
  "stored+live": "the stored one-minute prices, then the live ticks the page saw",
};

/**
 * The mark-to-market graph of a closed strategy. It is read from the record when it was saved with it; otherwise (a record from before the graph was kept, or one whose live part is
 * all that was kept) it is built once from the stored one-minute history up to the close and handed back to be saved with the record. Never invented: with no history the reason is shown.
 */
export function ClosedMtm({ c, onSaved }: { c: ClosedLike & { name: string }; onSaved?: (mtm: StoredMtm) => void }) {
  const colors = useChartColors();
  const [mtm, setMtm] = useState<StoredMtm | null>(c.mtm?.complete ? c.mtm : null);
  const [busy, setBusy] = useState(!c.mtm?.complete);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    if (c.mtm?.complete) { setMtm(c.mtm); setBusy(false); return; }
    let off = false;
    setBusy(true);
    void buildClosedMtm(c).then((r) => {
      if (off) return;
      setBusy(false);
      if (r.mtm) { setMtm(r.mtm); if (r.mtm.complete) onSaved?.(r.mtm); } else setReason(r.reason);
    });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);
  const legs = useMemo(() => legsForMtm(c), [c]);
  const stats = useMemo(() => (mtm ? statsOf(mtm) : null), [mtm]);
  const option = useMemo(() => {
    if (!mtm || mtm.t.length === 0) return null;
    const m: Mtm = { from: mtm.t[0]!, t: mtm.t, pnl: mtm.pnl, missing: 0, now: stats?.now ?? null, peak: stats?.high ? { pnl: stats.high.v, t: stats.high.t } : null, trough: stats?.low ? { pnl: stats.low.v, t: stats.low.t } : null, drawdown: stats?.drawdown ?? null, reason: null, untimed: 0 };
    return buildOption(m, legs, colors);
  }, [mtm, legs, colors, stats]);

  if (busy) return <Loading label="Building the graph from the stored prices…" className="m-2" />;
  if (!mtm || !option || !stats) return <p className="p-3 text-sm text-muted" data-testid="closed-mtm-reason">{reason ?? "No graph is available for this strategy."}</p>;
  const tiles: [string, string, string][] = [
    ["At the close", money(stats.now), tone(stats.now)],
    ["Max high", stats.high ? `${money(stats.high.v)} · ${hhmmss(stats.high.t)}` : "—", "text-up"],
    ["Max low", stats.low ? `${money(stats.low.v)} · ${hhmmss(stats.low.t)}` : "—", "text-down"],
    ["Drawdown", stats.drawdown ? `${money(-stats.drawdown.amount)} · ${hhmmss(stats.drawdown.from)}→${hhmmss(stats.drawdown.to)}` : "—", "text-down"],
  ];
  return (
    <div className="p-2" data-testid="closed-mtm">
      <dl className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([k, v, cls]) => <div key={k} className="rounded-sm border border-rule bg-slate-2 px-2 py-1.5"><dt className="text-[10px] uppercase tracking-wide text-muted">{k}</dt><dd className={`num text-sm ${cls}`}>{v}</dd></div>)}
      </dl>
      <div className="h-[320px]"><EChart ariaLabel={`Mark-to-market of ${c.name} through time`} option={option as EChartsCoreOption} /></div>
      <p className="mt-2 text-xs text-muted" data-testid="closed-mtm-note">
        P&amp;L of the whole strategy (booked + open, before costs) from {dayHhmm(pointsOf(mtm)[0]!.t)} IST to its close, from {SOURCE[mtm.source]}. An exited leg stays at what it booked. Saved with the strategy; the closing P&amp;L on the list is the booked figure.
      </p>
    </div>
  );
}
