import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent, GraphicComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TitleComponent, TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { LabelLayout, LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption, ECharts } from "echarts/core";
import type { ChartColors } from "../lib/chartOptions";

// Everything a chart option in this app can use must be registered here: ECharts ignores a series type, component or feature that was not, without an error in
// production (a scatter series simply never appeared; text corners, diamond markers, overlap-free end labels and containLabel grids were silently dropped).
// src/test/echart-registration.test.ts fails when one of them goes missing.
echarts.use([
  BarChart, CandlestickChart, HeatmapChart, LineChart, ScatterChart, DataZoomComponent, GraphicComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, TitleComponent, TooltipComponent, VisualMapComponent, LabelLayout, LegacyGridContainLabel, CanvasRenderer,
]);

export interface PointClick {
  seriesName?: string;
  name?: string;
  value?: unknown;
}

/** Below this container width (px) the chart's side margins shrink so the plot is not squeezed into a sliver on a phone. */
export const NARROW_CHART_PX = 560;

type Obj = Record<string, unknown>;
/**
 * The same option, made to fit a narrow container: numeric grid margins are capped, a right axis whose numbers were pushed out
 * beside the latest-value tags (a large label margin) hides them (the tags carry the values and the tooltip has them all), and the
 * tags use a smaller font. Wide containers get the option unchanged.
 */
export function fitNarrow(option: EChartsCoreOption, width: number): EChartsCoreOption {
  if (width <= 0 || width >= NARROW_CHART_PX) return option;
  const o = { ...(option as Obj) };
  // a chart whose right margin only holds latest-value tags needs room for the tag text, not the desktop margin
  const tags = Array.isArray(o.series) && (o.series as Obj[]).some((x) => (x.endLabel as Obj | undefined)?.show);
  const fixGrid = (g: Obj): Obj => ({ ...g, ...(typeof g.left === "number" ? { left: Math.min(g.left, 46) } : {}), ...(typeof g.right === "number" ? { right: Math.min(g.right, tags ? 54 : 66) } : {}) });
  if (Array.isArray(o.grid)) o.grid = o.grid.map((g) => fixGrid(g as Obj)); else if (o.grid) o.grid = fixGrid(o.grid as Obj);
  const fixAxis = (a: Obj): Obj => {
    const label = a.axisLabel as Obj | undefined;
    return a.position === "right" && typeof label?.margin === "number" && label.margin >= 30 ? { ...a, axisLabel: { ...label, show: false } } : a;
  };
  if (Array.isArray(o.yAxis)) o.yAxis = o.yAxis.map((a) => fixAxis(a as Obj)); else if (o.yAxis) o.yAxis = fixAxis(o.yAxis as Obj);
  if (Array.isArray(o.series)) o.series = o.series.map((x) => { const e = (x as Obj).endLabel as Obj | undefined; return e ? { ...(x as Obj), endLabel: { ...e, fontSize: 10, padding: [1, 3], offset: [2, 0] } } : x; });
  return o as EChartsCoreOption;
}


let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Width in px of ``text`` at ``size`` px in the chart's default font (a canvas measure; a rough 0.58 em per character where no canvas exists, as in tests). */
export function textWidth(text: string, size: number, weight: string | number = 400): number {
  if (measureCtx === undefined) {
    // no real canvas under jsdom (the unit tests): the estimate below is used there
    const jsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
    try { measureCtx = jsdom ? null : document.createElement("canvas").getContext("2d"); } catch { measureCtx = null; }
  }
  if (!measureCtx) return text.length * size * 0.58;
  measureCtx.font = `${weight} ${size}px sans-serif`;
  const w = measureCtx.measureText(text).width;
  return w > 0 ? w : text.length * size * 0.58;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const px = (v: unknown, whole: number): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim().endsWith("%")) return (parseFloat(v) / 100) * whole;
  return null;
};

/**
 * The number of rows a top legend takes in a container ``width`` px wide, and its height. ECharts wraps a long legend onto several rows but does not make
 * room for them, so the second row ran over the plot and the top axis label. The rows are packed the way ECharts packs them (symbol, gap, text, item gap).
 */
export function legendBox(legend: Obj, seriesNames: string[], width: number): { rows: number; height: number } {
  const font = (legend.textStyle as Obj | undefined)?.fontSize;
  const fs = num(font) ?? 12;
  const itemW = num(legend.itemWidth) ?? 25;
  const itemH = num(legend.itemHeight) ?? 14;
  const gap = num(legend.itemGap) ?? 10;
  const pad = num(legend.padding) ?? 5;
  const names = Array.isArray(legend.data) ? (legend.data as unknown[]).map((d) => (typeof d === "string" ? d : String((d as Obj)?.name ?? ""))) : seriesNames;
  const avail = Math.max(80, width - 2 * pad - (num(legend.left) ?? 0) - (num(legend.right) ?? 0));
  let rows = 1;
  let cur = 0;
  for (const n of names.filter(Boolean)) {
    const w = itemW + 5 + textWidth(n, fs) + gap;
    if (cur > 0 && cur + w - gap > avail) { rows++; cur = 0; }
    cur += w;
  }
  const rowH = Math.max(itemH, fs + 2);
  return { rows, height: rows * rowH + (rows - 1) * gap + 2 * pad };
}

/**
 * Makes room for what sits above the plot. A top legend may wrap onto several rows and a text readout placed in the top band (a ``graphic`` text) must not lie on
 * the legend or on the plot: the readouts are stacked under the legend and every grid that would start inside that band is moved down (its height reduced by the
 * same amount, so its bottom does not move). Axis labels that would overlap are dropped, and a narrow time or value axis gets fewer ticks.
 */
export function fitLayout(option: EChartsCoreOption, width: number, height: number): EChartsCoreOption {
  if (width <= 0) return option;
  const o = { ...(option as Obj) };
  const seriesNames = Array.isArray(o.series) ? [...new Set((o.series as Obj[]).map((x) => x.name).filter((n): n is string => typeof n === "string" && n !== ""))] : [];
  const legends = (Array.isArray(o.legend) ? o.legend : o.legend ? [o.legend] : []) as Obj[];
  let header = 0;
  for (const l of legends) {
    if (l.show === false || l.orient === "vertical" || l.bottom !== undefined || l.type === "scroll") continue;
    const top = num(l.top) ?? 0;
    header = Math.max(header, top + legendBox(l, seriesNames, width).height);
  }
  let hasHeader = header > 0;
  if (Array.isArray(o.graphic) || o.graphic) {
    const list = (Array.isArray(o.graphic) ? o.graphic : [o.graphic]) as Obj[];
    const out = list.map((g0) => {
      let g = g0;
      const style = g.style as Obj | undefined;
      const top = num(g.top);
      if (g.type !== "text" || !style) return g;
      // a readout wider than the chart is pulled back inside it instead of running off the edge
      const font = /(\d+)?\s*(\d+(?:\.\d+)?)px/.exec(String(style.font ?? ""));
      const fs = font ? parseFloat(font[2]!) : 12;
      const widest = Math.max(...String(style.text ?? "").split("\n").map((t) => textWidth(t, fs, 600)));
      const padX = Array.isArray(style.padding) ? (((style.padding as number[])[1] ?? 0) * 2) : 0;
      const left = num(g.left);
      if (left !== null && left + widest + padX > width - 4) g = { ...g, left: Math.max(4, width - widest - padX - 6) };
      if (top === null || top > 60 || g.bottom !== undefined) return g;
      const text = String(style.text ?? "");
      const lines = text.split("\n");
      const lh = num(style.lineHeight) ?? 15;
      const pad = Array.isArray(style.padding) ? (style.padding as number[]) : [0, 0];
      const h = lines.length * lh + (pad[0] ?? 0) * 2;
      const y = hasHeader ? header + 2 : top;
      header = y + h;
      hasHeader = true;
      return { ...g, top: y };
    });
    o.graphic = out;
  }
  if (hasHeader) {
    const need = header + 14;
    const fix = (g: Obj): Obj => {
      const t = px(g.top, height);
      const cur = t ?? 60;
      if (cur >= need) return g;
      const delta = need - cur;
      const h = px(g.height, height);
      return { ...g, top: need, ...(h !== null ? { height: Math.max(60, h - delta) } : {}) };
    };
    if (Array.isArray(o.grid)) o.grid = (o.grid as Obj[]).map(fix); else if (o.grid) o.grid = fix(o.grid as Obj); else o.grid = { top: need };
  }
  // a latest-value label at the end of a line needs the room to its right: the margin is raised to the label's own width when the chart gave it less
  let needRight = 0;
  for (const x of (Array.isArray(o.series) ? o.series : []) as Obj[]) {
    const e = x.endLabel as Obj | undefined;
    if (!e || e.show === false) continue;
    const fs = num(e.fontSize) ?? 12;
    const pad = Array.isArray(e.padding) ? (((e.padding as number[])[1] ?? 0) * 2) : 0;
    const w = typeof e.formatter === "string" ? textWidth(e.formatter, fs) : fs * 0.6 * 8;
    needRight = Math.max(needRight, Math.ceil(w + pad + 10));
  }
  if (needRight > 0) {
    const fixRight = (g: Obj): Obj => (typeof g.right === "number" && g.right < needRight ? { ...g, right: needRight } : g);
    if (Array.isArray(o.grid)) o.grid = (o.grid as Obj[]).map(fixRight); else if (o.grid) o.grid = fixRight(o.grid as Obj);
  }
  const narrow = width < NARROW_CHART_PX;
  const grids = (Array.isArray(o.grid) ? o.grid : o.grid ? [o.grid] : []) as Obj[];
  const plotW = Math.max(120, width - Math.max(0, ...grids.map((g) => (num(g.left) ?? 60) + (num(g.right) ?? 60))));
  const fixAxis = (a: Obj, horizontal: boolean): Obj => {
    const label = (a.axisLabel as Obj | undefined) ?? {};
    const out: Obj = { ...a, axisLabel: { hideOverlap: true, ...label } };
    if (horizontal && narrow && (a.type === "time" || a.type === "value") && a.splitNumber === undefined) out.splitNumber = Math.max(2, Math.floor(plotW / 78));
    return out;
  };
  if (Array.isArray(o.xAxis)) o.xAxis = (o.xAxis as Obj[]).map((a) => fixAxis(a, true)); else if (o.xAxis) o.xAxis = fixAxis(o.xAxis as Obj, true);
  if (Array.isArray(o.yAxis)) o.yAxis = (o.yAxis as Obj[]).map((a) => fixAxis(a, false)); else if (o.yAxis) o.yAxis = fixAxis(o.yAxis as Obj, false);
  return o as EChartsCoreOption;
}

/**
 * Every tooltip formatter of the option wrapped so that it cannot throw. A formatter that threw (an axis tooltip meeting a series it did not expect) ran on
 * every mouse move and froze the chart; now such a tooltip shows nothing for that move and the error is logged once.
 */
let warned = false;
const guard = (fn: unknown): unknown => {
  if (typeof fn !== "function") return fn;
  return (...a: unknown[]) => {
    try { return (fn as (...x: unknown[]) => unknown)(...a); } catch (e) {
      if (!warned) { warned = true; console.error("chart tooltip formatter failed", e); }
      return "";
    }
  };
};
export function safeTooltips(option: EChartsCoreOption): EChartsCoreOption {
  const o = option as Obj;
  const fixTip = (t: unknown): unknown => (t && typeof t === "object" && !Array.isArray(t) && typeof (t as Obj).formatter === "function" ? { ...(t as Obj), formatter: guard((t as Obj).formatter) } : t);
  const out: Obj = { ...o };
  if (Array.isArray(o.tooltip)) out.tooltip = o.tooltip.map(fixTip); else if (o.tooltip) out.tooltip = fixTip(o.tooltip);
  if (Array.isArray(o.series)) out.series = o.series.map((x) => { const s = x as Obj; return s.tooltip ? { ...s, tooltip: fixTip(s.tooltip) } : s; });
  return out as EChartsCoreOption;
}

/**
 * A legend entry the user switched off is drawn in ECharts' default pale grey (#ccc), which is nearly invisible on the light theme. Every legend gets the
 * theme's own "off" colour unless the option sets one (``--legend-off``, readable on both themes).
 */
export function withInactiveLegend(option: EChartsCoreOption, off: string): EChartsCoreOption {
  const o = option as Obj;
  const fix = (l: Obj): Obj => ("inactiveColor" in l ? l : { ...l, inactiveColor: off, inactiveBorderColor: off });
  if (Array.isArray(o.legend)) return { ...o, legend: o.legend.map((l) => fix(l as Obj)) } as EChartsCoreOption;
  return o.legend ? ({ ...o, legend: fix(o.legend as Obj) } as EChartsCoreOption) : option;
}

/**
 * Keeps what the user clicked in a legend across updates. A builder that sets ``legend.selected`` (a line that starts hidden, or the HV lines of the IV chart)
 * would otherwise put every series back to its default on the next live refresh, so a click on the legend lasted a few seconds. ``user`` holds the user's
 * choices by series name; ``defaults`` the defaults last applied. When the page itself changes a default (an external checkbox) its intent wins and the
 * user's choice for that name is dropped. Mutates ``user`` and ``defaults``; returns the option with the merged ``selected``.
 */
export function keepLegend(option: EChartsCoreOption, user: Record<string, boolean>, defaults: Record<string, boolean>): EChartsCoreOption {
  const o = option as Obj;
  const apply = (l: Obj): Obj => {
    const sel = l.selected as Record<string, boolean> | undefined;
    if (!sel) return l;
    const out: Record<string, boolean> = {};
    for (const [k, def] of Object.entries(sel)) {
      if (k in defaults && defaults[k] !== def) delete user[k];
      out[k] = k in user ? user[k]! : def;
      defaults[k] = def;
    }
    return { ...l, selected: out };
  };
  if (Array.isArray(o.legend)) return { ...o, legend: o.legend.map((l) => apply(l as Obj)) } as EChartsCoreOption;
  return o.legend ? ({ ...o, legend: apply(o.legend as Obj) } as EChartsCoreOption) : option;
}

/** Thin ECharts wrapper: owns the instance, resizes with its container, keeps zoom and the user's legend choices across updates. */
export function EChart({ option, onClick, ariaLabel, className = "", group }: {
  option: EChartsCoreOption;
  onClick?: (p: PointClick) => void;
  ariaLabel: string;
  className?: string;
  /** Charts with the same group name share one crosshair and tooltip: hovering one marks the same x position in the others. */
  group?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const userLegend = useRef<Record<string, boolean>>({});
  const legendDefaults = useRef<Record<string, boolean>>({});
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    (node as unknown as { __chart?: ECharts }).__chart = c; // read by the layout audit in the browser console
    if (group) { c.group = group; echarts.connect(group); }
    c.on("click", (p) => clickRef.current?.(p as PointClick));
    // remember what the user toggles in the legend (one series, all, or invert) so the next data refresh does not undo it
    for (const ev of ["legendselectchanged", "legendselectall", "legendinverseselect"]) c.on(ev, (e) => { Object.assign(userLegend.current, (e as { selected?: Record<string, boolean> }).selected ?? {}); });
    const ro = new ResizeObserver(() => { c.resize(); setWidth(node.clientWidth); setHeight(node.clientHeight); });
    setWidth(node.clientWidth);
    setHeight(node.clientHeight);
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    // replaceMerge keeps the user's zoom while series appear/disappear with the CE/PE toggles.
    // No chart animates: a live chart redrawn on every tick must not keep sliding, and a still chart can be read (animation off everywhere).
    chart.current?.setOption({ ...(withInactiveLegend(keepLegend(fitLayout(fitNarrow(safeTooltips(option), width), width, height), userLegend.current, legendDefaults.current), getComputedStyle(document.documentElement).getPropertyValue("--legend-off").trim() || "#8a96ab") as Obj), animation: false, animationDuration: 0, animationDurationUpdate: 0 }, { replaceMerge: ["series"] });
  }, [option, width, height]);

  return <div ref={el} role="img" aria-label={ariaLabel} className={`echart-box h-full min-h-[120px] w-full ${className}`} />;
}

/** Chart colours follow the active theme (CSS variables) and update when the theme changes. */
export function useChartColors(): ChartColors {
  const read = (): ChartColors => {
    const s = getComputedStyle(document.documentElement);
    const g = (n: string) => s.getPropertyValue(n).trim() || "#888";
    return { up: g("--up"), down: g("--down"), brass: g("--brass"), info: g("--info"), muted: g("--muted"), rule: g("--rule"), paper: g("--paper"), slate: g("--slate") };
  };
  const [colors, setColors] = useState<ChartColors>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setColors(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return colors;
}
