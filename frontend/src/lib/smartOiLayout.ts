/**
 * The view of the Smart OI widget a person has set up: candle length, strikes summed, the two lower panels, and which graphs (legend entries) are switched off in each chart.
 * "Save layout" keeps it in this browser; "Reset" puts the widget back to the standard view and forgets the saved one. Only the view is kept, never any data.
 */
export const LAYOUT_KEY = "nse.smartoi.layout.v1";
export const TIMEFRAMES = [1, 3, 5, 15] as const;
export type ChartKey = "main" | "day" | "ratio";
export interface SmartOiLayout {
  tf: number;
  strikes: number | "all";
  /** the lower-right chart */
  lower: "pcr" | "volume";
  /** the lower panel of the main chart */
  lowerLeft: "signals" | "volume";
  /** legend entries switched off, by chart */
  off: Record<ChartKey, string[]>;
  /** legend entries switched ON that the chart starts without (off by default), by chart: without this a saved view could not bring them back */
  on: Record<ChartKey, string[]>;
}
export const DEFAULT_LAYOUT: SmartOiLayout = { tf: 3, strikes: "all", lower: "pcr", lowerLeft: "signals", off: { main: [], day: [], ratio: [] }, on: { main: [], day: [], ratio: [] } };

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 80).slice(0, 24) : []);

/** A layout read back from storage, checked field by field; anything unusable falls back to the standard value for that field. Null when nothing was saved. */
export function parseLayout(raw: string | null): SmartOiLayout | null {
  if (!raw) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (v == null || typeof v !== "object") return null;
  const off = (v.off ?? {}) as Record<string, unknown>;
  const on = (v.on ?? {}) as Record<string, unknown>;
  return {
    tf: (TIMEFRAMES as readonly number[]).includes(v.tf as number) ? (v.tf as number) : DEFAULT_LAYOUT.tf,
    strikes: v.strikes === "all" || (typeof v.strikes === "number" && Number.isFinite(v.strikes) && v.strikes > 0) ? (v.strikes as number | "all") : DEFAULT_LAYOUT.strikes,
    lower: v.lower === "volume" ? "volume" : "pcr",
    lowerLeft: v.lowerLeft === "volume" ? "volume" : "signals",
    off: { main: names(off.main), day: names(off.day), ratio: names(off.ratio) },
    on: { main: names(on.main), day: names(on.day), ratio: names(on.ratio) },
  };
}
export function loadLayout(): SmartOiLayout | null {
  try { return parseLayout(localStorage.getItem(LAYOUT_KEY)); } catch { return null; }
}
export function saveLayout(l: SmartOiLayout): boolean {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); return true; } catch { return false; }
}
export function clearLayout(): void {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* nothing to remove */ }
}
const sortedSets = (o: Record<ChartKey, string[]>) => (["main", "day", "ratio"] as const).map((k) => [...o[k]].sort().join("\u0001")).join("\u0002");
/** Whether two layouts show the same view (the order of switched-off graphs does not matter). */
export function sameLayout(a: SmartOiLayout, b: SmartOiLayout): boolean {
  return a.tf === b.tf && a.strikes === b.strikes && a.lower === b.lower && a.lowerLeft === b.lowerLeft && sortedSets(a.off) === sortedSets(b.off) && sortedSets(a.on) === sortedSets(b.on);
}
/**
 * The graphs switched off after the legend of one chart changed. ``selected`` holds the entries that chart's legend has now; an entry that is not in it (the volume bars while the signals
 * are shown) keeps what it had, so a choice made in one mode is not lost by looking at the other.
 */
export function mergeOff(prev: readonly string[], selected: Record<string, boolean>): string[] {
  const kept = prev.filter((n) => !(n in selected));
  const off = Object.entries(selected).filter(([, on]) => on === false).map(([n]) => n);
  return [...kept, ...off].sort();
}
/**
 * The graphs switched ON that the chart does not show by default, after its legend changed. ``defaults`` are the legend own starting states; an entry that is not in ``selected`` keeps
 * what it had. A saved view needs this because the chart cannot tell "left off by default" from "switched on" by the list of graphs switched off alone.
 */
export function mergeOn(prev: readonly string[], selected: Record<string, boolean>, defaults: Record<string, boolean> = {}): string[] {
  const kept = prev.filter((n) => !(n in selected));
  const on = Object.entries(selected).filter(([n, v]) => v === true && defaults[n] === false).map(([n]) => n);
  return [...kept, ...on].sort();
}
