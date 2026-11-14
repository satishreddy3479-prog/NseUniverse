/**
 * One hover for several charts that share a time axis (the Smart OI charts). ECharts' own chart groups copy the hovered series and data
 * index to the other charts, which fails when the hovered chart's visible series is not a series the other charts have (put and call
 * volume switched off in the legend: the candle chart then showed nothing). This maps by position on the time axis instead: the hovered
 * category index is found in the chart under the pointer and each other chart shows its own tooltip and crosshair at the same index.
 */

/** The part of an ECharts instance this needs (so it can be tested without a canvas). */
export interface HoverChart {
  convertFromPixel(finder: { xAxisIndex: number }, x: number): unknown;
  convertToPixel(finder: { xAxisIndex: number }, value: number): unknown;
  containPixel(finder: { gridIndex: number }, point: [number, number]): boolean;
  getHeight(): number;
  dispatchAction(action: { type: "showTip"; x: number; y: number } | { type: "hideTip" }): void;
  /** the number of categories on the first x axis */
  categoryCount(): number;
}

const num = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : Number(v));

/** Show the tooltip of every other chart at the category index under the pointer (x pixels in the chart ``src``), or hide them. */
export function syncHover(src: HoverChart, x: number, others: Iterable<HoverChart>): void {
  let idx = NaN;
  try { idx = Math.round(num(src.convertFromPixel({ xAxisIndex: 0 }, x))); } catch { /* a chart without a category axis: nothing to follow */ }
  const inRange = Number.isFinite(idx) && idx >= 0 && idx < src.categoryCount();
  for (const o of others) {
    if (o === src) continue;
    let placed = false;
    if (inRange) {
      try {
        const px = num(o.convertToPixel({ xAxisIndex: 0 }, idx));
        if (Number.isFinite(px)) {
          // any y inside the first grid will do: the tooltip follows the x position
          for (const f of [0.15, 0.3, 0.5, 0.7, 0.85]) {
            const y = o.getHeight() * f;
            if (o.containPixel({ gridIndex: 0 }, [px, y])) { o.dispatchAction({ type: "showTip", x: px, y }); placed = true; break; }
          }
        }
      } catch { /* this chart cannot place it: it shows nothing rather than something wrong */ }
    }
    if (!placed) o.dispatchAction({ type: "hideTip" });
  }
}

/** Hide the tooltips of every other chart (the pointer left the chart ``src``). */
export function hideHover(src: HoverChart, others: Iterable<HoverChart>): void {
  for (const o of others) if (o !== src) o.dispatchAction({ type: "hideTip" });
}
