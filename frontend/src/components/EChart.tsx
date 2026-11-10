import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, HeatmapChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TitleComponent, TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption, ECharts } from "echarts/core";
import type { ChartColors } from "../lib/chartOptions";

echarts.use([
  BarChart, CandlestickChart, HeatmapChart, LineChart, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer,
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

/** Thin ECharts wrapper: owns the instance, resizes with its container, keeps zoom across updates. */
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
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    if (group) { c.group = group; echarts.connect(group); }
    c.on("click", (p) => clickRef.current?.(p as PointClick));
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
    chart.current?.setOption({ ...(fitNarrow(option, width) as Obj), animation: false, animationDuration: 0, animationDurationUpdate: 0 }, { replaceMerge: ["series"] });
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
