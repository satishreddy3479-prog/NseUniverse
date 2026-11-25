import type { ReactNode } from "react";
import { useDash } from "../dashboard/DashContext";
import { WIDGETS } from "../dashboard/widgets";
import { DayBoard } from "../intelligence/DayBoard";
import { EdgeMonitor } from "../intelligence/EdgeMonitor";
import { StraddleSummaryCard } from "../intelligence/StraddleDecay";
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

const chainDefs: EagleDef[] = WIDGETS.map((w) => ({
  id: `w:${w.id}`, title: w.title, group: CHAIN_GROUP[w.id] ?? "Snapshot and chain", kind: "fit", blurb: "Fits its box: resize it and the chart follows.",
  // small boxes by default: a third of the width at most, unless the widget needs a wide table
  w: Math.min(w.w, w.id === "chain" || w.id === "smartOi" || w.id === "oiBuildup" ? 8 : 4), h: Math.min(w.h, w.id === "smartOi" ? 18 : 9), minW: Math.min(w.minW, 3), minH: Math.min(w.minH, 5), render: w.render,
}));

const toolDefs: EagleDef[] = TOOLS.filter((t) => t.status === "ready" && !t.to && !t.tab && hasToolBody(t) && toolPath(t)).map((t) => ({
  id: `t:${t.id}`, title: t.label, group: t.group, kind: "page" as const, blurb: t.blurb,
  w: 6, h: 16, minW: 3, minH: 6, render: () => <Body tool={t} />,
}));

const trendDefs: EagleDef[] = TREND_VIEWS.map((v) => ({
  id: `r:${v.id}`, title: v.label, group: "Trend & Regime", kind: "page" as const, blurb: v.blurb,
  w: 6, h: 16, minW: 3, minH: 6, render: () => <TrendRegime view={v.id} />,
}));

const intelDefs: EagleDef[] = [
  { id: "i:day-board", title: "Market Intelligence: day board", group: "Market Intelligence", kind: "page", blurb: "Sentiment through the day, phases, expected outcome and the track record.", w: 8, h: 22, minW: 4, minH: 8, render: () => <DayBoard /> },
  { id: "i:edge", title: "Market Intelligence: edge monitor", group: "Market Intelligence", kind: "page", blurb: "Does any indicator beat luck? Scored automatically every night.", w: 6, h: 20, minW: 3, minH: 8, render: () => <EdgeMonitor /> },
  { id: "i:straddle", title: "Straddle decay summary", group: "Market Intelligence", kind: "page", blurb: "The seller and buyer reading of the ATM straddle, in a card.", w: 4, h: 12, minW: 3, minH: 6, render: () => <StraddleSummaryCard /> },
];

export const CATALOG: EagleDef[] = [...chainDefs, ...intelDefs, ...trendDefs, ...toolDefs];
export const CATALOG_BY_ID: ReadonlyMap<string, EagleDef> = new Map(CATALOG.map((d) => [d.id, d]));
export const sizeOf = (cat: string): Size | undefined => CATALOG_BY_ID.get(cat);

/** The groups of the picker, in a fixed order that puts the board's own tools first. */
const ORDER = ["Market Intelligence", "Trend & Regime", "Snapshot and chain", "Open interest", "Put-call ratio", "Price and premium", "Futures", "Greeks and volatility"];
export function catalogGroups(query = ""): { group: string; defs: EagleDef[] }[] {
  const q = query.trim().toLowerCase();
  const pool = q ? CATALOG.filter((d) => `${d.title} ${d.group} ${d.blurb}`.toLowerCase().includes(q)) : CATALOG;
  const names = [...new Set(pool.map((d) => d.group))].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return names.map((group) => ({ group, defs: pool.filter((d) => d.group === group) }));
}

/** What a new board starts with: the picture of the day in nine small boxes. */
export const STARTER = ["i:day-board", "r:market-regime", "w:spot", "w:oi", "w:oiChange", "w:straddle", "w:pcrTrend", "w:gex", "w:futBasis"];
