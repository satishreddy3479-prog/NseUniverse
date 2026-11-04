/**
 * Every tool the app offers, in one place: the top menu, the home page and the tool pages are all built from this list.
 * A tool is "ready" only when a page really exists and is fed by our own live or stored data; anything else is listed as
 * "planned" with the reason, and is shown greyed out in the menu rather than as a page with made-up numbers.
 */
export type MenuId = "options" | "futures" | "analyse";
export type ToolStatus = "ready" | "planned";

export interface Tool {
  id: string;
  label: string;
  /** which top-menu dropdown it sits in, and under which heading */
  menu: MenuId;
  group: string;
  blurb: string;
  status: ToolStatus;
  /** page that already exists (strategy builder, intraday analysis, ...) */
  to?: string;
  /** dashboard widgets (ids in components/dashboard/widgets.tsx) stacked on the tool page */
  widgets?: string[];
  /** a special page body (see pages/ToolPage.tsx) */
  page?: "flows" | "cash" | "contributors" | "weightage" | "breadth" | "sectors" | "movers";
  /** why a planned tool is not available yet */
  needs?: string;
  isNew?: boolean;
  popular?: boolean;
}

export const MENU_TITLES: Record<MenuId, string> = { options: "Options Lab", futures: "Future Lab", analyse: "Analyse" };
export const MENU_ORDER: MenuId[] = ["options", "futures", "analyse"];

export const TOOLS: Tool[] = [
  // ---- Options Lab
  { id: "open-interest", label: "Open Interest", menu: "options", group: "OI tools", status: "ready", popular: true, widgets: ["oi", "oiChange", "oiConcentration"], blurb: "Open interest and its change by strike, and where it is concentrated." },
  { id: "multi-oi-volume", label: "Multi OI & Volume", menu: "options", group: "OI tools", status: "ready", widgets: ["oiTotalTrend", "oiChangeTrend", "oiVolumeTrend"], blurb: "Total call and put OI, OI change and volume through the session." },
  { id: "put-call-ratio", label: "Put-Call Ratio", menu: "options", group: "OI tools", status: "ready", widgets: ["pcr", "pcrTrend"], blurb: "PCR at the money and overall, and how it moved during the session." },
  { id: "max-pain", label: "Max Pain", menu: "options", group: "OI tools", status: "ready", widgets: ["levels"], blurb: "Max pain, highest call and put OI strikes and other key levels." },
  { id: "gamma-exposure", label: "Gamma Exposure", menu: "options", group: "OI tools", status: "ready", isNew: true, widgets: ["gex"], blurb: "Strike-wise gamma from open interest, computed from the chain's own prices." },
  { id: "pe-ce-difference", label: "PE-CE Difference", menu: "options", group: "Popular tools", status: "ready", popular: true, isNew: true, widgets: ["peCe"], blurb: "Put minus call open interest, OI change and volume strike by strike." },
  { id: "timeseries", label: "Timeseries", menu: "options", group: "Popular tools", status: "ready", widgets: ["oiIntraday", "oiHeatmap"], blurb: "How each strike's OI changed minute by minute, as a chart and a heatmap." },
  { id: "smart-oi", label: "Smart OI", menu: "options", group: "Popular tools", status: "ready", isNew: true, popular: true, widgets: ["smartOi"], blurb: "Long buildup, short buildup, short covering and long unwinding for every strike." },
  { id: "strategy-chart", label: "Strategy Chart", menu: "options", group: "Popular tools", status: "ready", to: "/strategy", blurb: "Payoff and risk of a strategy you build from the chain." },
  { id: "vega-analysis", label: "Vega Analysis", menu: "options", group: "Popular tools", status: "ready", isNew: true, widgets: ["vega"], blurb: "Strike-wise vega from open interest: where a volatility change would matter most." },
  { id: "straddle", label: "ATM Straddle Chart", menu: "options", group: "Price tools", status: "ready", popular: true, widgets: ["straddle"], blurb: "At-the-money call plus put premium over the session." },
  { id: "premium-decay", label: "Premium Decay", menu: "options", group: "Price tools", status: "ready", widgets: ["premium", "decay"], blurb: "How option premium decays through the day, strike by strike." },
  { id: "price-vs-oi", label: "Price vs OI", menu: "options", group: "Price tools", status: "ready", widgets: ["priceOi"], blurb: "NIFTY price against open interest through the session." },
  { id: "multistrike-chart", label: "MultiStrike Chart", menu: "options", group: "Price tools", status: "planned", needs: "Multi-strike price history needs the per-strike minute prices to be exposed by the backend.", blurb: "Several strikes' prices on one chart." },
  { id: "volatility-skew", label: "Volatility Skew", menu: "options", group: "IV tools", status: "ready", isNew: true, widgets: ["ivSkew"], blurb: "Implied volatility across strikes for calls and puts." },
  { id: "iv-hv", label: "IV - HV", menu: "options", group: "IV tools", status: "planned", needs: "Historical volatility has to be computed from stored daily closes; the endpoint is not built yet.", blurb: "Implied against historical volatility." },
  { id: "iv-grid", label: "IV Grid", menu: "options", group: "IV tools", status: "planned", needs: "Needs implied volatility stored per strike over time.", blurb: "Implied volatility by strike and time." },
  { id: "iv-intraday", label: "IV - Intraday", menu: "options", group: "IV tools", status: "planned", needs: "Needs at-the-money IV computed for every stored snapshot.", blurb: "At-the-money implied volatility through the session." },
  { id: "oi-crossover", label: "OI Crossover", menu: "options", group: "Screeners", status: "planned", needs: "Needs a rule for the crossover and its stored history.", blurb: "Strikes where call and put OI cross." },
  { id: "intraday-booster", label: "Intraday Booster", menu: "options", group: "Screeners", status: "ready", to: "/analysis", blurb: "Rules-based intraday command center built from the stored samples." },
  { id: "option-triggers", label: "Option Triggers", menu: "options", group: "Screeners", status: "planned", needs: "Alerts need a server-side rule engine and a delivery channel; neither exists yet.", blurb: "Alerts on option conditions." },
  // ---- Future Lab
  { id: "future-dashboard", label: "Future Dashboard", menu: "futures", group: "Price tools", status: "ready", popular: true, widgets: ["futBasis", "futOi", "futOiChange", "futVolume"], blurb: "NIFTY futures: spot-futures gap, open interest, OI change and volume." },
  { id: "future-intraday", label: "Future Intraday", menu: "futures", group: "Price tools", status: "ready", widgets: ["futBasis", "futVolume"], blurb: "The futures against spot through the session, and its volume." },
  { id: "market-movers", label: "Market Movers", menu: "futures", group: "Price tools", status: "ready", isNew: true, page: "movers", blurb: "NIFTY 50 stocks ranked by move and contribution (NIFTY 50 only)." },
  { id: "future-heatmap", label: "Future Heatmap", menu: "futures", group: "Price tools", status: "planned", needs: "Needs futures data for more than NIFTY, which is out of scope for now.", blurb: "Futures across many instruments." },
  { id: "future-oi", label: "Future Open Interest", menu: "futures", group: "OI tools", status: "ready", widgets: ["futOi", "futOiChange"], blurb: "NIFTY futures open interest and its change." },
  { id: "future-price-oi", label: "Future Price vs OI", menu: "futures", group: "OI tools", status: "planned", needs: "The futures price/OI buildup classification is not built yet.", blurb: "Futures price against OI." },
  { id: "sentiment-cycle", label: "Future Sentiment Cycle", menu: "futures", group: "OI tools", status: "planned", needs: "Needs a validated rule set; none has been agreed.", blurb: "Where the futures sit in the buildup cycle." },
  // ---- Analyse
  { id: "fii-dii-summary", label: "FII/DII Summary", menu: "analyse", group: "FII / DII", status: "ready", page: "flows", blurb: "Institutional derivatives positioning from the exchange's published data." },
  { id: "fii-dii-cash", label: "FII/DII Cash Market", menu: "analyse", group: "FII / DII", status: "ready", page: "cash", blurb: "Cash-market buying and selling by FII and DII, from the data you import." },
  { id: "index-contributors", label: "Index Contributors", menu: "analyse", group: "Index", status: "ready", isNew: true, page: "contributors", blurb: "Which NIFTY 50 stocks are moving the index, in points." },
  { id: "advance-decline", label: "Advance Decline", menu: "analyse", group: "Index", status: "ready", page: "breadth", blurb: "How many NIFTY 50 stocks are up and down." },
  { id: "index-weightage", label: "Index Weightage", menu: "analyse", group: "Index", status: "ready", page: "weightage", blurb: "NIFTY 50 weights, with their source and date." },
  { id: "sector-rotation", label: "Sector Rotation", menu: "analyse", group: "Index", status: "ready", isNew: true, page: "sectors", blurb: "Sector strength inside NIFTY 50 and its change in rank." },
];

export const toolPath = (t: Tool): string | null => (t.status !== "ready" ? null : t.to ?? `/tools/${t.id}`);
export const toolById = (id: string | undefined): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Dropdown content: groups in the order they first appear. */
export function menuGroups(menu: MenuId): { group: string; tools: Tool[] }[] {
  const out: { group: string; tools: Tool[] }[] = [];
  for (const t of TOOLS.filter((x) => x.menu === menu)) {
    let g = out.find((x) => x.group === t.group);
    if (!g) out.push((g = { group: t.group, tools: [] }));
    g.tools.push(t);
  }
  return out;
}
