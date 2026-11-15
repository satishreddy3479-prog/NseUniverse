/**
 * "Hide info": whether the card that follows the pointer over a chart (its tooltip) is shown. On a phone that card can cover the whole chart, so
 * every chart has a button to hide it; the crosshair stays, so the position is still marked. One choice for all charts, kept in this browser.
 */
const KEY = "nse.charts.hideInfo";
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
let hidden = read();

export const getHideInfo = (): boolean => hidden;

export function setHideInfo(v: boolean): void {
  hidden = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* this visit only */ }
  listeners.forEach((l) => l());
}

export function subscribeHideInfo(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * The option with the tooltip card switched off or on. ``showContent`` is set both ways on purpose: ECharts merges options, so a key that is merely
 * absent would leave an earlier ``showContent: false`` in force and the card would never come back. The crosshair is not part of the card and stays.
 */
export function withInfoHidden<T extends object>(option: T, hide: boolean): T {
  const o = option as Record<string, unknown>;
  const set = (t: unknown): unknown => (t && typeof t === "object" && !Array.isArray(t) ? { ...(t as object), showContent: !hide } : t);
  const out: Record<string, unknown> = { ...o };
  if (Array.isArray(o.tooltip)) out.tooltip = o.tooltip.map(set); else if (o.tooltip) out.tooltip = set(o.tooltip);
  if (Array.isArray(o.series)) out.series = o.series.map((s) => { const x = s as Record<string, unknown>; return x.tooltip ? { ...x, tooltip: set(x.tooltip) } : x; });
  return out as T;
}
