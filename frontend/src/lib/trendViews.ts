/** The views of the Trend & Regime family on the Analyse menu (one tool entry each, see lib/tools.ts). */
export type TrendViewId =
  | "market-regime" | "trend-strength" | "chop-variance" | "session-structure" | "opening-range" | "range-used" | "gamma-regime" | "daily-regime";

export const TREND_VIEWS: { id: TrendViewId; label: string; blurb: string; popular?: boolean }[] = [
  { id: "market-regime", label: "Trend & Regime", popular: true, blurb: "Is the session trending or range-bound? Four readings vote; the label, its confidence and the reasons are shown, with the regime shaded behind the NIFTY candles. Descriptive, not validated." },
  { id: "trend-strength", label: "Trend Strength", blurb: "Efficiency ratio, ADX with +DI / −DI and the R² of a straight-line fit, bar by bar, against the thresholds that make them vote." },
  { id: "chop-variance", label: "Choppiness & Variance Ratio", blurb: "The choppiness index through the session, and the Lo–MacKinlay variance ratio with its z: do moves tend to continue or to reverse?" },
  { id: "session-structure", label: "Session Structure (TWAP / VWAP)", blurb: "NIFTY against its session mean and the future's volume-weighted price: share of time above, crossings, longest stay, distance in ATR." },
  { id: "opening-range", label: "Opening Range", blurb: "The first 5, 15 or 30 minutes' range and what the price did with it: breakouts, failed breakouts, where it sits now." },
  { id: "range-used", label: "Range Used vs Implied Move", blurb: "How much of a normal day's range, as the options price it (at-the-money IV), the session has already used." },
  { id: "gamma-regime", label: "Gamma Regime", blurb: "Positive or negative gamma from the live chain: net GEX, the flip and the walls, with the model's stated limits." },
  { id: "daily-regime", label: "Daily Regime (validated?)", blurb: "The same label on 18 years of daily closes, with a study fixed in advance of whether it predicts straighter or choppier next days. The verdict is shown as it came out." },
];
