import { useSyncExternalStore, type ReactNode } from "react";

/** One candle size for every time chart on the Gamma Exposure and Vega pages: choose it once, the whole tool follows. Kept on this device. */
export const TIMEFRAMES = [1, 3, 5, 15] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
const KEY = "nse.timeframe.v1";
const listeners = new Set<() => void>();
const read = (): Timeframe => {
  try { const v = Number(localStorage.getItem(KEY)); return (TIMEFRAMES as readonly number[]).includes(v) ? (v as Timeframe) : 5; } catch { return 5; }
};
let current: Timeframe = read();
export const setTimeframe = (m: Timeframe): void => {
  if (m === current) return;
  current = m;
  try { localStorage.setItem(KEY, String(m)); } catch { /* storage unavailable: kept for this visit only */ }
  listeners.forEach((l) => l());
};
export function useTimeframe(): [Timeframe, (m: Timeframe) => void] {
  const tf = useSyncExternalStore<Timeframe>((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => current, (): Timeframe => 5);
  return [tf, setTimeframe];
}

const pill = (on: boolean) => `widget-nodrag min-h-9 min-w-11 rounded-sm border px-3 text-sm ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
/** The page-wide candle-size switch, shown at the top of the page. */
export function TimeframeBar({ value, onChange, right }: { value?: Timeframe; onChange?: (m: Timeframe) => void; right?: ReactNode } = {}) {
  const [stored, setStored] = useTimeframe();
  const tf = value ?? stored;
  const set = onChange ?? setStored;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2 text-sm" data-testid="timeframe-bar">
      <span className="text-muted">Timeframe</span>
      <div role="group" aria-label="Timeframe" className="flex gap-1">
        {TIMEFRAMES.map((m) => <button key={m} type="button" aria-pressed={tf === m} onClick={() => set(m)} className={pill(tf === m)}>{m}m</button>)}
      </div>
      <span className="text-xs text-muted">every time chart and table on this page uses {tf}-minute candles</span>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}
