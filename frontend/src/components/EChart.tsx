import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TitleComponent, TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption, ECharts } from "echarts/core";
import type { ChartColors } from "../lib/chartOptions";

echarts.use([
  BarChart, HeatmapChart, LineChart, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer,
]);

export interface PointClick {
  seriesName?: string;
  name?: string;
  value?: unknown;
}

/** Thin ECharts wrapper: owns the instance, resizes with its container, keeps zoom across updates. */
export function EChart({ option, onClick, ariaLabel, className = "" }: {
  option: EChartsCoreOption;
  onClick?: (p: PointClick) => void;
  ariaLabel: string;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("click", (p) => clickRef.current?.(p as PointClick));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    // replaceMerge keeps the user's zoom while series appear/disappear with the CE/PE toggles.
    chart.current?.setOption(option, { replaceMerge: ["series"] });
  }, [option]);

  return <div ref={el} role="img" aria-label={ariaLabel} className={`h-full min-h-[120px] w-full ${className}`} />;
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
