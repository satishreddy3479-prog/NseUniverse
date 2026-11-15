import { useSyncExternalStore } from "react";
import { getHideInfo, setHideInfo, subscribeHideInfo } from "../lib/chartInfo";

/**
 * "Hide chart info": one switch for every chart in the app (the choice is kept in this browser). The card that follows the pointer over a chart can
 * cover the whole chart on a phone; with this on the cards are not drawn and the line that marks the position stays. Placed beside the heading of a
 * page or section that has charts.
 */
export function ChartInfoToggle({ className = "" }: { className?: string }) {
  const hidden = useSyncExternalStore(subscribeHideInfo, getHideInfo, () => false);
  return (
    <button type="button" aria-pressed={hidden} onClick={() => setHideInfo(!hidden)} data-testid="chart-info-toggle"
      title={hidden ? "Show the card with the values when you point at a chart" : "Hide the card with the values when you point at a chart (the line that marks the position stays). Applies to every chart."}
      className={`widget-nodrag inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs ${hidden ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"} ${className}`}>
      <span aria-hidden="true">ⓘ</span>{hidden ? "Show chart info" : "Hide chart info"}
    </button>
  );
}
