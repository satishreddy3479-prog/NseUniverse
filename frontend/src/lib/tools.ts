/**
 * Every tool the app offers, in one place: the top menu, the home page and the tool pages are all built from this list.
 * A tool is "ready" only when a page really exists and is fed by our own live or stored data; anything else is listed as
 * "planned" with the reason, and is shown greyed out in the menu rather than as a page with made-up numbers.
 */
export type MenuId = "fno" | "analyse";
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
  /** chart boards built from the stored per-strike series (components/dashboard/PriceBoards.tsx) */
  board?: "priceOi" | "multiStrike" | "multiStraddle" | "rollingStraddle" | "vega" | "gamma" | "premiumChange";
  /** the page can replay a stored session on one shared clock (components/dashboard/ReplayBar.tsx) */
  replay?: boolean;
  /** a special page body (see pages/ToolPage.tsx) */
  page?: "flows" | "cash" | "contributors" | "weightage" | "breadth" | "sectors" | "movers" | "futflow" | "futsectors" | "futbuildup" | "ivhv" | "ivchart" | "ivskew" | "ivmomentum" | "backtest" | "marketstructure" | "strikepos" | "ivintraday" | "global" | "calendar" | "news" | "forward" | "forwardcost";
  /** why a planned tool is not available yet */
  needs?: string;
  isNew?: boolean;
  popular?: boolean;
  /** a tab of its group's page family: reachable from the tabs above the page, not listed on its own in the menus, the search or the recent tools (the group's first tool stands for the family) */
  tab?: boolean;
}

export const MENU_TITLES: Record<MenuId, string> = { fno: "FNO Tools", analyse: "Analyse" };
export const MENU_ORDER: MenuId[] = ["fno", "analyse"];

export const TOOLS: Tool[] = [
  // ---- FNO Tools (options first, then futures)
  { id: "option-chain", label: "Option Chain", menu: "fno", group: "Live chain", status: "ready", to: "/option-chain", popular: true, blurb: "The live NIFTY option chain by strike: prices, open interest, volume and implied volatility, with the stream overlaid on the stored snapshot." },
  { id: "open-interest", label: "Open Interest", menu: "fno", group: "OI tools", status: "ready", popular: true, widgets: ["oi", "oiChange", "oiConcentration", "oiTotal", "oiChangeTotal"], blurb: "Open interest and its change by strike, where it is concentrated, and the total call and put open interest and its change." },
  { id: "multi-oi-volume", replay: true, label: "Multi OI & Volume", menu: "fno", group: "OI tools", status: "ready", widgets: ["oiTotalTrend", "oiChangeTrend", "oiVolumeTrend"], blurb: "Total call and put OI, OI change and volume through the session." },
  { id: "put-call-ratio", label: "Put-Call Ratio", menu: "fno", group: "OI tools", status: "ready", widgets: ["pcr", "pcrTrend"], blurb: "PCR at the money and overall, and how it moved during the session." },
  { id: "max-pain", label: "Max Pain", menu: "fno", group: "OI tools", status: "ready", widgets: ["levels"], blurb: "Max pain, highest call and put OI strikes and other key levels." },
  { id: "gamma-exposure", replay: true, label: "Gamma Exposure", menu: "fno", group: "OI tools", status: "ready", isNew: true, board: "gamma", blurb: "Gamma exposure of the chain: regime, call and put walls, peak gamma, gamma flip, smoothed density, structure through the session and a strike table, from open interest and each contract\'s own implied volatility." },
  { id: "pe-ce-difference", label: "PE-CE Difference", menu: "fno", group: "Popular tools", status: "ready", popular: true, isNew: true, widgets: ["peCe"], blurb: "Put minus call open interest, OI change and volume strike by strike." },
  { id: "smart-oi", replay: true, label: "Smart OI", menu: "fno", group: "Popular tools", status: "ready", isNew: true, popular: true, widgets: ["smartOi"], blurb: "Put OI change minus call OI change inside every 1, 3, 5 or 15 minute candle, beside NIFTY, with day change and PCR." },
  { id: "oi-buildup", label: "OI Buildup", menu: "fno", group: "OI tools", status: "ready", isNew: true, widgets: ["oiBuildup"], blurb: "Long buildup, short buildup, short covering and long unwinding for every strike." },
  { id: "vega-analysis", replay: true, label: "Vega Analysis", menu: "fno", group: "Popular tools", status: "ready", isNew: true, board: "vega", blurb: "Call and put vega of a strike window with replay, the vega change of the anchored band since a baseline, statistics and a plain-language reading." },
  { id: "straddle", replay: true, label: "ATM Straddle Chart", menu: "fno", group: "Price tools", status: "ready", popular: true, widgets: ["straddle"], blurb: "At-the-money call plus put premium over the session." },
  { id: "premium-decay", label: "Premium Decay", menu: "fno", group: "Price tools", status: "ready", widgets: ["premium", "decay"], blurb: "How option premium decays through the day, strike by strike." },
  { id: "price-vs-oi", label: "Price vs OI", menu: "fno", group: "Price tools", status: "ready", board: "priceOi", blurb: "One strike's call and put price against its open interest and OI change through the session." },
  { id: "multistrike-chart", label: "MultiStrike Chart", menu: "fno", group: "Price tools", status: "ready", isNew: true, board: "multiStrike", blurb: "Price, OI or OI change of several strikes on one chart, calls and puts side by side." },
  { id: "rolling-straddle", replay: true, label: "ATM Rolling Straddle", menu: "fno", group: "Price tools", status: "ready", isNew: true, popular: true, board: "rollingStraddle", blurb: "The straddle of the strike you would hold as spot moves: rolling versus fixed premium, a roll-adjusted premium with no jumps, implied move, break-even band, every roll and its credit." },
  { id: "premium-change", replay: true, label: "Premium Change", menu: "fno", group: "Price tools", status: "ready", isNew: true, popular: true, board: "premiumChange", blurb: "What drove the change of the ATM straddle (and of every strike) in each window: time passing, NIFTY moving, or volatility and the rest, split so the parts add up to the real change." },
  { id: "multi-straddle", label: "Multi-Straddle Chart", menu: "fno", group: "Price tools", status: "ready", isNew: true, board: "multiStraddle", blurb: "The straddle price of several strikes on one chart." },
  { id: "signal-backtest", label: "Signal Backtest", menu: "fno", group: "Positioning", status: "ready", isNew: true, page: "backtest", blurb: "Chronological out-of-sample tests of skew, IV momentum, OI and butterfly signals against what NIFTY did next, with sample sizes and intervals." },
  { id: "market-structure", label: "Market Structure", menu: "fno", group: "Positioning", status: "ready", isNew: true, page: "marketstructure", blurb: "One view of regime, volatility, positioning and gamma, with the evidence for and against each reading." },
  { id: "strike-positioning", label: "Strike Positioning", menu: "fno", group: "Positioning", status: "ready", isNew: true, page: "strikepos", blurb: "Strike-by-strike premium, OI, volume, IV and delta changes, OTM demand readings and premium baskets, with every label tied to its evidence." },
  { id: "iv-momentum", label: "IV Momentum", menu: "fno", group: "IV tools", status: "ready", isNew: true, page: "ivmomentum", blurb: "Call versus put IV change at ATM, 25 and 10 delta over 1 minute to 1 hour and since the previous close." },
  { id: "volatility-skew", label: "Volatility Skew", menu: "fno", group: "IV tools", status: "ready", isNew: true, page: "ivskew", blurb: "The volatility smile, 25 and 10 delta skew, butterfly, slope and term structure from the stored chain." },
  { id: "iv-hvp", label: "IV / HV / IVP Chart", menu: "fno", group: "IV tools", status: "ready", isNew: true, page: "ivchart", blurb: "India VIX against historical volatility with IV rank and IV percentile, and NIFTY as the price line." },
  { id: "iv-hv", label: "IV - HV", menu: "fno", group: "IV tools", status: "ready", isNew: true, page: "ivhv", blurb: "At-the-money implied volatility against historical volatility (10, 20, 30 and 60 days) from stored daily closes." },
  { id: "iv-intraday", label: "IV - Intraday", menu: "fno", group: "IV tools", status: "ready", isNew: true, page: "ivintraday", blurb: "At-the-money implied volatility through the session, one value per stored snapshot." },
  // ---- Future Lab
  { id: "future-dashboard", label: "Future Dashboard", menu: "fno", group: "Futures price", status: "ready", popular: true, widgets: ["futBasis", "futOi", "futOiChange", "futVolume"], blurb: "NIFTY futures: spot-futures gap, open interest, OI change and volume." },
  { id: "future-intraday", label: "Future Intraday", menu: "fno", group: "Futures price", status: "ready", widgets: ["futBasis", "futVolume"], blurb: "The futures against spot through the session, and its volume." },
  { id: "future-flow", label: "Future Flow & Heavyweights", menu: "fno", group: "Futures price", status: "ready", isNew: true, page: "futflow", blurb: "NIFTY current-month future flow (estimated net buying, book imbalance) and the top-5 heavyweights." },
  { id: "future-sectors", label: "Future Sectors", menu: "fno", group: "Futures price", status: "ready", isNew: true, page: "futsectors", blurb: "Equal-weighted NIFTY 500 sector strength against the index, with rotation." },
  { id: "market-movers", label: "Market Movers", menu: "fno", group: "Futures price", status: "ready", isNew: true, page: "movers", blurb: "NIFTY 50 stocks ranked by move and contribution (NIFTY 50 only)." },
  { id: "future-oi", label: "Future Open Interest", menu: "fno", group: "Futures OI", status: "ready", widgets: ["futOi", "futOiChange"], blurb: "NIFTY futures open interest and its change." },
  { id: "future-price-oi", label: "Future Price vs OI", menu: "fno", group: "Futures OI", status: "ready", isNew: true, page: "futbuildup", blurb: "NIFTY future price against open interest: long/short buildup, short covering, long unwinding per 15 minutes and for the session." },
  // ---- Analyse
  { id: "eagles-view", label: "Eagles view", menu: "analyse", group: "Boards", status: "ready", to: "/eagles-view", isNew: true, popular: true, blurb: "Every tool as a small box on one board: add the ones you want, as many times as you like, move and resize them, remove what you do not need." },
  { id: "advanced-greeks", label: "Advanced Greeks", menu: "analyse", group: "Risk", status: "ready", to: "/advanced-greeks", isNew: true, popular: true, blurb: "The Greeks of your option legs in rupees by leg, expiry and limit, the gamma map and the volatility surface. Scenarios (index, volatility, time, rates) are in the Strategy Builder." },
  { id: "market-regime", label: "Trend & Regime", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/market-regime", isNew: true, popular: true, blurb: "Is the session trending or range-bound? Four readings vote; label, confidence and reasons are shown with the regime shaded behind the NIFTY candles. Descriptive, not validated." },
  { id: "trend-strength", tab: true, label: "Trend Strength", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/trend-strength", isNew: true, blurb: "Efficiency ratio, ADX with +DI / −DI and R² of a straight-line fit, bar by bar." },
  { id: "chop-variance", tab: true, label: "Choppiness & Variance Ratio", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/chop-variance", isNew: true, blurb: "Choppiness index and the Lo–MacKinlay variance ratio with its z." },
  { id: "session-structure", tab: true, label: "Session Structure (TWAP / VWAP)", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/session-structure", isNew: true, blurb: "NIFTY against its session mean and the future's VWAP: time above, crossings, longest stay, distance in ATR." },
  { id: "opening-range", tab: true, label: "Opening Range", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/opening-range", isNew: true, blurb: "The opening range and what the price did with it: breakouts and failed breakouts." },
  { id: "range-used", tab: true, label: "Range Used vs Implied Move", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/range-used", isNew: true, blurb: "How much of a normal day's range, as the options price it, has been used." },
  { id: "gamma-regime", tab: true, label: "Gamma Regime", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/gamma-regime", isNew: true, blurb: "Positive or negative gamma from the live chain: net GEX, flip and walls." },
  { id: "daily-regime", tab: true, label: "Daily Regime (validated?)", menu: "analyse", group: "Trend & Regime", status: "ready", to: "/trend/daily-regime", isNew: true, blurb: "The same label on 18 years of daily closes with a pre-registered validation study; the verdict is shown as it came out." },
  { id: "fii-dii-summary", label: "FII/DII Summary", menu: "analyse", group: "FII / DII", status: "ready", page: "flows", blurb: "Institutional derivatives positioning from the exchange's published data." },
  { id: "fii-dii-cash", label: "FII/DII Cash Market", menu: "analyse", group: "FII / DII", status: "ready", page: "cash", blurb: "Cash-market buying and selling by FII and DII, from the data you import." },
  { id: "index-contributors", label: "Index Contributors", menu: "analyse", group: "Index", status: "ready", isNew: true, page: "contributors", blurb: "Which NIFTY 50 stocks are moving the index, in points." },
  { id: "advance-decline", label: "Advance Decline", menu: "analyse", group: "Index", status: "ready", page: "breadth", blurb: "How many NIFTY 50 stocks are up and down." },
  { id: "index-weightage", label: "Index Weightage", menu: "analyse", group: "Index", status: "ready", page: "weightage", blurb: "NIFTY 50 weights, with their source and date." },
  { id: "sector-rotation", label: "Sector Rotation", menu: "analyse", group: "Index", status: "ready", isNew: true, page: "sectors", blurb: "Sector strength inside NIFTY 50 and its change in rank." },
  { id: "forward-test", label: "Forward Test", menu: "analyse", group: "Testing", status: "ready", isNew: true, popular: true, page: "forward", blurb: "Paper short straddles and strangles opened whenever the seller score reaches 60, with plain stop losses of 30 to 80% and combined stops tracked side by side and broken down by market regime." },
  { id: "forward-test-cost", label: "Forward Test · SL to cost", menu: "analyse", group: "Testing", status: "ready", isNew: true, page: "forwardcost", blurb: "The same paper positions with Move SL to cost: when one leg's stop fires, the other leg's stop moves to its entry price. A separate test, with each rule beside the plain stop of the same percentage." },
  { id: "global-markets", label: "Global Markets", menu: "analyse", group: "World", status: "ready", isNew: true, popular: true, page: "global", blurb: "US index futures and cash indices, VIX, the 10-year yield, dollar, gold, silver, Brent and the Asian indices, each with its age and status." },
  { id: "economic-calendar", label: "Economic Calendar", menu: "analyse", group: "World", status: "ready", isNew: true, page: "calendar", blurb: "The high-impact events ahead, in IST: today, tomorrow, the rest of the week, next week and later this month." },
  { id: "market-news", label: "News", menu: "analyse", group: "World", status: "ready", isNew: true, page: "news", blurb: "Latest Indian and global market headlines from Economic Times, BBC and CNBC, linked to the publisher." },
];

export const toolPath = (t: Tool): string | null => (t.status !== "ready" ? null : t.to ?? `/tools/${t.id}`);
export const toolById = (id: string | undefined): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Dropdown content: groups in the order they first appear. */
export function menuGroups(menu: MenuId): { group: string; tools: Tool[] }[] {
  const out: { group: string; tools: Tool[] }[] = [];
  for (const t of TOOLS.filter((x) => x.menu === menu && !x.tab)) {
    let g = out.find((x) => x.group === t.group);
    if (!g) out.push((g = { group: t.group, tools: [] }));
    g.tools.push(t);
  }
  return out;
}

/** Sites opened in a new tab from the Analyse menu and the calendar and news pages (not read by this app). */
export const QUICK_LINKS = [
  { id: "mc-calendar", label: "📅 Open Moneycontrol Economic Calendar ↗", href: "https://www.moneycontrol.com/economic-calendar" },
  { id: "redbox-squawk", label: "🔴 Open Redbox India Live Squawk ↗", href: "https://x.com/REDBOXINDIA" },
] as const;
