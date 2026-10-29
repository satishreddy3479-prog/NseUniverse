# Market breadth, heavyweights, volume and sectors: plan

Status: **plan only, nothing built yet.** Purpose: tell whether a NIFTY move is *real* (broad, backed by the
heavyweight stocks and by volume) or *thin* (a few stocks, little volume), and feed that into the intraday
sentiment, the scenarios and the intraday ML dataset.

## 1. How the intraday analysis works today

```
Kotak option chain (every ~60 s, NIFTY weekly + monthly)  -> spot, OI, volume, LTP per strike
Daily prices (Yahoo, after the close)                      -> previous close, normal daily move, S&P, USD/INR, ...
NSE FII/DII (evening)                                      -> previous session's institutional flow
        |
        v   backend/app/intraday:  features -> evidence groups -> score -> regime -> scenarios
 price(0.35) breadth(0.15) sectors(0.10) options(0.20) global(0.10) institutional(0.10)
        |
        v   Market Sentiment Command Center (provisional, rules-based, not a prediction)
```

- **Score:** each *evidence group* gives a number from -1 to +1; the score is the weighted average of the groups that
  have data, and coverage shows how much of the weight was available. A missing group is never counted as zero.
- **Regime:** describes what the session has done so far (trend, sideways, choppy) from the size and persistence of
  the move against normal daily volatility.
- **Scenarios:** only those with supporting evidence are shown; the rest are listed as ruled out.
- **Intraday decision context:** nine plain questions a trader asks before trusting a move (trending? broad?
  sectors confirming? options consistent with price? volatility rising? levels accepted or rejected? global
  backdrop? event risk? data fresh?). Each answer is computed from stored values and shows "Unknown" when its input
  is not collected. It adds no new signal: it is the checklist behind the score, so a reader can see *which checks
  pass and which cannot be answered yet*.

## 2. Why breadth is missing

The system subscribes only to the NIFTY 50 index and the NIFTY option contracts (about 325 tokens). It has never
subscribed to the constituent *stocks*, so it cannot know how many are up or down, which ones carry the index, or
whether volume is behind the move. Two of the nine context questions ("broad or concentrated?", "sectors
confirming?") and two score groups (breadth 0.15, sectors 0.10, 25 % of the weight) therefore read "Unknown".
They are deliberately shown as missing instead of being guessed.

## 3. What is feasible (checked against Kotak's documentation)

- One market-data connection may hold **up to 3,000 subscribed tokens** (Kotak Neo WebSocket guide). Today ~325;
  adding ~550 stocks and indices keeps us far below. Subscribing is batched.
- Kotak provides a **scrip master** (instrument tokens and trading symbols such as `HDFCBANK-EQ`) and a quotes API.
- Our stream already parses, per instrument: last price, open, high, low, **previous close, cumulative volume
  traded today**, change and change %. That is all that breadth, contribution and relative volume need.
- Not yet verified (must be tested in market hours before building on it): that every NIFTY 500 stock streams
  with those fields, tick rate and CPU/memory on the 1 GB server with ~900 tokens, and the broker's tolerance for
  the extra subscriptions.

## 4. Data needed and where it comes from

| Need | Source | Status |
|---|---|---|
| NIFTY 50 / NIFTY 500 constituent lists with sector (NSE "Industry") | official NSE index lists (niftyindices.com CSV); a reviewed reference file in the repo with the effective date | access terms to be verified; fallback: a one-time reviewed file updated at each reconstitution |
| Stock instrument tokens | Kotak scrip master (`nse_cm`) | to be built |
| Live prices and volume | existing Kotak stream (stocks added to the subscription list) | to be verified in market hours |
| NIFTY 50 weights (free-float market-cap) | latest official factsheet, stored with its "as of" date | to be verified; between publications contribution uses the last weights, labelled approximate |
| Normal daily volume per stock (20-day average) | Yahoo daily bars (already our daily-price source; volume is meaningful for stocks) | to be built |
| Intraday volume profile (what share of a day's volume is normally done by minute t) | built from our own samples after ~10 sessions; until then relative volume is not shown | to be built |
| Moving-average breadth (% above 20/50/200-day average) | daily bars of the constituents | to be built |
| Official end-of-day breadth history (advances/declines over all equities) | NSE archive files, fetched with an honest client like the participant files | to be verified |
| Sectoral index levels live | the same stream, subscribed by index name (like "Nifty 50") | to be verified |

No scraping around blocks, no paid or account-based source without approval, nothing fabricated: a missing stock is
counted and shown as "N of 500 covered", never as flat.

## 5. Metrics (definitions fixed before coding)

For each stock: **change** = last / previous close - 1. **Advancing** if change > +0.05 %, **declining** if < -0.05 %,
otherwise **flat**; a stock with no valid price is *not covered*.

**Breadth (NIFTY 50 and NIFTY 500 separately, from live prices)**
- advancing, declining, flat, covered; advance/decline ratio; % advancing
- equal-weighted return (mean change) next to the cap-weighted index return: a large gap = narrow move
- % of stocks at their session high / session low; % above the opening-range high (first 15 minutes)
- breadth momentum: change of % advancing over the last 15 minutes
- % above 20/50/200-day average (NIFTY 500; from daily bars, refreshed each evening)

**Heavyweights and "is the move real?" (NIFTY 50)**
- contribution_i = weight_i x change_i (in index points via the previous close of the index)
- top-5 / top-10 share of the index move; number of stocks needed to explain 50 % of the move
- **relative volume** = today's volume so far / typical volume by this time (20-day average x intraday profile);
  volume-weighted by index weight
- up-volume vs down-volume (volume of advancing vs declining stocks)

A provisional, documented reading (thresholds to be checked against outcomes with the labelled dataset, not tuned by feel):
- *Broad and confirmed*: >= 65 % advancing, equal-weight and cap-weight return same sign and within 0.15 %, weighted relative volume >= 1.0
- *Narrow*: top-5 stocks explain > 60 % of the move and < 50 % of stocks agree with the index direction
- *Thin*: weighted relative volume < 0.7, whatever the price does
- *Mixed*: anything else

**Sectors**
- sector return live, from the sectoral indices streamed directly (cheap, official) and from the constituents
- relative strength = sector return - NIFTY return; rank and the change of rank over 30/60 minutes (rotation)
- sector contribution to the NIFTY 50 move = sum of weight x change inside the sector (this separates "the sector
  moved" from "the sector moved the index")
- % advancing inside each sector; sector volume confirmation (weighted relative volume)

## 6. Architecture

- A **universe module** (`app/market/universe.py`): reviewed reference files (constituents, sector, weights with
  as-of dates and index effective dates) plus Kotak tokens from the scrip master; refreshed on a schedule, never
  silently changed.
- The existing **stream manager** gets the stock and sector-index tokens added (one connection, bounded
  broadcast rate unchanged; the browser still receives only what the dashboard shows).
- A **breadth service** keeps the latest tick per instrument in memory (~900 small records) and, once a minute with
  the option sample, computes and stores one compact row per universe plus the NIFTY 50 stock table.
- Computations are **pure functions** (like `features.py`) so the dashboard, scoring and ML dataset use the same code.
- The command center fills the existing *breadth* and *sectors* groups, answers the two "Unknown" questions with
  numbers, and adds a "Move quality" card (broad / narrow / thin / mixed with the evidence).
- The nightly dataset gains breadth, contribution and relative-volume features (`if-2`); labels do not change.

## 7. Storage impact (15 GB server)

| Item | Rows per day | Size per day | Per year |
|---|---|---|---|
| NIFTY 50 stock table, every minute (50 x 375) | ~19,000 | ~0.6 MB | ~0.15 GB |
| NIFTY 500 aggregates, every minute (counts, %, top movers) | ~375 | < 0.1 MB | < 25 MB |
| NIFTY 500 per-stock snapshot every 15 minutes (500 x 25) | ~12,500 | ~0.4 MB | ~0.1 GB |
| Sector tables, every minute (~12 sectors) | ~4,500 | ~0.1 MB | < 30 MB |
| Constituent daily bars (500 stocks, history once, then daily) | - | ~1 MB / day | ~0.25 GB |

About 1.2 MB a day on top of the current ~20 MB, compressed in the nightly archive like the option data. The
retention plan in [storage-plan](storage-plan.md) applies unchanged; the new tables are append-only.

## 8. Phases and acceptance

0. **Verify (tomorrow, 09:15-15:30, no new code in the decision path):** a capture script subscribes to the NIFTY 50
   stocks and the sector indices for a few minutes and saves the raw ticks as test fixtures; confirm fields, rates,
   resource use, and the constituent/weight sources and their terms. *Done when:* a report lists, for each token,
   which fields arrived.
1. **NIFTY 50 live breadth, contribution and relative volume.** *Done when:* numbers match a hand calculation on the
   captured ticks, a missing stock lowers "covered" and never counts as flat, and the page shows the move-quality card.
2. **Sectors** (indices live + constituent contribution, rotation).
3. **NIFTY 500 breadth** (counts, highs/lows, DMA breadth) and the official end-of-day breadth history for the daily models' features.
4. **Integration:** breadth and sector groups in the score, scenario evidence, context answers, ML features `if-2`;
   weights of the groups re-checked against outcomes once labelled sessions exist.

Every phase: tests from real captured data with an independent calculation, stale/partial states on the page, a
documentation update, and a storage check on the server before and after.

## 9. Risks and open questions

- Kotak limits and tick availability for all 500 stocks are unverified (phase 0).
- Official weights and constituent lists change (semi-annual reconstitution, monthly factsheet); they need as-of
  dates and a reminder when they are older than a limit, or the contribution numbers quietly drift.
- Relative volume needs an intraday volume profile that does not exist yet; until it has ~10 sessions the page shows
  raw volume, not "relative".
- The PC sleeps (29 Oct: collection stopped at 09:49); breadth must run on the server to be continuous.
- Thresholds for "broad / narrow / thin" are provisional; they are labelled as such until tested on stored outcomes.
