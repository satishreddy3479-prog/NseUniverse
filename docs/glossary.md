# Glossary

Terms as this project uses them, with where they are implemented. Prices are in index points or rupees as stated. The NIFTY lot size is 65.

## Options basics

- **Strike, CE, PE.** A contract's strike price; CE is a call, PE a put.
- **ATM (at the money).** The strike nearest the NIFTY level (the builder's managed straddle sends a tie to the lower strike). `domain/models.py` (moneyness), `frontend/src/lib/strategy.ts`.
- **Expiry: weekly, monthly.** Real exchange expiry dates discovered from the broker, never computed. `domain/expiry.py`.
- **Lot, lot size.** One lot is 65 units; OI and volume are kept in units. P&L in rupees = points x 65 per lot.
- **OI, OI change.** Open interest. OI change here is **current OI minus the previous day's OI, computed locally**: Kotak's own change field is a price change. `analytics/oi.py`.
- **PCR, max pain.** Put-call ratio and the strike where option writers would pay least. `analytics/oi.py`, `frontend/src/lib/analytics.ts`.
- **IV, Greeks, Black-76.** Implied volatility and the sensitivities (delta, gamma, theta, vega). Options on NIFTY are priced as options on the futures/forward price with the Black-76 model. `risk/`, `intraday/volatility.py`.
- **SVI surface.** A fitted, arbitrage-checked smile of implied volatility per expiry. `risk/svi.py`, `risk/ivsurface.py`.
- **GEX (gamma exposure).** Gamma of all strikes weighted by open interest. `intraday/gex_history.py`, `lib/gexIntel.ts`.
- **Premium decay, theta.** The fall of an option's price as time passes; for a seller of a straddle, a positive.

## Straddles

- **Straddle.** A call and a put at the same strike. A seller sells both and is paid the premium; the straddle price is call + put in points.
- **Fixed straddle.** The ATM straddle at the first usable sample of the day, held all day. `intelligence/straddle.py`.
- **Rolling ATM.** The straddle at whatever strike is ATM now (what a seller would see if they always looked at the ATM pair).
- **Managed straddle / re-strike.** A short straddle that is closed and re-opened at the new ATM strike whenever NIFTY is a set number of points (the *distance*, 100 by default) from the held strike. Each re-strike books the old pair's profit or loss. Two implementations: the **straddle engine page** (a record on stored data, fixed at 100) in `intelligence/straddle.py` (`managed_book`), and the **builder's ready-made strategy** (paper, any distance, runs on the server) in `strategy/automation.py` (`apply_restrike`). Decisions D339 and D340.
- **Booked, open, total.** Profit already realised by closed pairs; profit or loss of the pair still held at its last price; their sum.
- **Buyer and seller environment.** Scores of how favourable conditions are for buying or selling options. `intelligence/straddle_env.py`.
- **Preflight, live regime.** Checks and squeeze/compression detectors before and while a short straddle is held. `intelligence/live_regime.py`.

## The session and the feed

- **Session, session close.** The regular market session (09:15 to the exchange close). The close of the F&O session is confirmed from the feed (15:40; 15:45 from 7 Dec 2026). `domain/session.py`.
- **Closing auction (CAS), indicative value.** From 3 Aug 2026 continuous cash trading ends at 15:15 (15:30 from 7 Dec) and an auction follows; the index then shows only *indicative* values, not traded prices. The **closing value** is the last auction value; the server keeps it. `stream/index_close.py`, D332.
- **Snapshot, sample, observation.** A *snapshot* is a full chain captured over REST and stored as a gzip file; the *sampler* stores one per minute in market hours; an *observation* is the compact stored form used by the analytics. `services/sampler.py`, `storage/`.
- **Live feed, stream, book.** The WebSocket feed from Kotak (one connection, one process), the manager that supervises it, and the book holding the latest tick per instrument. `stream/`.
- **Feed silence.** The feed is connected but no data arrives. The server reconnects after 20 s of silence in market hours. D337.
- **Loop stall, heavy worker.** The backend runs one event loop; a *stall* is the loop being blocked for a second or more. Heavy computations run on one low-priority *heavy worker* so they do not starve the loop. `stream/loopwatch.py`, `stream/heavy.py`, D335 and D336.
- **Stale, incomplete.** Data older than its freshness limit, or a chain missing strikes; both are flagged to the UI, never hidden.

## Analysis pages

- **Market intelligence, fused verdict, Day board.** The master aggregation of many readings into one verdict (Bullish / Neutral / Bearish), the day's timeline of it, and the page that shows both. `intelligence/`.
- **Turn watch, pullback flag.** Early signs that a move is turning, read from the stored timeline. `intelligence/turn.py`, `intelligence/pullback.py`.
- **Command Center.** The rules-based intraday sentiment panel on the Intraday analysis page. `intraday/`.
- **Smart OI, divergence.** A view of OI changes by strike and a set of divergence indicators between price and OI. `frontend/src/lib/smartOiDivergence.ts`.
- **Eagles view.** A page where every tool is a movable box. `pages/EaglesView.tsx`.
- **As of, replay.** Showing an analysis as it stood at a stored minute of a past day.
- **Edge monitor.** A nightly check of whether an indicator beat luck over stored sessions. `edge/`.
- **Forward test.** Paper short options opened whenever the seller score is high, with several exit rules tracked. `forward/`.
- **Swing book.** A paper-traded swing portfolio scanned and settled after the close. `swing/`.

## Paper strategies

- **Paper.** Simulated on live and stored prices; **no order is ever sent to a broker**.
- **Leg, running strategy.** One option (or future) position of a strategy; the *running* strategy is the one document the server watches every second. `strategy/automation.py`, `storage/strategies.py`.
- **Stop, target, trailing, re-entry, move SL to cost.** Per-leg rules on the premium, in percent of the entry.
- **Strategy rules: SL, target, lock and trail.** Rules on the whole strategy's P&L in rupees.
- **Holding: intraday, overnight, manual.** Intraday closes every open leg at a set time (default 15:20) on the **first such time after the strategy was armed** (weekends skipped); overnight holds to the expiry day; manual never closes by itself.
- **Armed, re-arm.** A strategy is armed when it is opened or reset; the server counts the holding time from then.

## Operations

- **Deploy guard.** The production server pulls `main` about once a minute but holds releases from 08:55 to 15:50 IST on weekdays. A one-time override file allows a deploy in market hours. `deploy/deploy-guard.sh`, [deployment-server](deployment-server.md).
- **Watchdog, alerts.** A check every five minutes that puts problems in the alert strip (open files, holiday list, backups, and more). `deploy/watchdog.sh`.
- **Provenance.** The source (broker, feed, stored), the kind of record and the receipt time attached to every record.
