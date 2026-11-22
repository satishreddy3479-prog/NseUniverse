/**
 * One look for every chart in the app. Chart builders set what is specific to their data; this fills in what they leave out, so the axes, legends,
 * tooltips and bars read the same everywhere and are easy to read: larger axis and legend text (12 px; ECharts' 11 and 10 px were the complaint),
 * soft dashed grid lines, rounded tooltip cards with a clear edge, rounded bar tops, a colour-blind-safe series palette, and a thicker default line.
 * A value a builder sets always wins: nothing here overrides a choice, it only adds a default or lifts a too-small font size.
 */
type Obj = Record<string, unknown>;

export interface ThemeTokens { dark: boolean; font: string; muted: string; rule: string; paper: string; slate: string }

/** Series colours for charts that do not pick their own: distinguishable in colour-vision deficiency, tuned for white and for the night surface. */
export const PALETTE_LIGHT = ["#1760c4", "#9a5800", "#057650", "#c4193a", "#5a3de8", "#0b7a8a", "#a3246f", "#5b6577"];
export const PALETTE_DARK = ["#4cc2ff", "#ffb02e", "#2bd99f", "#ff5a64", "#a78bfa", "#2dd4d4", "#f472b6", "#9aabc4"];

export const MIN_FONT = 12; // axis, legend and label text is never smaller than this on a wide chart

/** Narrower than this a chart keeps its own (smaller) text: the room is needed for the plot. */
export const THEME_MIN_WIDTH = 560;

const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const one = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const mapEach = (x: unknown, f: (o: Obj) => Obj): unknown => (Array.isArray(x) ? x.map((o) => (isObj(o) ? f(o) : o)) : isObj(x) ? f(x) : x);

/** A font size under the minimum is lifted to it; an unset one is left to the chart. */
const lift = (style: unknown, wide: boolean): unknown => {
  if (!wide || !isObj(style)) return style;
  const fs = style.fontSize;
  return typeof fs === "number" && fs < MIN_FONT ? { ...style, fontSize: MIN_FONT } : style;
};

const fixLabel = (label: unknown, wide: boolean): unknown => (isObj(label) ? lift(label, wide) : label);

const fixAxis = (a: Obj, wide: boolean, t: ThemeTokens, value: boolean): Obj => {
  const out: Obj = { ...a };
  out.axisLabel = isObj(a.axisLabel) ? lift(a.axisLabel, wide) : a.axisLabel;
  if (isObj(a.nameTextStyle)) out.nameTextStyle = lift(a.nameTextStyle, wide);
  // a value axis draws its grid as soft dashed lines unless the chart styled them
  if (value && a.splitLine === undefined) out.splitLine = { lineStyle: { color: t.rule, type: "dashed", opacity: 0.55 } };
  else if (isObj(a.splitLine) && isObj(a.splitLine.lineStyle) && a.splitLine.lineStyle.type === undefined && a.splitLine.show !== false) out.splitLine = { ...a.splitLine, lineStyle: { ...a.splitLine.lineStyle, type: "dashed" } };
  return out;
};

/** The value a bar is drawn for: a number, ``{ value }``, or a pair (the second element, or the first for a horizontal bar). */
const barValue = (d: unknown, horizontal: boolean): number | null => {
  const v = isObj(d) && "value" in d ? d.value : d;
  const n = Array.isArray(v) ? v[horizontal ? 0 : 1] : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
/** Rounded outer end of a bar: the end away from the axis, whichever way the bar points (positive up or right, negative down or left). */
export const barRadius = (value: number, horizontal: boolean): number[] =>
  horizontal ? (value >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3]) : value >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3];

const fixSeries = (s: Obj, wide: boolean, horizontal: boolean): Obj => {
  const out: Obj = { ...s };
  if (s.type === "line") {
    const ls = isObj(s.lineStyle) ? s.lineStyle : {};
    if (ls.width === undefined) out.lineStyle = { ...ls, width: 2 };
    // the legend swatch and the tooltip dot take the series colour from itemStyle: a line that only coloured its stroke showed a palette colour there, not its own
    const it = isObj(s.itemStyle) ? s.itemStyle : {};
    if (typeof ls.color === "string" && it.color === undefined) out.itemStyle = { ...it, color: ls.color };
    if (isObj(s.endLabel)) out.endLabel = lift(s.endLabel, wide);
    if (isObj(s.label)) out.label = lift(s.label, wide);
  }
  if (s.type === "bar") {
    const it = isObj(s.itemStyle) ? s.itemStyle : {};
    // Rounded on the end away from the axis, per bar: a bar below zero (or to the left of it) is rounded at its bottom (left), not at the axis. A stacked series is left square: a rounded
    // segment inside a stack leaves notches. A radius the chart set itself, on the series or on a bar, is kept.
    if (it.borderRadius === undefined && s.stack === undefined && Array.isArray(s.data)) {
      out.data = (s.data as unknown[]).map((d) => {
        const v = barValue(d, horizontal);
        if (v == null) return d;
        const own = isObj(d) && isObj(d.itemStyle) && d.itemStyle.borderRadius !== undefined;
        if (own) return d;
        const base: Obj = isObj(d) ? { ...d } : Array.isArray(d) ? { value: d } : { value: d };
        return { ...base, itemStyle: { ...(isObj(base.itemStyle) ? base.itemStyle : {}), borderRadius: barRadius(v, horizontal) } };
      });
    }
  }
  if (isObj(s.markLine) && isObj(s.markLine.label)) out.markLine = { ...s.markLine, label: lift(s.markLine.label, wide) };
  if (isObj(s.markArea) && isObj(s.markArea.label)) out.markArea = { ...s.markArea, label: lift(s.markArea.label, wide) };
  return out;
};

/** The option with the app's chart look filled in. ``width`` is the chart's container width in px (a narrow chart keeps its small text). */
export function withChartTheme<O extends object>(option: O, t: ThemeTokens, width: number): O {
  const o = option as Obj;
  const wide = width <= 0 || width >= THEME_MIN_WIDTH;
  const out: Obj = { ...o };
  if (out.color === undefined) out.color = t.dark ? PALETTE_DARK : PALETTE_LIGHT;
  out.textStyle = { fontFamily: t.font, ...(isObj(o.textStyle) ? o.textStyle : {}) };

  const tip = (x: Obj): Obj => {
    const ts = isObj(x.textStyle) ? x.textStyle : {};
    const pointer = x.trigger === "axis" && x.axisPointer === undefined ? { axisPointer: { type: "line", lineStyle: { color: t.muted, type: "dashed", width: 1 } } } : {};
    return {
      backgroundColor: t.slate, borderColor: t.rule, borderWidth: 1, padding: [8, 11],
      extraCssText: "border-radius:10px;box-shadow:0 10px 28px rgba(8,16,36,.22);",
      ...pointer, ...x, textStyle: { color: t.paper, fontSize: 12.5, ...ts },
    };
  };
  if (o.tooltip !== undefined) out.tooltip = mapEach(o.tooltip, tip);

  const legend = (x: Obj): Obj => {
    const ts = isObj(x.textStyle) ? lift(x.textStyle, wide) as Obj : {};
    return { itemGap: 16, icon: "roundRect", ...x, textStyle: { color: t.paper, fontSize: MIN_FONT, fontWeight: 500, ...ts } };
  };
  if (o.legend !== undefined) out.legend = mapEach(o.legend, legend);

  if (o.xAxis !== undefined) out.xAxis = mapEach(o.xAxis, (a) => fixAxis(a, wide, t, a.type === "value"));
  if (o.yAxis !== undefined) out.yAxis = mapEach(o.yAxis, (a) => fixAxis(a, wide, t, a.type === undefined || a.type === "value" || a.type === "log"));
  const ax = (a: unknown): Obj | undefined => (Array.isArray(a) ? (a[0] as Obj | undefined) : (a as Obj | undefined));
  const horizontal = ax(o.yAxis)?.type === "category" && ax(o.xAxis)?.type !== "category"; // bars lie sideways when the categories run down the page
  if (Array.isArray(o.series)) out.series = o.series.map((s) => (isObj(s) ? fixSeries(s, wide, horizontal) : s));
  return out as O;
}

/** Exposed for tests. */
export const _internal = { one, lift, fixLabel };
