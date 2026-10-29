# Intraday analysis and the Market Sentiment Command Center

Page: **Intraday analysis** (`/analysis`). The command center sits above the existing adjustable
widgets, which are unchanged. Backend: `backend/app/intraday/` · API `GET /api/intraday/summary?expiry=`,
`GET /api/intraday/scores?expiry=&session=`.

## What it is and is not
- A **rules-based, provisional** description of the current session built from stored real data.
- **Not** an ML prediction and not a trading signal. No probabilities are shown: there is no
  validated intraday model (see "ML readiness").

## Data dependency map

| Section / widget | Backend source | Refresh | Time stamp | Live / snapshot / historical | Missing data |
|---|---|---|---|---|---|
| Spot, change, sampled high/low, opening range, returns, realized vol | `observations.sqlite3` samples (Kotak chain fetch, ~60 s in market hours, sampler) | sampler 60 s; page polls 30 s | `received_at` of each sample | live while samples are ≤3 min old, else delayed/stale; historical outside market hours | fewer samples → feature `null` with a reason |
| Header spot when the stream runs | Kotak SFeed index tick (WebSocket) | tick | tick time | live | falls back to the last sample |
| Previous close | Kotak feed (`prev_close_p`), cross-checked against the stored daily bar for the previous trading session (tolerance 0.05%) | per sample | sample | — | mismatch → stored close used + "Previous close check" warning |
| Previous-day high/low, typical daily move (60-session sd), average range (14 sessions) | `market_history.sqlite3` NIFTY50 daily bars (Yahoo) | daily (18:30 / 07:30 runs) | bar session | historical | `null`, price group unavailable |
| Options: totals, OI change vs prev day, PCR (OI, volume), ATM straddle, largest OI strikes | latest sample's contracts (ATM ±10 strikes, same rule as `/api/oi/change`) and today's first in-session sample | per sample | sample | as the chain | missing contracts skipped and counted |
| Global (S&P, Nasdaq, VIX, USD/INR, Brent, US10Y, gold, Nikkei, Hang Seng, DAX) | daily bars, last session **before today** | daily | bar session | historical | stale if > 4 days old |
| Sectors | daily NIFTY sector indices, previous session | daily | bar session | historical, **not scored** | — |
| FII/DII | `nse_flows.sqlite3` NSE provisional cash | evening (scheduled capture / import) | session it describes | official provisional, previous session | stale → shown, not scored |
| Events | `prediction/reference/events.json` | static, verified | event time (unconfirmed times flagged) | — | — |
| Existing widgets | `/api/option-chain`, `/api/history/observations`, `/api/oi/*`, live overlay | as before | as before | as before | as before |

Not collected yet - plan in [market-breadth-plan](market-breadth-plan.md) (shown as **Not available**, never zero): market breadth (constituent
advances/declines), intraday sector data, VWAP (NIFTY 50 is an index without traded volume, so a
VWAP is undefined; a futures VWAP would need a futures feed).

## Time-series widgets: ranges and full-size view
The NIFTY, total premium, premium decay and ATM straddle charts have range buttons: 30 min, 1 hour (measured back from the newest stored sample), **Session** (default: the newest sample's IST day, 09:15-15:30; the last session when the market is closed) and All. The range is shared by the four charts and remembered in the browser. `⤢ Full` or a click on the line opens a full-window chart with the same range buttons and a zoom bar; Esc closes it. Premium decay is measured against the first sample *in the chosen range*. The tag under each chart says *Sampled live* (newest sample <= 3 min), *Sampling delayed* (<= 10 min) or *Stored (last session)*.

## Feature definitions (`features.py`)
- **Session phase** (IST): pre-market < 09:00, pre-open 09:00–09:15, opening 09:15–09:45, morning –11:30,
  midday –13:30, afternoon –15:00, closing –15:30, post-market; *closed* on NSE holidays (holiday
  circulars in `prediction/reference/nse_cm_holidays.json`).
- Samples used: today's IST date, 09:15–15:30, never after the current time (`until=now`).
- **First sample** is not the official open; **sampled high/low** miss ticks between samples.
- **Opening range**: min/max of samples 09:15–09:30 (needs ≥ 3).
- **Return over h min** (5/15/30/60): last ÷ last sample at or before now−h (anchor no older than h+3 min) − 1.
- **Efficiency ratio**: |net move| ÷ Σ|sample-to-sample moves| (null if no movement).
- **Realized vol**: √Σ(ln returns between samples)² in %; *ratio* = that ÷ (60-day daily sd × √(elapsed/375)).
- **Options**: OI change = OI − previous-day OI per contract (both present); PCR = put ÷ call total;
  straddle = ATM call LTP + ATM put LTP (its change includes time decay and ATM shifts, it is not IV).

## Sentiment score (`sentiment.py`, version string stored with every snapshot)
Groups (provisional weights): price 0.35 · breadth 0.15 · sectors 0.10 · options 0.20 · global 0.10 ·
institutional 0.10. Each group score ∈ [−1, +1]:
- **price** = mean(clip(change since prev close ÷ daily sd), clip(30-min return ÷ (daily sd·√(30/375)))) — the correlated price measures form one group.
- **options** = mean(clip(((ΔPE OI − ΔCE OI) ÷ total OI) ÷ 5%), clip(PCR change since first sample ÷ 0.20)). Convention only: OI change does not reveal intent.
- **global** = mean(clip(S&P 500 return ÷ its sd), clip(−USD/INR return ÷ its sd)).
- **institutional** = tanh(FII/FPI net ÷ ₹3,000 cr), previous session only.
- **score** = Σ w·s over available groups ÷ Σ w available; **coverage** = Σ w available ÷ Σ all w.
  Coverage < 45 % or no price group → *Insufficient data*.
- Labels: ≥ 0.5 Bullish, ≥ 0.2 Moderately bullish, > −0.2 Neutral, > −0.5 Moderately bearish, else
  Bearish; |score| < 0.2 with high volatility → *High volatility / unstable*.
- Volatility regime: realized-vol ratio ≥ 1.5 high, ≤ 0.6 low. Volatility and events are not in the score.
- Weights and scales are judgement calls, **not fitted**. They must be evaluated on the stored
  snapshots before anyone calls them meaningful.

## Regime and scenarios
Observed regime needs >= 15 samples. A trend needs a move that is large for its length and directional:
the larger of the 60-minute move and the whole-session move, as a multiple of what a random walk with the
60-session daily volatility would typically do in that time, must be at least 1.5x, and the 5-minute path
must not be just back-and-forth (efficiency ratio >= 0.20). Mean-reverting: 5-minute efficiency < 0.20 and
the move < 1x typical. Otherwise sideways. (The one-minute efficiency ratio is not used: it is low even in a
clean trend because minute samples zigzag; 29 Oct showed that.) Tags: opening-range breakout/breakdown, gap,
volatility expansion/contraction, exhaustion risk, event risk.

Scenarios (bullish, range-bound, bearish) are qualitative and **only the relevant ones are shown**; the
others are listed as "Not shown" with the reason:
- *Bullish* needs at least one available evidence group above +0.10; *bearish* at least one below -0.10.
- *Range-bound* is shown unless the session is a clean trend (efficiency >= 0.35) with |score| >= 0.5, and
  it is the fallback when no direction is supported.
- Order: range-bound first when the observed regime is sideways/choppy, otherwise the direction of the
  score first.
Each shown scenario lists evidence for and against, levels, and what would strengthen or weaken it.
**Probability is always null** until a validated model exists.

## Score ledger
`data/intraday.sqlite3`, table `scores`: one row per (expiry, sample, scoring version) written when
computed during market hours (background loop every 60 s, `INTRADAY_AUTOSCORE`), before the outcome is
known. SQLite triggers forbid UPDATE and DELETE.

## Freshness rules
Chain/spot in market hours: fresh ≤ 3 min, delayed ≤ 10 min, stale beyond; outside hours "last
session". Daily history fresh when its last bar is the previous trading session. Global fresh within 4
days. FII/DII fresh when it describes the previous trading session.

## Separation from the T+1 / T+5 prediction models
The intraday view reads stored daily bars; the prediction models never read intraday samples, chains, ticks or the score ledger, and they train only outside market hours (see D53 and `test_no_intraday_leak.py`). Any future intraday model gets its own pipeline and ledger.

## ML readiness
Staged plan in [intraday-ml-plan](intraday-ml-plan.md): labelled data is built nightly from day one; experimental
training starts at 5 labelled sessions, paper-testing at 20, and 60 only gates the label "validated".

## Not built yet (from the master spec; in dependency order)
1. Breadth and intraday sectors (needs a legitimate constituent quote source; Kotak quotes for 50
   stocks are the likely route).
2. News headline provider (licensing check pending; GDELT tone is collected but unused).
3. Session manifests, Parquet archive, verified cleanup (no deletion is enabled).
4. Intraday ML targets/baselines/walk-forward once ≥ 60 complete sessions exist; forward-test ledger.
5. Daily research report, resource monitor for the PC.
