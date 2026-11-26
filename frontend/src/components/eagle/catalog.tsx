import type { ReactNode } from "react";
import { useDash } from "../dashboard/DashContext";
import { WIDGETS } from "../dashboard/widgets";
import { DayBoard } from "../intelligence/DayBoard";
import { EdgeMonitor } from "../intelligence/EdgeMonitor";
import { StraddleSummaryCard } from "../intelligence/StraddleDecay";
import { RunningMtmChart, RunningTimeChart } from "../RunningStrategy";
import { ToolBody, hasToolBody } from "../ToolBody";
import { TrendRegime } from "../../pages/TrendRegime";
import { TOOLS, toolPath, type Tool } from "../../lib/tools";
import { TREND_VIEWS } from "../../lib/trendViews";
import type { Size } from "../../lib/eagle";

/**
 * Every widget the Eagles view can show. "fit" widgets draw their chart or table to the size of their box (the option-chain widgets of the Analysis page);
 * "page" widgets are a whole tool (its controls and charts) that scrolls inside its box. Built from the registries that already exist, so a tool added to
 * ``lib/tools.ts`` or ``components/dashboard/widgets.tsx`` shows up here without a second list to keep.
 */
export interface EagleDef extends Size {
  id: string;
  title: string;
  group: string;
  kind: "fit" | "page";
  /** whether the widget draws a chart; the board in "Charts only" mode offers only these */
  charts: boolean;
  /** one line, shown in the picker */
  blurb: string;
  render: () => ReactNode;
}

/** The group each option-chain widget is listed under (the registry has none). */
const CHAIN_GROUP: Record<string, string> = {
  spot: "Snapshot and chain", chain: "Snapshot and chain", levels: "Snapshot and chain", detail: "Snapshot and chain",
  oi: "Open interest", oiChange: "Open interest", oiTotal: "Open interest", oiChangeTotal: "Open interest", oiIntraday: "Open interest", oiHeatmap: "Open interest", oiConcentration: "Open interest",
  oiBuildup: "Open interest", oiTotalTrend: "Open interest", oiChangeTrend: "Open interest", oiVolumeTrend: "Open interest", volume: "Open interest", peCe: "Open interest", smartOi: "Open interest", priceOi: "Open interest",
  pcr: "Put-call ratio", pcrTrend: "Put-call ratio",
  premium: "Price and premium", decay: "Price and premium", straddle: "Price and premium",
  futOi: "Futures", futOiChange: "Futures", futBasis: "Futures", futVolume: "Futures",
  gex: "Greeks and volatility", vega: "Greeks and volatility", ivSkew: "Greeks and volatility",
};

/** The expiry the whole board is looking at, handed to the tool bodies that take one. */
function Body({ tool }: { tool: Tool }) {
  const d = useDash();
  return <ToolBody tool={tool} expiry={d.expiry} />;
}

/** Widgets and tools that are a table, cards or text with no chart (a chart that turns up in one is still shown: the board also looks at what is drawn). */
const NO_CHART = new Set(["w:chain", "w:levels", "w:detail", "w:oiConcentration", "w:pcr", "t:signal-backtest", "t:market-structure", "t:strike-positioning", "t:future-flow", "t:future-sectors", "t:economic-calendar", "t:market-news", "t:index-weightage", "t:market-movers", "t:advance-decline"]);

const chainDefs: EagleDef[] = WIDGETS.map((w) => ({
  id: `w:${w.id}`, title: w.title, group: CHAIN_GROUP[w.id] ?? "Snapshot and chain", kind: "fit", charts: !NO_CHART.has(`w:${w.id}`), blurb: "Fits its box: resize it and the chart follows.",
  // small boxes by default: a third of the width at most, unless the widget needs a wide table
  w: Math.min(w.w, w.id === "smartOi" ? 12 : w.id === "chain" || w.id === "oiBuildup" ? 8 : 4), h: Math.min(w.h, w.id === "smartOi" ? 18 : 9), minW: Math.min(w.minW, 3), minH: Math.min(w.minH, 5), render: w.render,
}));

const toolDefs: EagleDef[] = TOOLS.filter((t) => t.status === "ready" && !t.to && !t.tab && hasToolBody(t) && toolPath(t)).map((t) => ({
  id: `t:${t.id}`, title: t.label, group: t.group, kind: "page" as const, charts: !NO_CHART.has(`t:${t.id}`), blurb: t.blurb,
  w: 6, h: 16, minW: 3, minH: 6, render: () => <Body tool={t} />,
}));

const trendDefs: EagleDef[] = TREND_VIEWS.map((v) => ({
  id: `r:${v.id}`, title: v.label, group: "Trend & Regime", kind: "page" as const, charts: true, blurb: v.blurb,
  w: 6, h: 16, minW: 3, minH: 6, render: () => <TrendRegime view={v.id} />,
}));

const intelDefs: EagleDef[] = [
  { id: "i:day-board", title: "Market Intelligence: day board", group: "Market Intelligence", kind: "page", charts: true, blurb: "Sentiment through the day, phases, expected outcome and the track record.", w: 8, h: 22, minW: 4, minH: 8, render: () => <DayBoard /> },
  { id: "i:edge", title: "Market Intelligence: edge monitor", group: "Market Intelligence", kind: "page", charts: true, blurb: "Does any indicator beat luck? Scored automatically every night.", w: 6, h: 20, minW: 3, minH: 8, render: () => <EdgeMonitor /> },
  { id: "i:straddle", title: "Straddle decay summary", group: "Market Intelligence", kind: "page", charts: true, blurb: "The seller and buyer reading of the ATM straddle, in a card.", w: 4, h: 12, minW: 3, minH: 6, render: () => <StraddleSummaryCard /> },
];

const strategyDefs: EagleDef[] = [
  { id: "s:mtm", title: "Running strategy: mark-to-market", group: "My strategy", kind: "page", charts: true, blurb: "The P&L of the strategy running now (booked + open) through the day, from the stored one-minute prices and then live.", w: 6, h: 14, minW: 3, minH: 6, render: () => <RunningMtmChart /> },
  { id: "s:time", title: "Running strategy: price and P&L vs NIFTY", group: "My strategy", kind: "page", charts: true, blurb: "The running strategy as one price through the day against NIFTY, with its averages, bands and what moved it.", w: 6, h: 16, minW: 3, minH: 6, render: () => <RunningTimeChart /> },
];

export const CATALOG: EagleDef[] = [...strategyDefs, ...chainDefs, ...intelDefs, ...trendDefs, ...toolDefs];
export const CATALOG_BY_ID: ReadonlyMap<string, EagleDef> = new Map(CATALOG.map((d) => [d.id, d]));
export const sizeOf = (cat: string): Size | undefined => CATALOG_BY_ID.get(cat);

/** The groups of the picker, in a fixed order that puts the board's own tools first. */
const ORDER = ["My strategy", "Market Intelligence", "Trend & Regime", "Snapshot and chain", "Open interest", "Put-call ratio", "Price and premium", "Futures", "Greeks and volatility"];
export function catalogGroups(query = "", chartsOnly = false): { group: string; defs: EagleDef[] }[] {
  const q = query.trim().toLowerCase();
  const all = chartsOnly ? CATALOG.filter((d) => d.charts) : CATALOG;
  const pool = q ? all.filter((d) => `${d.title} ${d.group} ${d.blurb}`.toLowerCase().includes(q)) : all;
  const names = [...new Set(pool.map((d) => d.group))].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return names.map((group) => ({ group, defs: pool.filter((d) => d.group === group) }));
}

/** What a new board starts with: the picture of the day in nine small boxes. */
export const STARTER = ["i:day-board", "r:market-regime", "w:spot", "w:oi", "w:oiChange", "w:straddle", "w:pcrTrend", "w:gex", "w:futBasis"];
