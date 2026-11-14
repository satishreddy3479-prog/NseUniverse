/**
 * Linked charts (a page's charts that share a time axis). ECharts' own chart groups copy the hovered series and data index to the other
 * charts, which fails when the hovered chart's visible series is not a series the other charts have (put and call volume switched off in
 * a legend: the other chart then showed nothing). This links them by position instead:
 *  - hover: the x position under the pointer (a category index, or a time/number value) is found in the chart under the pointer and each
 *    other chart shows its own tooltip and crosshair at that same position, whichever series are on;
 *  - zoom: a zoom of one chart is applied to the others;
 *  - legend: switching a legend item on or off applies to the series of that name in the others.
 * Everything is written against the small ``LinkChart`` interface so it can be tested without a canvas.
 */

/** The part of an ECharts instance this needs. */
export interface LinkChart {
  convertFromPixel(finder: { xAxisIndex: number }, x: number): unknown;
  convertToPixel(finder: { xAxisIndex: number }, value: number): unknown;
  containPixel(finder: { gridIndex: number }, point: [number, number]): boolean;
  getHeight(): number;
  dispatchAction(action: Record<string, unknown>): void;
  /** "category" for a category x axis (its positions are indexes), otherwise "value" (time or number: positions are values) */
  axisKind(): "category" | "value";
  /** the number of categories on the first x axis (category axes only) */
  categoryCount(): number;
}

const num = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : Number(v));

/** Is the pixel inside any plot area of the chart (a chart can have several grids)? */
function insidePlot(c: LinkChart, x: number, y: number): boolean {
  for (let g = 0; g < 4; g++) {
    try { if (c.containPixel({ gridIndex: g }, [x, y])) return true; } catch { /* no such grid */ }
  }
  return false;
}

/** The position under the pointer on the shared x axis: a category index or a value; null when the pointer is not inside a plot or has no position. */
export function positionAt(src: LinkChart, x: number, y: number): number | null {
  if (!insidePlot(src, x, y)) return null;
  let p = NaN;
  try { p = num(src.convertFromPixel({ xAxisIndex: 0 }, x)); } catch { return null; }
  if (!Number.isFinite(p)) return null;
  if (src.axisKind() === "category") {
    const idx = Math.round(p);
    return idx >= 0 && idx < src.categoryCount() ? idx : null;
  }
  return p;
}

/** Show the tooltip of every other chart at the position under the pointer in ``src`` (x, y pixels in ``src``), or hide them. */
export function syncHover(src: LinkChart, x: number, y: number, others: Iterable<LinkChart>): void {
  const pos = positionAt(src, x, y);
  for (const o of others) {
    if (o === src) continue;
    let placed = false;
    if (pos != null) {
      try {
        const px = num(o.convertToPixel({ xAxisIndex: 0 }, pos));
        if (Number.isFinite(px)) {
          // any y inside the first plot area will do: the tooltip follows the x position
          for (const f of [0.15, 0.3, 0.5, 0.7, 0.85]) {
            const yy = o.getHeight() * f;
            if (o.containPixel({ gridIndex: 0 }, [px, yy])) { o.dispatchAction({ type: "showTip", x: px, y: yy }); placed = true; break; }
          }
        }
      } catch { /* this chart cannot place it: it shows nothing rather than something wrong */ }
    }
    if (!placed) o.dispatchAction({ type: "hideTip" });
  }
}

/** Hide the tooltips of every other chart (the pointer left the chart ``src``). */
export function hideHover(src: LinkChart, others: Iterable<LinkChart>): void {
  for (const o of others) if (o !== src) o.dispatchAction({ type: "hideTip" });
}

/** Apply the zoom of ``src`` (percent window) to the others. Charts without a zoom ignore it. */
export function syncZoom(src: LinkChart, zoom: { start?: number; end?: number }, others: Iterable<LinkChart>): void {
  if (zoom.start == null || zoom.end == null) return;
  for (const o of others) {
    if (o === src) continue;
    try { o.dispatchAction({ type: "dataZoom", start: zoom.start, end: zoom.end }); } catch { /* no zoom on this chart */ }
  }
}

/** Switch the legend item ``name`` on or off in the others (the same name in each chart). */
export function syncLegend(src: LinkChart, name: string, on: boolean, others: Iterable<LinkChart>): void {
  for (const o of others) {
    if (o === src) continue;
    try { o.dispatchAction({ type: on ? "legendSelect" : "legendUnSelect", name }); } catch { /* no such legend item */ }
  }
}
