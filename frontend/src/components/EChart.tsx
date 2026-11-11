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
  const fixGrid = (g: Obj): Obj => ({ ...g, ...(typeof g.left === "number" ? { left: Math.min(g.left, 46) } : {}), ...(typeof g.right === "number" ? { right: Math.min(g.right, 66) } : {}) });
  if (Array.isArray(o.grid)) o.grid = o.grid.map((g) => fixGrid(g as Obj)); else if (o.grid) o.grid = fixGrid(o.grid as Obj);
  const fixAxis = (a: Obj): Obj => {
    const label = a.axisLabel as Obj | undefined;
    return a.position === "right" && typeof label?.margin === "number" && label.margin >= 30 ? { ...a, axisLabel: { ...label, show: false } } : a;
  };
  if (Array.isArray(o.yAxis)) o.yAxis = o.yAxis.map((a) => fixAxis(a as Obj)); else if (o.yAxis) o.yAxis = fixAxis(o.yAxis as Obj);
  if (Array.isArray(o.series)) o.series = o.series.map((x) => { const e = (x as Obj).endLabel as Obj | undefined; return e ? { ...(x as Obj), endLabel: { ...e, fontSize: 10, offset: [2, 0] } } : x; });
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

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    if (group) { c.group = group; echarts.connect(group); }
    c.on("click", (p) => clickRef.current?.(p as PointClick));
    // remember what the user toggles in the legend (one series, all, or invert) so the next data refresh does not undo it
    for (const ev of ["legendselectchanged", "legendselectall", "legendinverseselect"]) c.on(ev, (e) => { Object.assign(userLegend.current, (e as { selected?: Record<string, boolean> }).selected ?? {}); });
    const ro = new ResizeObserver(() => { c.resize(); setWidth(node.clientWidth); });
    setWidth(node.clientWidth);
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
    chart.current?.setOption({ ...(withInactiveLegend(keepLegend(fitNarrow(safeTooltips(option), width), userLegend.current, legendDefaults.current), getComputedStyle(document.documentElement).getPropertyValue("--legend-off").trim() || "#8a96ab") as Obj), animation: false, animationDuration: 0, animationDurationUpdate: 0 }, { replaceMerge: ["series"] });
  }, [option, width]);

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
