/** The ways the swing rules are run, in one list, so the page can say plainly what each one is.
 *  There are two paper books, kept apart (the official one and the live one), and a backtest of the past.
 *  Each entry is written from the rules and panels that implement it (backend/app/swing, components/swing); change them together. */
export type ModeRole = "official" | "live" | "history";
export type TopTab = "paper" | "live" | "backtest" | "rules";
export type BacktestSub = "results" | "trades" | "robustness";

export interface SwingMode {
  id: "official" | "live" | "backtest";
  name: string;
  role: ModeRole;
  /** the price data the rules read */
  data: string;
  /** when a decision is taken */
  decides: string;
  /** the price a trade is filled at */
  fills: string;
  /** how it relates to the other book */
  effect: string;
  /** where on the page it lives */
  tab: TopTab;
  sub?: BacktestSub;
}

export const ROLE_LABEL: Record<ModeRole, string> = { official: "Official paper book", live: "Live paper book: separate", history: "History: not live" };

export const MODES: SwingMode[] = [
  {
    id: "official", name: "Official paper book", role: "official",
    data: "NSE daily bars (end of day)",
    decides: "Once a day, in the evening run after 17:00 IST, on the whole day",
    fills: "The larger of the day's open and the trigger, with 0.15% cost per side",
    effect: "Its own cash, positions, stops, trades and equity",
    tab: "paper",
  },
  {
    id: "live", name: "Live paper book", role: "live",
    data: "Live Kotak prices, built into completed 1-minute candles",
    decides: "On the close of each 1-minute candle: entries 09:30-15:00, stops on every close, day-1 check at 15:20",
    fills: "The next candle's open, with 0.15% cost per side",
    effect: "Its own cash, positions, stops, trades and equity. It takes the same queued candidate orders but never reads or changes the official book's positions; each evening it is compared with it",
    tab: "live",
  },
  {
    id: "backtest", name: "Backtest", role: "history",
    data: "NSE daily bars over the past, built on the research PC",
    decides: "The same daily rules, replayed over history",
    fills: "Simulated on the daily bar, shown before and after 0.15% cost per side",
    effect: "None. It describes the past; it is not live and not a forecast",
    tab: "backtest", sub: "results",
  },
];

/** The sentence at the top of the page: how many books, and what the rest is. */
export function modeSummary(modes: readonly SwingMode[] = MODES): string {
  const books = modes.filter((m) => m.role !== "history").length;
  const hist = modes.filter((m) => m.role === "history").length;
  return `${books} paper books run side by side and kept apart, and ${hist} backtest of the past.`;
}
