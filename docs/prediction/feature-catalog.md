# Feature catalog

Every feature needs: definition, formula, source, publication timing, historical availability, missing-data behaviour, tests, intended use, limitations. This file lists the families and their status; a feature gets its full entry in `docs/prediction/features/` (one table row per feature) when it is implemented. **Implemented today: none.** Rows say what is planned and what blocks it.

Common rules: values come from `Observation` records with a publication time; features use only observations published at or before the cutoff ([leakage-prevention](leakage-prevention.md)); a missing input gives a missing feature plus a flag, never zero or a forward fill; warm-up periods produce missing values; correlated indicators are added only if ablation shows value.

| Family | Planned features (examples) | Source | Historical availability | Blocker / status |
|---|---|---|---|---|
| A. Indian price and technicals | Returns 1/2/3/5/10/20 sessions; gap size; close location in range `(C-L)/(H-L)`; distance from 20/50/200-session average; EMA slopes; RSI(14); MACD(12,26,9); ATR(14); realized volatility 5/20; ADX(14); rolling highs/lows; previous-day high/low/close | NIFTY daily OHLC | Long, once a source is approved | Needs NIFTY history source (decision 2) |
| B. Breadth and sectors | Advance/decline ratio; % of universe advancing; % above 50/200-day average; new highs/lows; sector returns, relative strength vs NIFTY, momentum, breadth | NSE EOD bhavcopy; sector index closes | Long, but constituent membership is not point-in-time | Needs approved download path; survivorship bias must be documented |
| C. Institutional flows | FII/DII net cash, rolling sums, flow relative to turnover; participant positioning changes | NSE FII/DII, participant OI | Publication times unverified | Unavailable for backtests until times are verified |
| D. Options market | PCR (OI, volume), OI change by strike, concentration, ATM straddle, IV level/skew, India VIX, expiry proximity, distance to max-OI strike | Observation store, India VIX | Own data from 2026-10-28; VIX history from NIFTY source | Prospective only; backtest claims after months of data |
| E. Global and cross-asset | S&P 500, Nasdaq, Dow returns and trends; US VIX; Nikkei/Hang Seng/Shanghai/Europe; Brent, gold, DXY, USD/INR, US 2y/10y and curve | Yahoo, FRED | Long | Needs decisions 2 and 5; observed-at-cutoff rule for open markets |
| F. Scheduled events | Days to RBI/FOMC/CPI/GDP/jobs; event-in-window flags; expiry and holiday proximity | Official calendars | Known in advance, so fully backtestable | Calendar loaders (RBI, MoSPI verified; FOMC to re-read) |
| G. News | Time-decayed counts by category, India-relevance, source reliability, duplicate-collapsed story counts, simple sentiment; event-surprise only when published | GDELT, official announcements | Prospective | Needs decision 4; baseline is transparent rules before any language model |

## Feature conventions
- Name: `family.name.params` (for example `A.ret.5`).
- Each feature has `available_from` (earliest date with real inputs) so a dataset can be built honestly for each period.
- Features that depend on a still-open market state which market and at what observed time.
- A feature set has a version (`feature_version`); the version is stored in every forecast.
