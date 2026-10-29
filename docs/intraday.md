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

Not collected yet (shown as **Not available**, never zero): market breadth (constituent
advances/declines), intraday sector data, VWAP (NIFTY 50 is an index without traded volume, so a
VWAP is undefined; a futures VWAP would need a futures feed).

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
Observed regime needs ≥ 15 samples: up/downtrend (efficiency ≥ 0.35 and |60-min return| ≥ half the
typical 60-min move), mean-reverting (efficiency < 0.2), otherwise sideways; tags for opening-range
breakout/breakdown, volatility expansion/contraction, exhaustion risk, event risk. Scenarios (bullish,
range, bearish) are qualitative, ordered by agreement with the score, with evidence for/against,
levels, strengthen/weaken conditions; **probability is always null** until a validated model exists.

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
A session counts as complete with ≥ 300 in-session samples. No intraday model is trained before 60
complete sessions exist; it must then beat the persistence/majority baselines under purged walk-forward
evaluation. **On 2026-10-29 the store held 0 complete sessions** (all earlier samples were taken
outside market hours), so the first usable session is 29 Oct 2026.

## Not built yet (from the master spec; in dependency order)
1. Breadth and intraday sectors (needs a legitimate constituent quote source; Kotak quotes for 50
   stocks are the likely route).
2. News headline provider (licensing check pending; GDELT tone is collected but unused).
3. Session manifests, Parquet archive, verified cleanup (no deletion is enabled).
4. Intraday ML targets/baselines/walk-forward once ≥ 60 complete sessions exist; forward-test ledger.
5. Daily research report, resource monitor for the PC.
