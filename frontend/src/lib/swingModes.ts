/** Every way the swing rules are being run or tested, in one list, so the page can say plainly what each one is.
 *  Each entry is written from the rules and panels that implement it (backend/app/swing, components/swing); change them together. */
export type ModeRole = "official" | "shadow" | "history";
export type TopTab = "paper" | "live" | "backtest" | "rules";
export type LiveSub = "watch" | "ledger" | "minute";
export type BacktestSub = "results" | "trades" | "robustness";

export interface SwingMode {
  id: "official" | "watch" | "ledger" | "minute" | "backtest";
  letter: string;
  name: string;
  role: ModeRole;
  /** the price data the rules read */
  data: string;
  /** when a decision is taken */
  decides: string;
  /** the price a trade is filled at */
  fills: string;
  /** what it does to the official paper book */
  effect: string;
  /** where on the page it lives */
  tab: TopTab;
  sub?: LiveSub | BacktestSub;
}

export const ROLE_LABEL: Record<ModeRole, string> = { official: "Official: this is the book", shadow: "Shadow: a test, changes nothing", history: "History: not live" };

export const MODES: SwingMode[] = [
  {
    id: "official", letter: "A", name: "Official paper book", role: "official",
    data: "NSE daily bars (end of day)",
    decides: "Once a day, in the evening run after 17:00 IST, on the whole day",
    fills: "The larger of the day's open and the trigger, with 0.15% cost per side",
    effect: "It is the book: positions, trades and equity all come from here",
    tab: "paper",
  },
  {
    id: "watch", letter: "B", name: "Live price watch", role: "shadow",
    data: "Live Kotak prices, checked every few seconds",
    decides: "Shows 'triggered so far' and stop levels during the session; what the rules would do is logged once a day",
    fills: "None: it only displays",
    effect: "None. The official book still follows the evening settlement",
    tab: "live", sub: "watch",
  },
  {
    id: "ledger", letter: "C", name: "Live paper ledger", role: "shadow",
    data: "Live Kotak prices",
    decides: "When the entry rule holds on two fresh readings in a row",
    fills: "The larger of the day's open and the trigger, sized from the ledger's own equity",
    effect: "None. Each live buy is marked confirmed or rejected after the evening run",
    tab: "live", sub: "ledger",
  },
  {
    id: "minute", letter: "D", name: "1-minute candle shadow book", role: "shadow",
    data: "Completed 1-minute candles built from the live feed",
    decides: "On the close of each 1-minute candle: entries 09:30-15:00, stops on every close, day-1 check at 15:20",
    fills: "The next candle's open",
    effect: "None. It places no order; each evening it is compared with the official book",
    tab: "live", sub: "minute",
  },
  {
    id: "backtest", letter: "E", name: "Backtest", role: "history",
    data: "NSE daily bars over the past, built on the research PC",
    decides: "The same daily rules, replayed over history",
    fills: "Simulated on the daily bar, shown before and after 0.15% cost per side",
    effect: "None. It describes the past; it is not live and not a forecast",
    tab: "backtest", sub: "results",
  },
];

/** The sentence at the top of the page: how many tests, grouped by what they do. */
export function modeSummary(modes: readonly SwingMode[] = MODES): string {
  const n = (r: ModeRole) => modes.filter((m) => m.role === r).length;
  return `${modes.length} ways the rules are run: ${n("official")} official book, ${n("shadow")} live shadow tests that change nothing, and ${n("history")} backtest of the past.`;
}
