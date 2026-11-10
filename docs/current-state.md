# Current state
_Last updated: 2026-11-04_

- **Objective:** NSE Universe — Indian market research platform; see [roadmap](roadmap.md).
- **Phase:** Phase 1 (Kotak Neo + NIFTY option chain + dashboard). **Milestone:** Checkpoint 1 built; awaiting the user's Windows setup and live check.
- **Stage:** local-only; no Git repo, no GitHub, no deploy (decision #13).

## NIFTY 50 Market Intelligence (10 Nov 2026)
New first menu item and Home strip: fused sentiment (-100..+100) over five evidence groups (derivatives positioning, order-flow proxies, volatility, market structure, participation), with score, confidence, data coverage (available / partial / unavailable), evidence agreement and data freshness as separate quantities, regime, evidence per group, divergences, heuristic scenarios, timeline of recorded minutes, alerts, rolling 5/15/30-minute CVD (proxy), a visible Data quality and freshness section (AVAILABLE / PARTIAL / UNAVAILABLE per capability with source timestamps), and drill-down links to every existing page (D102, D103, [audit, overlap correction and methodology](market-intelligence-audit.md)). The command-centre score is no longer an input (double counting removed); weights are provisional and labelled so; walk-forward validation exists (`/api/intelligence/validation`) but has no real stored history to run on yet. Tested with fixtures and fake providers; not seen with live data in market hours or on a phone.

## Swing live paper ledger (10 Nov 2026)
Orders that read triggered on two consecutive fresh live prices now get a provisional paper fill in a separate ledger (new panel under Live prices), reconciled against the evening run as confirmed or rejected-and-voided (D101, plan in swing-live-paper-fills-plan.md). The official paper book is unchanged. Not seen with real ticks yet; the first market-hours session is the check.

## Options intelligence update 2 (10 Nov 2026)
GEX/flip history rebuilt from stored chains with five GEX backtests, smile session comparison, full 10Δ/25Δ term structure, regime with GEX-price relationship and explicit weights, aggregate premium charts (existing ones untouched), and a benchmarked, cached, job-based backtest (60 sessions cold about 56 s). Details, benchmark table and limits: [options-intelligence](options-intelligence.md) (D99). No real-history GEX backtest has run yet (one stored session locally); nothing verified on the server or visually.

## Options intelligence programme (10 Nov 2026)
Added under Options: IV Momentum, Strike Positioning, Market Structure (regime classifier) and Signal Backtest; GEX universes, sign sensitivity, intraday dynamics and divergence on the gamma page; Calculation Methodology & Formulas panels on skew, momentum, IV/HV, positioning, GEX, regime and backtest. Details, limits and what is not built: [options-intelligence](options-intelligence.md) (D97, D98). Not verified live in market hours or visually on a phone.

## Options intelligence, step 1 (10 Nov 2026)
Volatility Skew now interpolates the 25Δ and 10Δ wing IVs in delta, shows call−put skew, 10Δ butterfly and the wing IVs, and ends with a closed Calculation Methodology & Formulas panel fed by a metric registry (D97). Not built yet: IV momentum, per-delta IV history storage, multi-expiry delta term structure, GEX universes/divergence, regime classifier, demand analyser, backtests, central dashboard.

## Strategy Builder: payoff estimate, hide chain, holding rule (10 Nov 2026)
The blue model curve now includes closed legs' booked P&L (it had sat above the green curve after a stop-out). The option chain can be hidden. New Intraday / Overnight / Manual holding rule with customisable auto-close time (default 15:20 IST), run on the server; see D96. Tests: optionModel, strategy-hold (browser) and test_strategy_hold (server) pass; full backend run has one failure in test_events_news that exists without these changes. Not verified live in market hours.

## Smart OI audit (5 Nov 2026)
- **How it is calculated:** per candle, total call OI and put OI over the chosen strikes (all strikes of the selected expiry by default) from the last stored sample in the candle; Smart OI = (put OI now − put OI previous candle) − (call OI now − call OI previous candle). The 09:15 candle uses yesterday's closing OI. Hand-checked on the spec example (+150k, +450k, −800k) in `option-tools.test.ts`.
- **Volume:** Kotak `vol` is cumulative contracts-in-units traded today (3 Nov fixture: calls 187.8M, puts 176.8M, same scale as OI). Per-candle volume is the change in the cumulative sum; the 09:15 candle is everything since the open; a total that goes backwards is shown as missing, never negative.
- **Fixed:** a strike with no OI in one sample changed the totals silently and created a fake jump. Candles where the strike count differs from the previous candle are now flagged in the tooltip and the footer (`strikesChanged`).
- **Known limits:** candles use the local receipt time of each sample, not the exchange timestamp; a sample is stored only when the chain changed, so a candle with no sample is left out; volume sums do not report their own strike count, so a vanished volume strike shows only as a drop to missing.
- **Not verified:** stored real samples (the sandbox has none), so how often strikes drop out in practice is unmeasured; compare with StockMojo during market hours.

## Smart OI vs StockMojo gap (5 Nov 2026)
- **Cause 1 (totals):** the page summed only ATM ±10 strikes (OI PCR 0.33–0.50 in the screenshot) while StockMojo's totals cover the whole chain (OI PCR 1.096). The default is now **All strikes**; the picker still offers ±5/±10/±20.
- **Cause 2 (first candle and day lines):** StockMojo's 09:15 bar and day-change lines are against yesterday's closing OI (their Put +1.51L, Call −27.72L, PE−CE +29.23L at 09:15). Ours started at zero. They now use the stored OI change (OI now − previous-day OI) when present; the 09:15 candle gets a bar and its volume is everything traded since the open. Without stored previous-day OI the old baseline behaviour remains.
- **Not closable from here:** NIFTY candles come from one-minute samples, so their highs and lows are narrower than the exchange's index candles (their 09:15 low 24,298 vs ours ~24,343). Whether StockMojo's chain is one expiry or all expiries is unknown; ours is the selected expiry.
- **Layout:** main chart is taller (440 px), panels re-spaced, titled, and axis numbers in L/Cr. The "Mon, 09 Nov, 2026" in the footer is the selected expiry, not a sample date.
- **Verified:** tsc clean, option-tools tests (new first-candle test). **Not verified:** the look in a browser (none available here) and the numbers against StockMojo during market hours.

## Smart OI: shared crosshair and full session (4 Nov 2026)
- **Cause of the chart ending at 15:27:** the candle builder cut the session at 15:30, but the exchange session is 15:40 while the closing-auction alignment is on (`/api/market/session`), so the last ten minutes of stored samples were dropped. It now uses the backend's open and close (close minute included).
- **Shared crosshair:** the three Smart OI charts form one ECharts group (`EChart group="smart-oi"`): hovering any chart marks the same candle time, with a time label and tooltip, in the other two (checked in a browser with both directions).

## Logo, home page, two themes, compact top bar (4 Nov 2026)
- **Logo:** new original bull-head mark (`public/logo.svg`, app icons regenerated).
- **Home:** hero panel and an illustration on every tool card (`components/ToolArt.tsx`). The pictures are decorative, built from fixed shapes, carry no market data and are hidden from screen readers; planned tools are greyed.
- **Themes:** only Light and Dark, switched with a sun / moon button. Ocean was removed; a saved "ocean" choice opens as Dark.
- **Top bar:** tighter menu spacing, smaller status pill, the stored-snapshot time now sits under the "NIFTY 50 [Snapshot]" label with the price and change on the right.

## Smart OI rebuilt to the user's spec (4 Nov 2026)
- The first Smart OI (per-strike buildup labels) was a wrong reading of the feature. It is now **OI Buildup** (`/tools/oi-buildup`), kept as is.
- **Smart OI** (`/tools/smart-oi`) follows the supplied "Smart OI Complete Engineering Spec": the session is cut into 1/3/5/15-minute candles; per candle ΔPE = PE[i]−PE[i−1], ΔCE = CE[i]−CE[i−1], **p = ΔPE − ΔCE**, drawn as a zero-baseline candlestick (green ≥ 0, red < 0) under NIFTY candles, with option volume per candle, plus day-change lines (put, call, PE−CE since the first candle) and OI PCR / volume PCR panels. Pure function `smartOiCandles` in `lib/optionTools.ts`; tested against the spec's own worked example (+150k, +450k, −800k).
- Data: `/api/history/oi-series` (stored one-minute samples, one fixed strike set for the whole day so no change comes from strikes entering or leaving a window; ATM ±5/10/20 or all, as of the newest sample), newest day only.
- Deliberate differences from the spec: the first candle is the baseline and has no bar (not a zero bar); a candle with no stored sample is left out and the next change is flagged as spanning the gap; PCR with call OI = 0 stays missing instead of defaulting to 1.0 (rule: missing stays missing). Charts use ECharts (the project's library), not Lightweight Charts; crosshair is linked across the three panels.
- Not verified with live data yet (needs a market-hours session with stored samples).

## New interface: top menu bar, Home, tool pages, themes (4 Nov 2026)
- **Structure** (requested after the user's StockMojo screenshots; structure only, no branding, code or visual copy): top bar with Strategy Builder, Option Chain, drop-downs Options Lab / Future Lab / Analyse / System, and Prediction; Home (`/`) lists every tool with search; each tool opens at `/tools/:id`. Phone: one scrolling menu with the same groups. The old side rail is removed; Platform status moved to `/overview`.
- **Registry:** `frontend/src/lib/tools.ts` drives the menus, Home and routes. A tool is *ready* only when it has a real page. Planned tools show greyed with the reason they are not built; no placeholder pages.
- **Themes:** Light / Ocean / Dark in the top bar and Settings (CSS variables, remembered in the browser).
- **New analytics** (`lib/optionTools.ts`, 7 hand-checked tests): Smart OI buildup (price change vs OI change), PE−CE difference, volatility skew, gamma and vega exposure (Black-76 from each contract's own price; gamma exposure = gamma × OI × spot² × 1 %; the call−put net is a stated convention, not measured dealer positioning). Missing prices stay missing and are counted.
- **Index tools** (Contributors, Advance/Decline, Weightage, Sector Rotation, Market Movers, FII/DII) read `/api/market/summary` and the existing flows/cash panels; if stock breadth is off on the server they say so.
- **Top bar (follow-up):** one row at every desktop width (nowrap, tighter links; theme switch shown from 1280 px up, always in Settings). Strategy Builder is now a menu holding Strategy builder and Strategy portfolio (moved out of System).
- **Installable app (PWA):** `frontend/public/manifest.webmanifest`, icons, `sw.js`. The service worker caches only the built static files; `/api` and `/ws` always go to the network, so market data is never served from a cache. Needs **HTTPS** (or localhost) to offer "Install"/"Add to Home screen" on a phone. Registered in production builds only.
- **Logo:** original mark (`public/logo.svg`: payoff line rising to a gold point inside an orbit ring), used in the top bar, favicon and app icons.
- **Themes redesigned:** each theme now sets its own surfaces, not just colours. Light = pale page, white floating cards, soft shadows, 16 px corners, system font, darker up/down/amber for contrast. Ocean = water gradient page, glass-like teal cards, glow edges, 14 px corners. Dark = unchanged. Charts read the same variables. Browser/app title-bar colour follows the theme.
- **Fix:** a menu opened by hover no longer closes on the click.
- **Planned, not built:** OI Crossover, MultiStrike Chart, Option Triggers (each needs data not yet stored; reasons shown in the menu).
- **Verified:** tsc clean, 371 frontend tests pass, production build OK, screenshots of Home, menus and phone menu on a mocked-offline API. **Not verified:** live data in these pages (sandbox cannot reach the server); check after deploy in market hours.

## Futures and heavyweight flow never received ticks: root cause fixed (2 Nov 2026)
- **Cause:** `StreamManager._reset()` (called by every `start()`: at launch and after each daily login) also set `on_internal = None`, so the market service, wired once at start-up, was disconnected from the internal tick feed. Breadth kept working because it reads the tick book directly, but nothing reached `MarketService.on_tick`: no futures price/volume/OI sample was ever stored, and the five heavyweights' order flow stayed empty. Found on the live server (internal messages 48,000 and rising, service ticks seen 0, `handler_set` false).
- **Fix:** the receiver is now set once in `__init__` and survives `start()`/restart (regression test fails on the old behaviour). The minute "fut" sample is also written from the raw future ticks when the flow tracker has no volume. `/api/market/status` shows the wiring (`handler_set`, `service_ticks_seen`) and the summary shows `flow.diagnostics` for the future.

## Chart start, Exit all, portfolio, adjustments (2 Nov 2026)
- **Charts starting at 09:16 instead of 09:15:** the OI, OI-change, volume and premium-decay charts ask the server for samples since the first stored sample's own time (microseconds), while the database keeps whole milliseconds, so the 09:15:01 sample was cut by under a millisecond. The range filter now compares in milliseconds; a regression test covers it. The Session axis already starts at the open for every chart.
- **Exit all** moves the strategy from Saved to Closed under its own name (no copy left in Saved); closing a strategy reopened from Closed replaces that record. Trades made inside a saved strategy (exits, automatic stops/targets, re-entries, rolls) are written back to it immediately.
- **Roll** (per leg): closes the leg at its live price, books the P&L, opens the same leg at another strike at that strike's live price, same stop/target percentages. The strike arrows still only edit the plan and book nothing. Payoff, breakevens, max profit/loss, Greeks and the P&L box recompute after every adjustment (tests: roll, hedge added and removed, lots, exits).
- **Strategy portfolio** (`/portfolio`): live mark-to-market of every saved strategy with an open leg (booked + open at live prices; a missing price leaves the open part blank, not zero), booked P&L of closed strategies, totals; a row opens that strategy in the builder. An unsaved strategy in the builder is listed too and asks before being replaced.
- Limit: the saved record stores base lots; the multiplier at the time of a trade decides the booked rupees.

## NIFTY futures and option-volume charts (2 Nov 2026)
- **Five new Analysis widgets:** NIFTY futures open interest, NIFTY futures OI change, NIFTY spot vs futures (gap), NIFTY futures volume, and Total volume over time (call vs put). They follow the dashboard time-range chips and are offered once to existing saved layouts (and are in the default set).
- **Data:** the market service's minute "fut" sample now also records the future's open interest (as streamed; 0 or missing stays missing), the index level at the same moment, the contract symbol and its expiry. `GET /api/futures/series` builds the series from those samples. Samples recorded before this change have no OI and no same-moment index level (the index is then joined from the nearest stored snapshot within 90 s and the chart says so).
- **Gap (basis), institutional definition:** future − index in points; % of index; implied carry p.a. = ln(F/S)/T (T in years of 365 days to the expiry close); fair basis = S(e^(rT) − 1) at the assumed 6 % rate with no dividends; "vs fair" = basis − fair. The latest values sit in the chart's corner.
- **OI change** for the future = OI now − the previous session's last recorded OI of the same contract, else the session's first value (the note under the chart names which). The option volume series sums contract volume per side over the same fixed strikes as the OI series.
- **Not yet verified live:** the stream on the server (checked at 06:20 IST) carries the options and the index only; the future and the stocks are subscribed after the morning token refresh, so whether the depth feed supplies the future's open interest is unknown until market hours. If it does not, the OI charts say "Open interest was not supplied" and stay empty rather than show zeros. Check at 09:20.

## Auto stop/target, per-leg exit, re-entry, chart lines (31 Oct 2026)
- **Paper automation, not trading.** With "Auto stop & target (paper)" on, a leg whose live price reaches its stop (checked first) or target is closed in the strategy at the live price, and its P&L is booked (`realised`, shown in the P&L box and kept as a fixed amount in the payoff). Nothing is sent to a broker; no order placement was added. It runs only on live streamed prices and only while the Strategy builder page is open (browser side), and pauses itself when the stream is not live, so it never acts on a stored or stale price. The close price can be beyond the level you set (it is the live price).
- **Per-leg Exit** (price box, empty = live price) and **Enter again at live price** under every leg. **Re-entry** box: after a leg is closed by its STOP, with re-entries left, it is entered again at the live price when the premium comes back to its own entry premium (sold: at or below; bought: at or above); the stop and target keep the same percentage distance; one re-entry is used each time. Targets and manual exits never re-enter.
- The working strategy (legs, exits, re-entries, log) is kept in the browser so a refresh does not repeat exits; Update/Save store it with the strategy. Exit all keeps booked P&L of legs closed earlier.
- Chart lines menu (was "SD fixed"): SD + stop/target lines, SD only, stop/target lines only, none. The P&L box is now first in the statistics.
- Limits: not server-side (closing browser stops the watcher); the lot multiplier at the moment of an exit decides the booked rupees; a one-tick spike can trigger a stop (no confirmation delay).

## Targets and stops fixed (30 Oct 2026)
- **Bug:** the percentage box was rebuilt from the rounded price after every keystroke, so for many premiums what you typed was rewritten (premium 3.5: "70" became 7.1, "12.5" lost its point, 12.35: "40" became 40.1). The box now keeps exactly what is typed and shows the computed value only when you leave it.
- **New:** each target/stop shows how far the live price is from it, or "Target hit"/"Stop hit" when reached (a bought option's target is above its entry and its stop below; a sold one is the mirror). A banner in Positions lists every level reached. Nothing is exited or sent to a broker; use Exit all or act at the broker.

## Session close from the exchange, clean-up page, known weaknesses (30 Oct 2026)
- **Session close follows the exchange.** The close (15:40 with the Closing Auction Session alignment, 15:30 if NSE ends it) is no longer a constant. `app/lifecycle/session_close.py` reads the feed's own market-status messages already stored in the observation events (first F&O "closed" message after 15:20 IST each weekday), and the close in force changes after two sessions in a row show the same time (one odd day is only flagged). `MARKET_CLOSE=15:30` fixes it by hand. The sampler, features, labels, volatility, market recordings, and in the browser every chart and the model's time to expiry read it through `session_close()` / `sessionCloseMin()`; `GET /api/market/session` reports the close, its source, the observed days and any pending change. A closed message from the feed during the session still stops the sampler at once (that part already existed). The 375-minute volatility scaling convention is unchanged.
- **Exchange holidays** reach the browser in the same answer (verified NSE circular list), so a manual fetch on a weekday holiday is no longer counted as a session in charts or time-decay.
- **Data clean-up page** (`/cleanup`, nav "Data clean-up", `GET/POST /api/storage/cleanup`): disk and runway, today's samples/contract rows/snapshot files/intraday ML rows, every store with row counts and its keep rule, the four removable categories with measured sizes (raw responses, normalized files, per-contract rows of old sessions, regenerable files), the never-removed list. Removal needs: select, review the exact amounts, tick the acknowledgement, and the server re-checks that each day's verified archive covers it; unknown items and a missing confirmation are refused. The nightly automatic run is unchanged (per-contract rows stay dry-run until `OBSERVATION_PRUNE_DRY_RUN=false`).
- **Greeks:** the backend forward is now the median over the five strikes nearest spot (same as the builder); both implementations are held to the same Black-76 reference values (price, IV, delta, vega). Remaining conventions differ by design and are labelled: backend delta is per forward and discounted, builder delta is per spot; theta is analytic in the backend and a one-day change in the builder.
- **Strategies:** a newer edit made while the server was unreachable is sent up when it returns (newest `updatedAt` wins), and failed saves retry every 45 s.
- **Info buttons** now also cover the strategy table headers (strike, lots, entry, target, stop, P&L, Δ·Θ, Greeks tab, Call/Put OI) and the clean-up page.

## Info buttons and sentiment chart (30 Oct 2026)
- A small **i** button explains a panel or number: what it is, how to read it, what to keep in mind. Text lives in one place, `frontend/src/lib/glossary.ts` (about 75 entries); `Info` looks a title or label up there and draws nothing when there is no entry. Wired into: shared `Panel` headers, intraday cards, every Analysis widget and its full-size view, `Tile`s, and the strategy builder statistics. Opens on click/tap, closes with Escape, the × or a click outside; drawn outside the card so it is never clipped, bottom-aligned for narrow screens. Tests check every widget and intraday card title has an entry. Not covered yet: individual table column headers (except Greeks terms in the glossary) and the Prediction/Diagnostics sub-labels without an entry.
- Sentiment history chart: legend no longer overlaps axis titles, axes are coloured to match their lines (score −1…+1 left, NIFTY right as whole points), HH:MM time labels, tooltip shows the full time and both values.

## Top bar (30 Oct 2026)
- Live check at 11:28 IST: one `option_chain` call to the broker failed at 11:25:39 IST (ApiException) and the next fetch worked about 3 minutes later; the header showed that moment as a red "Snapshot: Last fetch failed". A failure within 5 minutes of a successful fetch now shows amber "Retrying" with the reason on hover; red stays for failures with no recent success.
- Phone header: Menu, name and status pill on one row, NIFTY price and change on the second row (nothing cut off); the pill truncates instead of overflowing. Desktop: price, change and time on one line.

## Strategy builder: Update, Reset/New, server-save fix, layout (30 Oct 2026)
- **Server save 404:** strategy names such as "straddle - range bound -30/10/2026" contain slashes; the proxy split them into path parts so PUT/DELETE did not match any route. The name now travels in the body (`PUT /api/strategies/{kind}` `{key, doc}`) or query (`DELETE /api/strategies/{kind}?key=`). Tested with a slashed name.
- **Update** moved beside Exit all in the Positions header (shows a dot while there are unsaved changes). **Reset** (undo edits back to the built/loaded strategy and default what-if/date/IV/multiplier/zoom) and **New** (blank strategy, clears name and loaded state) are now separate buttons, each disabled when it has nothing to do.
- Layout: the option chain stays in view while the right column scrolls (no empty space under it); risk stats are two rows of tiles that fill their row (key outcomes, then breakevens/net premium/Greeks/exit sums); legs table fits the card without a sideways scroll (expiry and distance from spot shown under the strike, Δ and Θ on two lines, icon buttons for duplicate/remove).

## Strategy builder payoff chart and mobile (30 Oct 2026)
- Payoff chart opens on the **profit zone** (between the breakevens, current price included) instead of the whole computed range. **− / + / Fit** buttons zoom around the centre of the profit zone (0.7x per step); the y-axis refits to the visible part; mouse-wheel/drag zoom is removed. The visible range is shown next to the buttons.
- Jitter: the chart redraws at most every 2.5 s while live ticks arrive, and at once when the zoom, legs or controls change; axis edges snap to 10 points.
- Phones: legs table becomes one card per leg, compact chart (no right OI axis), shorter chain scroller, wrapping toolbar. Checked by screenshots at 390 px and 1440 px against the replay backend: no horizontal overflow.
- Projected P&L label no longer says "loss −₹0" at zero.

## Intraday page layout fixes (30 Oct 2026)
- Key levels: the overlapping ladder drawing and the duplicate table are replaced by one list sorted by price with the current price placed among the levels, distance in points from it, and the nearest level above and below. Unavailable levels (e.g. VWAP for an index) stay listed as n/a with their reason on hover.
- Cards sit in a wrapping flex row and grow to fill it, so a row has no blank gap when a neighbouring card is not shown (paper trading, regime, data coverage, global panels).
- Sector bars: room beyond the longest bar and wider name column, so values no longer overlap names ("Capital Goods", "Construction") or get cut off.
- Checked by unit tests only, not yet by eye on the deployed page.

## Strategies stored on the server (30 Oct 2026)
- Saved and closed strategies now live in `strategies.sqlite3` (data dir) via `GET /api/strategies`, `PUT/DELETE /api/strategies/{saved|closed}/{key}` and a one-time `POST /api/strategies/import`. Delete only marks a strategy deleted; every create/update/delete is appended to an immutable `revisions` history. The file is covered by the nightly backups (all `*.sqlite3`) and listed in the storage report.
- The builder loads from the server, moves strategies that only this browser holds up once, writes every save/update/exit-all/delete through, and shows `Stored on server` or `Browser only (server unreachable)` / `Not saved on server: …`. The browser copy is a cache.
- Limits: the endpoints are not authenticated (same as other read/write app routes behind Caddy; no broker access), edits made while the server is unreachable are not merged back over the server's copy, and there is no per-user separation (single-owner app). Not yet running on the server until deployed.

## Live prices in the builder, cleaner session charts (30 Oct 2026)
- Strategy builder now uses the same live-tick overlay as the Option chain page (streamed LTP and spot over the stored snapshot while the stream is fresh, `LIVE` tag; stale or closed stream falls back to the snapshot). Chain refetch 15 s (was 30 s). Not yet verified in market hours on the server.
- Time-series charts: no dots, session axis ends just after the newest sample while the session runs (full session once closed), premium-total samples that sum fewer priced contracts than the best sample are drawn as gaps.

## Strategy builder: Update saved strategy, own target/stop percentages (30 Oct 2026)
- A loaded (or just saved) strategy shows an **Update “name”** button and a Saved / Unsaved changes marker; Update overwrites the same entry with the current legs, strikes, lots, targets and stops (no copy). Cleared on Reset, expiry change, exit all or opening a closed trade. Saved strategies are still browser-only (localStorage).
- The fixed 30/50/80% target and stop buttons are gone. Each leg has a percent box (distance from the entry premium) next to the price box; either one sets the target or stop, nothing is pre-filled.

## Chart integrity and data-handling plan, 30 Oct 2026
- Cause of broken PCR / OI-change charts: two stored samples held absurd OI (2.23e17, 8.4e18). Now flagged at ingest and read as missing; stored rows untouched. Premium decay baselines per IST day. Backend tests for both added. Not yet verified on the live server (needs deploy).
- Retention plan written in `docs/storage-plan.md` (intraday section). Per-contract row pruning is built and runs nightly in **dry-run** mode (keeps 2 sessions, archive-verified only); nothing is deleted until the owner flips `OBSERVATION_PRUNE_DRY_RUN=false`.
- Time-series charts: soft area fills, labelled day dividers for multi-day ranges, PCR 1.0 reference line.

## StockMojo comparison, 29 Oct 2026 (read-only check of the server's stored samples)
- Our widgets match our own API to the unit (±10 strikes around ATM 22,950: call OI 6.610 Cr, put OI 6.838 Cr, change +33.11 L / +3.95 Cr). StockMojo showed 6.58 / 6.79 Cr and +29.71 L / +3.9 Cr.
- The gap is in the *current* OI, not the baseline: our OI minus StockMojo's is about 3 L (calls) and 5 L (puts), and the change gap is the same size, so both tools use the same previous-day baseline.
- The same ±10 strikes held 6.466 / 6.820 Cr in the last in-session sample (15:29 IST) and 6.610 / 6.838 Cr in every sample stored after the close (first at 20:21 IST). OI is revised after the close, so any tool is only comparable at the same timestamp. StockMojo's figures sit between those two moments and its capture time is unknown.
- Our totals cover ATM ±10 only (the widget says so). The whole chain is 12.95 Cr calls / 16.96 Cr puts, so a tool that sums all strikes shows different totals.
- Open items: no stored sample at 15:30 itself (sampler's last in-session sample was 15:29); post-close fetches show deep-OTM contracts with OI 0 and LTP 0.0, which is not a real quote.
- New (29 Oct): the PCR widget (ATM strike, strikes in view, whole chain; shown once to saved layouts), dark change segments in the OI explorer, and a Full-view table of every time slot.

## Strategy builder (30 Oct 2026) and the 09:15-15:40 session
- New page `/strategy` (reference: Opstra's public behaviour; see `docs/opstra_public_feature_audit.md`, `nse_universe_integration_plan.md`, `strategy_builder_specification.md`, `options_payoff_engine.md`, `testing_and_validation.md`). Scope cut on 30 Oct to **building a strategy and its payoff graph**: the app's own stored NIFTY option chain sits inside the builder (B/S buttons add legs at the stored quote), 16 editable templates, leg table, exact expiry payoff with max profit/loss/breakevens, save/load in the browser. Greeks, what-if, costs, the backtester (and its two API routes) and multi-expiry templates were built and then removed at the owner's request (git `0bf3ecf`). NIFTY only.
- Session: one constant (`backend/app/domain/session.py`, `frontend/src/lib/session.ts`) now 09:15-15:40 IST because NSE derivatives have closed at 15:40 since 3 Aug 2026 (CAS alignment). Sampler, intraday features/labels, expiry time in the IV maths, EOD job (15:50), ledger close, index-bar completion (16:10) and the charts all read it. If NSE reverts, change both constants. Not yet confirmed that the rule is being removed.

## Daily forward-test log (30 Oct 2026)
- New append-only `prediction_daylog.sqlite3`: after 09:10 IST every session day writes one row per horizon: recorded or not recorded, the reason (late series, report not computed), the number the page showed. A missed day keeps its number only as a preview; it is shown next to what actually happened ("Right/Wrong · not counted") and never enters the ledger or the scoreboard. Shown on the Prediction page ("Daily forward-test log"). The first row will be written for 30 Oct; 29 Oct is not back-filled (no record of what was shown).
- Already in place: append-only ledger with content hashes, outcomes attached after the target closes, scoreboard vs base rate, post-mortem with the inputs that pushed each forecast, retraining when new final bars arrive, Compute now per model.

## Prediction freshness check, 30 Oct 2026 00:58 IST (read-only, server)
- 29 Oct: the models were trained at 08:35 IST (report computed 03:05 UTC) but **no forecast was recorded** (forward ledger: 0 forecasts, 0 outcomes) because the overnight series were not final: SPX, VIX, BRENT, DXY, USDINR, UST10Y bars for 28 Oct had been stored mid-session at 23:16 IST on 28 Oct by the first deployed build, and the 07:33 IST refresh logged them as disagreements instead of replacing them (the current code replaces such partial bars: `bar_corrections`, tested). 14 bars are listed as held back.
- Expected self-heal: the 07:30 IST refresh on 30 Oct (current build) corrects them; the history service then retries every 10 min until 09:10 while overnight bars are missing. New: the model run in the 08:35-09:10 window now waits until the overnight data is final (`morning_ready`, checked every 4 min) instead of running once at 08:35 and giving the day up.
- News (GDELT, display only, not used by the models) fetches automatically (last fetch 29 Oct 19:27 UTC); one theme (US Fed timeline volume) returned HTTP 429.
- Verify on 30 Oct after 09:10 IST: `/api/prediction/summary` should show `fresh: true`, forecasts `recorded: true`, ledger counts above 0, and `partial_bars_held_back` empty.

## NSE flows: missing 29 Oct participant data, schedule, Update now (30 Oct 2026)
- Root causes (read from the server's `/api/prediction/flows/status`): (1) the fetcher asked NSE only for sessions that already had a NIFTY daily bar, and that bar appears after the close is final, so 29 Oct's files were never requested; (2) participant **volume** files were all rejected (NSE writes "Trading Volume", the parser required "Trading Volumes"), so none were ever stored; (3) one attempt per evening, so a file published after the attempt waited a day.
- Fix: candidate sessions = bar sessions plus recent weekdays up to the expected session (holiday calendar when it covers the year); expected session = today after 18:30 IST, else the previous session. Automatic checks: one at start, then every 30 min from 18:30 IST only while an expected file is missing; they stop once it is stored (also after a manual update) and cool down 3 h after an NSE block. Stored values are never overwritten (append-only by policy), so a manual and an automatic run cannot disagree.
- "Update now" (manual run, also fetches cash and NSDL regardless of the hour) on the F&O participant panel, the FII/DII cash panel and Settings; each source shows newest stored session, last successful automatic check and last manual update (`runs` table in the flows store; failures are shown as failed, never as success).
- Prediction: "Compute now" on each model card (T+1 / T+5 retrain only that horizon, allowed in market hours) with last automatic / last manual run (`prediction_runs.json`). Not yet seen with live NSE files: after the next deploy, check `/api/prediction/flows/status` for `fao_participant_vol` rows and the 29 Oct files.

## Total premium and spot fixes (30 Oct 2026)
- Total premium, total OI and volume in `/api/history/observations` summed ATM ±N re-centred on each snapshot, so the lines mixed different strikes as NIFTY moved. They now sum the ATM ±N strikes of the newest snapshot at every point (`observe(..., fixed)`); the ATM straddle still follows each snapshot's own ATM, which is its definition. Test: `TestFixedUniverse`.
- Spot mismatch (29 Oct screenshot): the Analysis page's option-chain query never refetched, so "Spot (snapshot)" showed the snapshot loaded earlier (22,822) while the header and the Command Center showed newer ones (22,869). The chain now refetches every 30 s and the label says which snapshot time it shows. The live stream tick, the last 60-second sample and the page's snapshot can still differ by seconds; each now carries its own time.

## PCR / OI trend widgets (30 Oct 2026)
- New widgets (offered once to saved layouts): "Put-call ratio over time", "OI change over time (call vs put)", "Total OI over time (call vs put)" (NIFTY dotted on the left axis, metric on the right; strike picker defaults to all listed strikes) and "PCR donut: overall and ATM" (outer ring whole chain, inner ring ATM strike), plus the earlier PCR table. Backed by `/api/history/oi-series`: the same strikes at every point, OI change = OI minus the broker's previous-day OI (strikes lacking either are left out and counted). Not yet checked against live data.

## Premium decay fixed (30 Oct 2026)
- The old decay line summed prices over "ATM ±10" re-centred at every sample, so strikes entered and left the sum as NIFTY moved (calls fell while NIFTY rose). `/api/history/premium-decay` now sums the price change of the SAME strikes (ATM ±N of the newest sample) against the first sample in range; a price that is missing or not above zero drops that strike from the point and is counted. Hand-calculated tests in `test_observations.py`. The Total premium widget still shows the sliding-universe total and says so.

## OI explorer, StockMojo-style single screen (30 Oct 2026)
- Time slots count back from the last stored sample of the session (after the close, including past midnight IST: the last sample taken 09:15-15:30 IST) and pass `until` to `/api/oi/change`, so after hours "Last 30 min" shows the final half hour of trading. Full view shows Open Interest Change, Total Open Interest and PCR cards for the chosen slot, next to the strike chart; the table was removed. OI-decrease segments no longer have a border. StockMojo's page (29 Oct 15:40:59 data) shows PCR 1.03, the same as ours. Not yet checked in a live session.

## OI explorer (29 Oct 2026)
- The default Analysis widget "Open interest by strike" now carries the explorer (no separate widget to add): modes OI change + total / OI change / Total OI; windows Last 3/5/10/15/30 min, 1/2/3 hr, All; call/put OI, change and PCR for the window; ⤢ Full. Windows compare the newest stored sample with the one that long ago (`/api/oi/change`, baseline `at`), so they need stored samples (about one a minute in market hours). Not yet checked in a live session. The "Sampled live / Sampling delayed / Stored" chip is removed; time-series widgets show only "last sample HH:MM IST".

## Intraday engine audit (29 Oct 2026)
- Strict audit done (docs/audit-2026-10-29.md): 15 defects fixed with regression tests, backend 508 / frontend 185 tests, ruff and mypy clean. Still never run on live Kotak data: check `/api/market/coverage`, `/api/market/status` and the Command Center in the first market session. No probabilities are shown until 60 labelled sessions pass the gate.

## Market breadth (built 2026-10-29, unverified live)
- Official NIFTY 50 weights loaded (D59): NSE index tracker, 29 Oct close, rolled forward with price; top-5 are now HDFCBANK, ICICIBANK, RELIANCE, BHARTIARTL, LT. Compare with the page's advance/decline (39/11 on 29 Oct) after the next session.
- Added 29 Oct evening (D58): NIFTY futures flow/CVD, depth for the top-5 heavyweights, technical read from daily bars, estimated weights, own intraday volume profile (after 5 sessions), list-change log, snapshot retention enabled (raw 7 d, normalized 14 d, verified-archive days only). Offline-tested; Kotak depth fields and the F&O scrip master are unverified.
- `/api/market/summary|status|coverage`, `POST /api/market/refresh`, `POST /api/market/weights/import`. NIFTY 50/500 breadth, heavyweight contribution, relative volume, sectors in the Command Center. Offline-tested only; needs a market-hours check of token coverage and tick fields. Weights not loaded. See D57.

## Implemented (Checkpoint 1)
- Backend (FastAPI, `backend/`): settings validation, redacted JSON logging, Kotak adapter (TOTP-secret login, `expiries()`, `option_chain()`), labelled mock adapter, expiry selection (weekly / monthly with next-month roll), chain normalization, snapshot storage (JSON + SQLite index + CSV), REST API, local-only control endpoints.
- Frontend (`frontend/`): app shell with signal-chain status bar, Overview, Data & sessions (inspector, CSV), Diagnostics, Settings (theme); **Live option chain** (snapshot-based: weekly / monthly / other expiry, ±N strikes around the broker's ATM label, strike filter, CE/PE toggles, sticky header, refresh per expiry); Expiry comparison shown as Planned. **Analysis** (`/analysis`, auto-sampled every 60 s in market hours, `/charts` redirects): drag/resize widget dashboard (react-grid-layout, layout kept in localStorage) with ECharts: OI / OI change / volume by strike, total CE vs PE bars, option chain table, total premium, premium decay, ATM straddle, spot observations, key levels (PCR, max pain, straddle), strike detail, plus OI intelligence widgets (intraday OI change with selectable baseline, change heatmap, concentration, price and OI) read from the persistent observation store (D39). Built from the stored snapshot; live ticks overlay it while the stream runs. Time-series widgets plot stored snapshot observations only (`GET /api/history/observations`) and say so; flat/insufficient data gets an explicit note, never a fake line.
- Windows (user's PC, 2026-10-28): launcher ran, backend + frontend verified, Kotak Neo live sign-in reported `authenticated`, real expiries retrieved (18 listed; weekly 2026-11-03, monthly 2026-11-23).
- Scripts: `scripts/setup.ps1`, `dev.ps1`, `check.ps1`, `live-check.ps1`. Guide: [setup-windows](setup-windows.md).

## Tested
- On the user's Windows PC (Python 3.14.8, Node 24.21): launcher offline checks all passed (ruff, mypy, pytest 70, tsc, vitest 19, build) before the option-chain page was added.
- In Claude's Linux workspace (Python 3.13, Node 22): (historical, Checkpoint 1) pytest 70, vitest 27. **Latest (2026-10-28):** pytest 127 passed (3 live skipped), ruff + mypy clean, vitest 108 passed, `tsc` clean, build OK, `npm audit` 0 vulnerabilities; Analysis page checked in a real browser against replayed real payloads.

## Not tested
- Anything on the Windows laptop (setup, run, tests) — not yet run by the user.
- Live chain parsing after the fix (decisions #21-23): the user must restart the live launcher and refetch; Superseded: the parser is now tested against two full real responses (81 strikes each); mock mode no longer exists.
- SFeed streaming, live in-place updates, charts, expiry comparison page — not built.

## Blockers / open questions
- User must create `backend/.env` (DATA_MODE=live + KOTAK_*) and run `scripts\live-check.ps1`.
- Live response shapes and SFeed timestamp semantics — see [decisions](decisions.md#open-questions).

## Checkpoint 2 (streaming) — built, awaiting live verification
- **No mock/demo mode anymore (decision 32).** Snapshot is the base; the stream updates everything it can (decision 33); streaming autostarts (34).
- Backend: StreamManager + SFeed adapter + app WebSocket + start/stop API; frontend: live store with row-level subscriptions, reconnecting WebSocket, header signals (broker / snapshot / stream / market / data), live panels on Overview and Diagnostics, LTP and volume overlay on the option chain.
- Tested in Claude's workspace: backend 104 pytest replaying the REAL captured Kotak responses (no invented data), ruff + mypy strict clean; frontend 59 vitest, tsc, production build. The live Kotak stream itself has not been exercised (market closed).
- NOT verified: anything against the real Kotak SFeed (market was closed). Run `scripts\stream-check.ps1` during market hours (09:15-15:30 IST); see decisions open questions.
- Code and package changes show up on a browser refresh (backend auto-restarts, frontend hot-updates, watcher installs new packages). Double-click `NSE Universe.cmd` only to open the app; nothing needs stopping.

## Checkpoint 1 (new brief) — audit done
See [audit-checkpoint1](audit-checkpoint1.md): real snapshot data confirmed, not streaming; 13 findings (F1 market status, F2 OI/volume are units, F3 empty snapshot shadows good one, ...). Findings addressed so far: F3 (empty snapshot no longer hides a good one), F1 partly (market status is read from the exchange feed once streaming; verification pending). Open: F2 units labelling, F4-F6, F8-F10.

## Next action
1. User: `scripts\setup.ps1` → `scripts\check.ps1` → `scripts\dev.ps1` on Windows (or just double-click NSE Universe.cmd).
2. User: fill `backend\.env`, run `scripts\live-check.ps1`, share the (secret-free) output.
3. Claude: fix any live-shape mismatches, then Checkpoint 2 (SFeed streaming, app WebSocket, live state).


## Swing trading: website section and automatic paper trading (2026-11-05, D65)
- Built and tested locally (backend 383 passed incl. scorer and engine parity tests, ruff + mypy clean; frontend tsc, build, 189 vitest with the swing page tests; one existing Analysis test is intermittently slow when the whole suite runs at once). New: `backend/app/swing/` (scorer, engine, fetchers, SQLite paper book, daily job), `GET /api/swing/paper`, `GET /api/swing/report`, `/swing` page, `scripts/swing-refresh.ps1`, `data/swing_paper.sqlite3`. Details: [swing-backtest](swing-backtest.md).
- Live-checked against real Chartink and Yahoo in a scratch folder (7 orders queued, 803/803 stocks). **Not deployed**: nothing committed, pushed or changed on the server. After deploy the first run after 17:00 IST starts the paper book; copy `data/swing/report.json` to the server's `data/swing/` for the Backtest tabs.
- Not verified: the job inside the running server (memory slice, systemd), a full multi-day paper run on real data (only one session exists), behaviour on an NSE holiday.
- Live prices (D66, 2026-11-05): the Paper trading tab has a live panel fed by the Kotak feed for queued orders and open positions (price, volume pace, distance to trigger/stop/1.8R/2.5R); decisions are shadow-only and logged in `live_events`; the book follows the end-of-day settlement. Tested with replayed ticks and a fake feed (live rules, watcher, subscription, shadow log, page). **Not verified against live ticks** (needs the first session): instrument-file download, volume semantics, extra subscriptions. Live execution is phase 2, see [swing-backtest](swing-backtest.md).


## Server deployment (2026-10-28)
Deploy kit written and tested for update/rollback logic and backend startup with server-style settings; **not yet run on the VPS** (see docs/deployment-server.md). T+1 overnight and T+5 broad models, calibration, calls and the forward scoreboard are built; see docs/decisions.md D47.

## Intraday analysis (2026-10-29)
- `/analysis` renamed **Intraday analysis**; Market Sentiment Command Center added above the widgets (D52, [intraday](intraday.md)): overview header, rules-based sentiment with coverage, evidence breakdown (expandable formula/inputs/source), observed regime, qualitative scenarios (no probabilities), decision context, key levels with provenance, options positioning, data coverage and warnings, global/sector/FII-DII context, events, intraday-ML status, stored score history.
- Backend `app/intraday/` + `GET /api/intraday/summary`, `GET /api/intraday/scores`; score ledger `data/intraday.sqlite3` (append-only), recorded each minute in market hours.
- Tested in Claude's workspace: pytest 266 passed (26 new; plus a fix for a wall-clock leak in the history run log that broke a schedule test after 07:30 IST: features, scoring, leakage `until=now`, ledger immutability, API, real captured chain), ruff + mypy clean; vitest 156 passed (12 new), tsc, build; browser check at 1440 px and 390 px (no horizontal overflow) using a payload computed from the PC's real daily history and FII/DII data plus the real captured chain.
- **Not verified live:** no market-hours sample existed before 29 Oct 2026 (0 complete sessions); the first live session is 29 Oct. Breadth, intraday sectors, news headlines, intraday ML, manifests/archive and the daily report are not built (see intraday.md).

## Intraday / prediction separation (2026-10-29, D53)
- Found and fixed a real leak: 12 partial bars (US/Europe, 28 Oct) and 4 Asian bars (29 Oct) had been stored mid-session as final. They are excluded and the 12 were corrected from the final download (the 4 of 29 Oct are corrected after those sessions end). `history/status` lists any held-back bars (`partial_bars_held_back`).
- Models are trained/evaluated only outside market hours (report states "paused" and serves the cache during 09:15-15:45 IST); forecasts are still recorded only 08:35-09:10 IST on overnight data.
- Guard tests: `backend/tests/unit/test_no_intraday_leak.py` (import boundary, completion times, the 28 Oct incident replayed, retry logic, market-hours gate).

## Daily broker sign-in (2026-10-29)
- The backend signs in to Kotak Neo every day at 08:30 IST (`BROKER_DAILY_LOGIN`, `BROKER_LOGIN_TIME`), retries every 5 minutes until 09:10 on failure, and restarts the live stream afterwards if it was running so it uses the new session. Status: `GET /api/broker/daily-login`. Tested with a stand-in broker (schedule, retry, once per day); the first real 08:30 run is 29 Oct.

## Storage and end-of-day lifecycle (2026-10-29, D54)
- Built and tested (pytest 306 passed in Claude's workspace; vitest 168): `backend/app/lifecycle` (verified daily archive, session manifests, daily summaries with the close-of-day chain, verified backups with bounded retention, regenerable-file tidy, snapshot retention with safety checks, storage report), `GET /api/storage/status`, `POST /api/storage/eod/run`, Settings -> Storage panel. Plan and numbers: [storage-plan.md](storage-plan.md).
- **Not enabled until the owner approves limits:** removal of snapshot files. Defaults keep everything.
- **Open finding:** the PC stopped collecting at 09:49 IST on 29 Oct (the log ends there without an error, consistent with the computer sleeping). Only the server should be relied on for full sessions; its first full session has not been checked from here.
- Not verified live: the end-of-day run has not yet executed on a real full session (the first one after deploy is the next trading day).

## Intraday regime and ML plan (2026-10-29, D55)
- Regime measure fixed (z-score of the move + 5-minute path efficiency); scenarios filtered by relevance; nightly labelled dataset (`feature_rows`, version if-1) built by the end-of-day job; page shows the ML stage. Not verified live: the first nightly dataset is built after the next full session; no intraday model exists yet.

## Breadth and sectors (2026-10-29, D56)
- Planned, not built: [market-breadth-plan](market-breadth-plan.md). Breadth and sector evidence groups and two decision-context questions read "Unknown" until phase 1-2 exist. First step: a market-hours capture of stock ticks to verify fields, rates and sources.

## 30 Oct 2026: strategy builder redesigned (StockMojo-style)
New layout, ready-made gallery, POP/Reward:Risk/breakeven % stats, dashed model estimate, ±SD markers, OI bars on the payoff, Positions/Greeks tabs, multiplier, include checkboxes. `optionModel.ts` restored with `contractDelta`, `probabilityOfProfit`, `sdBands`. 270+ frontend tests, tsc and build pass. Live check after deploy still to be done by eye.

## 30 Oct 2026: payoff chart reworked, target and stop-loss per leg
Chart: y-scale fitted to the shape (a runaway side is clipped at 3x the other), x-range out to the 2-sigma band, shaded 1σ/2σ corridors, horizontal spot label, vertical BE/σ labels, OI bars smaller, tooltip shows % from spot and the σ zone. Per leg Target and Stop-loss premium (price or 30/50/80% and 30/50/100% presets; sides swap for sellers; wrong side is flagged). Stats show "If targets hit" / "If stops hit" (exact arithmetic) and the chart marks the NIFTY level where each leg is modelled to reach its target/stop (`spotAtPremium`, a model estimate, Black-76 at the chosen day). Not wired to any order: read-only, no order placement.

## 30 Oct 2026: data-derived blue line and sigma, wider payoff, advanced builder
- **No assumed forward:** the forward is read from put-call parity in the stored chain (median over the 5 strikes nearest spot, spread shown); the carry that reproduces it replaces the assumed rate. The rate (default 6 %, Settings) now only discounts. If fewer than 3 strikes have both prices the page falls back to spot grown at the rate and says so.
- **Blue line (T+0/T+n estimate):** each leg uses the implied volatility of its own strike's stored price (not one backed out of the typed entry premium); at the snapshot spot the model reproduces the stored price (tested).
- **Sigma:** lognormal quantiles ln S = ln spot + carry t - sigma^2 t / 2 +/- k sigma sqrt(t), ATM IV taken at the strike nearest the forward. Markers, scenario rows and POP now use one distribution (tested together: a call struck at +1σ wins 15.9 %). The old linear spot±kσ√t bands are gone. ATM straddle price shown as a model-free cross-check.
- New: what-if sliders (day, IV shift, NIFTY level, with exact expiry P&L next to the model P&L), Scenarios tab (σ rows × dates, expiry column exact), Model inputs panel, strategy analysis panel (`strategyInsights.ts`), stats strip above a full-width chart.

## 30 Oct 2026: why StockMojo and our estimates differ (checked against the server chain)
- Stored weekly 22950 CE/PE LTP is 154.5/125.2 (fetched 02:37 IST 30 Oct, no exchange timestamp); StockMojo at 15:40:59 shows 150.6/128.25. Net credit 279.7 vs 278.85 = 0.85 pt x 65 = ₹55: this alone explains max profit 18,181 vs 18,125, breakevens 22,670 vs 22,671 and expiry P&L 11,031 vs 10,975 at 22,840.
- The blue line is sensitive to the put-call-parity forward (C-P at one strike): each point of forward moves the 22,840 value by ~₹15. Forward 22,979 from our prices vs 22,972 from theirs accounts for most of -215 vs -335.58. Reproduced independently in Python (their prices, parity forward, T=4.99 d gives -335).
- Fixed: model time ran from the fetch (after hours, T=4.54 d); now from the market time the prices belong to (`marketClockMs`, 15:40 of the last session, T=4.99 d). Holidays are not known to it.
- Not fixable from here: last-traded prices of two contracts are not simultaneous, and no in-session snapshot exists for 29 Oct. The first in-session samples (30 Oct from 09:15) will be the real comparison.

## 30 Oct 2026: Greeks everywhere, sigma convention, leg UI
- **Greeks (`contractGreeks`, Black-76, tested against finite differences):** delta = e^((carry-r)t)N(d1); gamma; vega = e^(-rt)Fφ(d1)√t/100 per vol point; theta = price one calendar day later minus now (intrinsic after expiry). One calculation feeds the chain columns (Δ Γ Θ Vega IV, pick in Settings; Wide mode), each leg row, the Greeks tab and the net strip. Rho omitted on purpose (forward comes from the market).
- **Delta vs StockMojo:** compared per strike from the screenshots: put delta 22850 to 23200 ours -0.36 -0.41 -0.46 -0.52 -0.58 -0.64 -0.69 -0.75, theirs -0.36 -0.42 -0.47 -0.53 -0.59 -0.65 -0.70 -0.75. All within 0.01. The offset is the forward: parity from every strike 22400-23450 gives 22,978-22,981 (very consistent), theirs ~22,972 from their prices; 9 forward points = 0.01 delta at 4 days.
- **Sigma levels:** now the market convention, spot x (1 ± kσ√t) centred on spot (was lognormal about the forward, which pushed both sides ~60 pts right of StockMojo's). ATM IV at the strike nearest the forward, t to the 15:40 close. POP stays lognormal about the forward.
- Strategy-analysis panel removed. Legs: coloured edge, strike and lot steppers, per-leg Δ·Θ, summary line. Chain rows holding a leg are tinted, tagged with +/- lots and keep their B/S buttons visible (the ready-made strategies did not highlight before).

## 30 Oct 2026: Exit all and Closed strategies
"Exit all" (positions card, right corner) exits every ticked leg at its stored price, saves name, legs, entry, exit and realised P&L as a closed trade (browser storage, key `nse.closed.v1`) and clears the builder; it refuses, naming the legs, when a leg has no stored price or entry premium. "Closed (n)" beside Saved lists them; clicking one loads its legs and shows a banner with the exits. Chain rows holding a leg have −/+ for one lot fewer/more. Nothing is sent to a broker; exit prices are stored snapshot prices, not fills.

## 30 Oct 2026: payoff graph in the StockMojo layout, OI linked to the chain
Solid blue "on target date" line, SD labels across the top, boxed "Current price", OI bars for every chain strike (call green / put red, same colours as the chain) standing on the zero line with their own right axis, selectable Open interest / Change in OI (bars go below zero) / none; OI strip for the ATM strike; SD fixed/off; Zoom out; NIFTY target with −/+ and level box; date slider with prev/next day and "nD to expiry"; projected P&L badge at the target. **Bug fixed:** `MarkAreaComponent` was never registered in the app's ECharts, so the ±1σ/±2σ shaded corridors had not been drawing (tests registered it themselves); now registered in `EChart.tsx` and in the render test.

## 30 Oct 2026: Intraday analysis page, visual pass
`components/viz.tsx` (Gauge, MiniBar, FillBar, RangeBar, SplitBar, Tile, Ladder) and two chart builders (`ivSmileOption`, `divergingBarOption`). Breakout card: opening-range (or previous-day range when none is stored) bar with the current price; heavyweights and top-5 tables: change bars, RSI bars, trend chips; IV card: smile chart; positioning: PCR bars around 1.0 and top-3 concentration bars; sectors: diverging bar chart beside the table; global/sector rows with bars; setup monitor: decision banner, control chips, status pills; paper trading: KPI tiles; key levels: price ladder; options positioning: PCR gauge and call/put splits; decision context: highlighted answers. All text and test ids kept; a missing value still draws an empty track, never zero.

## 30 Oct 2026: time-series charts are session-only
`rangeObservations` keeps only samples taken on a weekday between 09:15 and the 15:40 close (IST); overnight and weekend fetches hold the last close and drew a flat line across the night. Ranges (30 min, 1 hour) are measured back from the newest in-session sample; Session fixes the x axis to that day's 09:15-15:40; All shows only session samples with a gap (null) between days. `sessionize()` applies the same rule to every time-series chart, including premium decay and the OI series, whose data come from the backend with overnight points. If a stored set has no in-session sample at all, the after-hours samples are shown with a note. Exchange holidays are not known to the frontend, so a manual fetch on a weekday holiday would count as a session sample. The 15:40 close (CAS) lives in `lib/session.ts` and `app/domain/session.py`; change both if NSE reverts.

## 30 Oct 2026: PCR widgets merged
"PCR: ATM and overall" now holds the donut (outer ring overall, inner ring ATM) beside the PCR table; the separate "PCR donut" widget is gone (a saved layout that still lists it simply drops it).

## 30 Oct 2026: Prediction page, visual pass
Compute now is a highlighted accent button in its own strip with the last automatic / manual run as pills. Each forecast has a "Reading of this forecast" written from its own numbers (`readingLines`: distance from the base rate in points, whether the models agree, the call or why none, the historical ranges as prices, event risk; nothing fixed about the market). New graphics (`PredictionViz.tsx`): model dots against the base rate, historical range bar around the last close, holdout gain with 95% intervals per model, reliability plot in the model detail, hit-rate interval in the forward scoreboard.

## 30 Oct 2026: Prediction page, second visual pass
FII/DII cash and F&O participant panels each get a grouped bar chart per session (gaps, not zeros, for missing values). Events panel: a 45-day timeline with high-impact events taller and amber; news tone gets bars. Model inputs tiles: signed bars for the return-type inputs. Summary tiles: hit rate with the baseline tick. Daily log: a dot timeline (right / wrong / pending / not recorded) with counts computed from the rows. Post-mortem: realised-return bars with a right/wrong mark. Forward scoreboard: model-versus-base Brier pair bars and an interval on each hit rate. Ledger: probability bar and outcome chips.

## 30 Oct 2026: why Compute now looked stuck, and the forecast sentence
- **Cause (checked on the server):** nothing was stuck (`computing:false`, runs at 08:37:12 and 08:43:34 IST). Two automatic retrains ran back to back, each several minutes on the small server, because a series refresh landed after the first run had started and changed the input key; and the page showed "Computing…" on both horizons for either one (one shared flag).
- **Fix:** an automatic retrain now waits until the inputs have been unchanged for 120 s (`settle_seconds`; "Compute now" never waits), so a multi-series refresh trains once. The summary reports `computing_since`, `computing_scope` and `waiting_for_data`; each card shows Computing with a running clock only for the horizon being trained, the other says it is waiting, and a held-back retrain says why and shows the previous report.
- The line under the headline is written from the forecast: leading side (51.3 % "does not close above ₹22,937 on Fri 30 Oct" for a 48.7 % up forecast), the horizon and target date, the historical up-frequency and a coin-flip remark when within 5 points of 50 %.

## 30 Oct 2026: ML audit (prediction and intraday), logging and a forward check
**Checked on the server at 08:57 IST:** price history 2007-09-17 to 2026-10-29 (4,690 NIFTY bars), every overnight series fresh, no stale series. Today's 8 forecasts (4 models x T+1 and T+5, reference 29 Oct) were recorded in the append-only ledger at 08:35:04 IST (ids `...-20261030T030000Z`), outcomes pending; the scoreboard is empty because nothing has resolved yet (the 29 Oct forecast was missed, see earlier entries, and is not counted). First result: after the 30 Oct close and the 18:30 price refresh. Intraday: 1 labelled session (310 rows), research gate "insufficient", no intraday model exists or is claimed; the nightly dataset job runs 15:50 IST (after the 15:40 close) and has not run since the last restart.
**Data discipline (read in code):** only series with verified timing feed the models; point-in-time rules (`pit.py`); walk-forward with settings and calibration fitted on the tuning period only and verdicts on the untouched holdout; forecasts and ledger rows can never be changed (SQLite triggers + content hash); intraday features use samples at or before t and labels only later samples, rows written after the close and never updated.
**Gap found and fixed:** the prediction side wrote no structured log (only history, flows, news did). Now logged to the JSON log: `prediction_training_started/finished/failed` (trigger, scope, seconds, which models were recorded, why not), `forecast_recorded` (id, horizon, model, p_up, base), `forecast_settled` (outcome, whether the direction was right), `forecast_outcome_not_attached`, `forecast_day_logged`, and scheduler exceptions with a traceback (they were swallowed silently).
**New:** `/api/intraday/forward?expiry=` and a card on the Intraday page: the stored rules-based scores grouped bullish/neutral/bearish against NIFTY's next 15/30/60 minutes, a record until 20 sessions exist.

## 30 Oct 2026: strict audit (strategy builder, intraday analysis, prediction, connection diagnostics)
Full report: [audit-2026-10-30](audit-2026-10-30.md). Fixed: intraday IV/Greeks/expected move now count time from the market time of the prices (`market_time`, skipping weekends and calendar holidays) instead of an after-hours fetch, matching the Strategy builder; "rate 0.0 %" and fake 0.5/0 in the prediction post-mortem removed; "Exit all" flags stale prices; Diagnostics no longer says "No errors" when the list failed to load, shows the backend's provider, and has a panel with the server clock difference and each data job's own status; a wall-clock-dependent backend test made deterministic. Open items (conventions shared by two implementations, assumed cost and rate constants, provisional model constants, holidays in the browser, browser-only saved strategies) are listed in the report.

## 30 Oct 2026: spot mismatch and the live connection (found 09:31 IST)
- **Cause 1 (display):** the header read the newest snapshot of either expiry (polled every 15 s), the toolbar the selected expiry's chain and the command center the newest stored sample (both every 30 s). During the opening minutes the three showed different minutes (22,953.40 stored 09:17:05 against 22,963.20 stored 09:16:03). Also each expiry's capture reads the index separately about 0.7 s apart (22,979.50 monthly against 22,980.15 weekly at the same minute). Fix: header and toolbar default to the weekly expiry's snapshot, both show time and expiry, and the chain, history and command-center polls are 15 s.
- **Cause 2 (connection):** the browser WebSocket never opened (close 1006 from the deployed site), so no screen was ever "live". uvicorn's default `proxy_headers=True` replaces the client address with Caddy's X-Forwarded-For (the browser's real address); the app's loopback check (`/ws/market-data`, and every control endpoint: Compute now, Update now, start/stop stream, refreshes) then rejected every browser. Reproduced locally with the same uvicorn defaults. Fix: `proxy_headers=False` (`app/__main__.py::server_options`), test `test_proxy_trust.py`. Safe by design: the app binds to 127.0.0.1 only and Caddy requires a login first (`deploy/Caddyfile.template`). Consequence to know: anyone who has the Caddy login can use the control buttons; that is the design in the Caddyfile comment.

## Stop/target closed legs instantly; delete confirmations (4 Nov 2026)
- Cause: the automation ran on every keystroke. A half-typed level ("0" %, "3" on the way to "30", a premium "1" on the way to "150") sat at or on the wrong side of the entry, so a sold leg's stop was already "hit" by the live price and the leg closed.
- Fix: `hitOf` ignores a level at or on the wrong side of the entry premium (the UI already flags it); the page waits 1.5 s after the last target/stop edit before checking (`StrategyBuilder.tsx`, `lastExitEdit`). A valid level is compared with the live LTP as before (sold leg: stop when LTP >= stop, target when LTP <= target; mirrored for bought).
- Deleting one saved strategy or one closed trade now asks for confirmation (`window.confirm`); "Delete all" keeps its click-twice confirmation.
- Strategy test fixtures expire on 3 Nov 2026, so those tests now pin the clock to 2 Nov 2026 (they had started failing as the date passed).

## "Live" flips to "Streaming"; slow recovery on mobile resume (4 Nov 2026)
- Top bar shows "Live" only when the stream is fresh AND the browser's WebSocket is up. Any socket re-establishment (dead-link watchdog after 10 s of silence, server drop of a slow client with code 1013, proxy hiccup) produced "Stream: Streaming" (warning tone) until the next message. Backoff started at 1 s.
- On a phone, timers are frozen while the browser is in the background: on return the old socket was dead, the watchdog fired after up to 10 s, then backoff, so "Streaming"/"Stale" showed for some seconds.
- Fix (frontend only): first retry after 0.3 s; the socket reconnects at once on visibilitychange / pageshow / online / focus when it has been quiet >4 s; a link whose last backend message is under 8 s old still counts as up. The server's `hello` message resends the whole live book on every connect.
- Lot size: 65 (`cost_lot_size`, and the chain's `mktLot` from Kotak). 75 appears only in old test fixtures.
- Known gap: paper stop/target/re-entry/roll automation runs in the browser only (page open). Moving it to the backend is proposed, not built.

## Server-side stops/targets, expiry default, leg layout (5 Nov 2026)
- **Server-side automation** (`backend/app/strategy/automation.py`): the builder sends its running strategy (legs with their live-feed `key`, lot size, multiplier, auto on/off) to `PUT /api/strategies/running` after every change (0.6 s pause). A backend task checks it every second against `stream.book` prices while the stream is fresh, closes legs at their stop/target, and re-enters per the Re-entry box, with or without any browser open. Same rules as `applyAutomation` in the browser (levels at or on the wrong side of the entry never fire). No broker call.
- Concurrency: the document has a `rev`; a browser write with an old `base_rev` gets 409 (the server closed a leg meanwhile), the page then adopts the server's legs and says so. The page polls `GET /api/strategies/running` every 4 s and on return to the tab. If the server is unreachable the page falls back to checking levels itself while open. The running copy is not kept in the revision history (it changes constantly); exits are in each leg's log and in `serverEvents`.
- Not covered: manual Roll/Exit remain browser actions (they write the same document); the server never rolls. Paper only.
- **Old expiry**: the 3-day working copy restored `picked = 03 Nov` even after it expired and was no longer listed. Once the listed expiries are known, such a working strategy is set aside (copy in `localStorage` key `nse.builder.expired.v1`) and the builder starts on the latest weekly expiry with a note.
- **Leg layout**: each leg is now a card (position strip: leg, strike, lots, entry, LTP, P&L; second line: Δ·Θ, target, stop, actions; footer: exit / roll / re-entry). Two columns when the card is narrow, six when its own width is 840 px or more (container query), so it adapts to the builder sitting next to the chain. Column guide with glossary buttons stays above the cards.
- Tests: backend 576 + 8 new automation tests; frontend 358.

## Prediction gaps: cause and fix (4 Nov 2026)
- Symptom: from 3 Nov the daily forward-test log showed "Not recorded" with late series BRENT, DXY. A day is recorded only if all six overnight series (SPX, VIX, BRENT, DXY, USDINR, UST10Y) have a bar on/after the reference session; one late series skips the day (its number stays a preview, never counted).
- Most likely cause (inferred from code and log pattern, NOT verified against Yahoo from the build sandbox): after US DST ended on 1 Nov, Yahoo daily stamps for midnight-stamped futures/FX (BZ=F, DX-Y.NYB) arrive as 23:00 the evening before, so bars were dated one day early (weekend-dated) and BRENT/DXY looked permanently stale.
- Fix: `sources/yahoo.py` moves stamps at/after 12:00 to the next day. `history_store.repair_shifted_dates` repairs already-stored shifted bars only on exact-OHLC proof, via `bar_corrections` (or `bar_rejections` when no replacement); originals are never deleted. Tests: `TestShiftedDates`.
- Diagnostics: `/api/prediction/history/status` -> `weekend_dated_bars`; per-run `dates_repaired`, `latest_downloaded`.
- Not fixable retroactively: days already "Not recorded" stay so; the ledger is never edited.
- Verify after deploy: `weekend_dated_bars` falls to 0 after the next morning run and the next day is recorded. If not, `latest_downloaded` per symbol shows the real cause.

## Price tools: Price vs OI, MultiStrike, Multi-Straddle (4 Nov 2026)
- `Price vs OI` (Options Lab > Price tools) no longer shows the old OI-change table. It now has six linked charts for one strike (default: the newest sample's ATM, or any listed strike): call and put price, straddle + PCR, call price vs call OI, put price vs put OI, OI (call vs put), OI change (call vs put). One shared crosshair, session axis (open to close, IST), end-of-line value tags, PCR hidden until clicked in the legend.
- `MultiStrike Chart` (was planned) and new `Multi-Straddle Chart`: up to 6 strikes near the ATM; MultiStrike plots price, OI or OI change for calls and puts side by side. The five price tools are tabs of one family.
- New endpoint `GET /api/history/strike-series?expiry&strikes=atm|k1,k2,...&since` (`analytics/oi.py strike_series`): price, OI and OI change per strike and side from stored samples. Missing values stay null; a price of 0 is a gap; OI change = OI minus broker previous-day OI computed here.
- Frontend maths in `lib/optionTools.ts` (`strikeBoard`, `strikesAround`); chart builder `lib/priceCharts.ts`; boards in `components/dashboard/PriceBoards.tsx`. Only session samples are plotted (the sampler also stored a 23:31 IST sample; it is left out and counted in the footer).
- PCR on these charts is the strike's own put OI / call OI, labelled as such. Straddle = call + put price of the same strike, only where both were observed.
- Tests: backend `TestStrikeSeries`; frontend `strikeBoard` hand calculation in `option-tools.test.ts`, page tests in `price-boards.test.tsx`. Backend 583 and frontend 386 tests pass; ruff and tsc clean.
- Not verified: the pages against live stored data on the server (sandbox has none). The Analysis dashboard still has its own "Price and OI" table widget (unchanged).

## Vega Analysis time series and section tabs (5 Nov 2026)
- `Vega Analysis` is now a session time series: call vega, put vega and put minus call (hidden until clicked) with NIFTY on the right axis; timeframes 1/3/5/15 min (last stored sample in each window); Chart or Chart + Table (time, call, put, put − call); strikes ATM ±5/10/20, fixed per load. The by-strike bars stay below as "latest chain".
- Calculation `vegaSeries` in `lib/optionTools.ts`: per stored sample, forward from put-call parity, each contract's IV from its own last price (Black-76, 6 %), vega per vol point × OI summed per side over the fixed strikes; missing price/OI skipped and counted. Test uses an independent closed-form Black-76 written in the test.
- Data: `/api/history/strike-series` now accepts up to 45 strikes.
- `ToolTabs` (AppShell): every tool page, including Strategy Chart and Intraday Booster, shows its section's tools (same menu and heading) as tabs; planned tools are greyed with the reason.
- Not verified against live stored data on the server. 390 frontend tests pass; backend ruff clean (the backend change is a one-line cap).

## Vega Analysis uses the Greek (5 Nov 2026)
- Correction: the first time-series version summed vega x OI, which grows as OI builds and looked like a volume curve. Default is now the vega Greek itself (rupees of option price per volatility point, one unit of each contract, summed over the strikes of each side). "Vega × OI" (exposure of all open positions) is a switch. Test: Greek basis checked against a closed-form Black-76 vega, independent of OI.
- Put vega is shown positive and the difference is put minus call (the reference site shows put vega negative).

## Vega: why the reference numbers differ (5 Nov 2026)
- Our vega Greek is correct: an ATM contract at ~4.6 days to expiry has vega about 10.7 rupees per volatility point (hand calculation), so 21 strikes sum to about 190. By put-call parity a call and a put at one strike have the same vega, so the call and put sums stay close (187.8 vs 186.6 on 4 Nov).
- The reference page shows call 19 and put -33 starting from zero at the open and drifting apart: that cannot be a plain Greek sum. It behaves like vega weighted by OI added since the open. Its exact formula is not published; we do not claim ours matches it.
- Added the measure "Vega × OI change" (vega x OI added since the first session sample, starts at zero). Greek stays the default; "Vega × OI" is the exposure of all open positions.

## Vega Analysis: OTM-only option (5 Nov 2026)
- "OTM only" with N = 3/5/10: calls use the N out-of-the-money strikes above NIFTY, puts the N below it, re-chosen at every sample (ATM ±20 is fetched to cover moves). The two sides are then different contracts, so call and put vega differ. Test: spot 24,000, N=1 gives vega(24,100) for calls and vega(23,900) for puts.
- The per-contract vega table (price, IV, vega of every call and put) sits at the top of the page for checking.

## Vega Analysis rebuilt to the written spec (5 Nov 2026)
- Default measure is now "Δ Vega since open": the vega Greek summed over ATM ±4 strikes (calls and puts separately) minus its value at the first sample of the session, so both lines start at 0; difference = put change − call change. The other measures (vega level, vega × OI, vega × OI change, OTM only) remain as options.
- Strike window: Auto (re-centres on every sample's ATM) or Fixed (locked to the first sample's ATM); ATM ±4 / ±10 / ±20. ATM ±20 is fetched once and the window is cut from it.
- Chart: "Synth Future" (forward from put-call parity of that sample's chain) on the left axis; call vega (green) and put vega (red) as areas around a zero line on the right axis; Put − Call (purple) hidden until clicked. Table: day-high difference solid green, day-low solid red, other rows tinted by rise or fall from the row before.
- Not taken from the spec: the 6.5 % rate (we use 6 %), the Black-Scholes form (we use Black-76 on the parity forward), and the lot-size factor in the by-strike Cr exposure (OI is already in units; our latest-chain totals 61.77 / 43.36 Cr already match the reference without it). Not built: Live/Historical switch (no historical-day endpoint yet).

## Vega Analysis aligned to the second spec (5 Nov 2026)
- "OTM only" now works inside the ATM ±N band (N = 4/10/20) with Auto/Fixed: calls above NIFTY, puts below it. Replaces the earlier "N nearest OTM strikes" option.
- "Vega × OI change" is now the OI-weighted vega total minus its value at the first session sample (spec formula), replacing vega × (OI added). Time-series Vega × OI values are shown in Cr (value / 1e7); OI is already in units so no lot-size factor is applied (our by-strike totals already match the reference).
- Table: day-high/day-low (solid) and rise/fall tints now apply to the Call, Put and Put − Call columns. Put − Call line is dotted purple.

## Menu: Timeseries and Strategy Chart removed (5 Nov 2026)
- Options Lab no longer lists Timeseries or Strategy Chart (Strategy Chart was only a link to Strategy Builder; Strategy Builder keeps its own menu). The OI-by-strike-over-time widgets still exist on the Analysis dashboard. The section tabs no longer show them.

## Vega: what StockMojo's 15.48 / -41.68 are (5 Nov 2026)
- Their figures are "level now − level at the first sample": 187.78 = 172.30 (base call) + 15.48 and 186.59 = 228.27 (base put) − 41.68. Our Vega-level lines on 4 Nov 15:39 showed exactly 187.78 and 186.59 (ATM ±10, 21 strikes), so the Greek sums are the same; only the reference level can differ. The bases 172.30 / 228.27 come from a spec supplied by the user, not from data we hold.
- Our earlier "level" lines started near 110 and ramped to ~190 in the first minutes: strikes without a price in the first samples contribute nothing, so the change looked like a build-up. The reference is now the first sample in which every strike that contributes at any time of the day is priced; earlier samples are not plotted, and the page prints the reference time, its values and its strike coverage (so it can be compared with their 172.30 / 228.27).
- Defaults now ATM ±10, Fixed (as on their screen). Not verified against stored data on the server.

## Vega Analysis: chart only, both lines start at 0 (5 Nov 2026)
- The page is now the StockMojo-style chart plus the candle table; the per-contract table, by-strike panel and base banner are removed.
- Change measures (Δ Vega since open, Vega × OI change) measure each strike from its OWN first value of the session, counting only strikes with a value now and at their first sample. Both lines start at 0 at the open; strikes priced late add nothing when they first appear, so the earlier artificial ramp is gone.
- Equals "sum now − sum at the open" whenever all strikes were priced at the open. Comparison with StockMojo's 172.30 / 228.27 openings is still unverified against server data.
- Tests: tsc clean, vitest 427 passed (rewritten the reference test to per-strike semantics). Backend untouched.

## Strategy-level stop loss / target / lock & trail, and percentage trailing stop per leg (5 Nov 2026)
- **Strategy rules** (Positions tab, "Strategy stop loss, target and lock & trail"), rupees on the whole strategy's P&L (booked + open): stop loss (exit at −₹X), target (+₹X), **lock** (when profit reaches A, never give back more than to B) and **trail** (for every further ₹C of profit raise the floor by ₹D, D ≤ C). A rule that fires closes every open leg at its live price with reason "strategy"; no leg re-enters afterwards (pending re-entries are cancelled) and the rule does not fire twice until **Re-arm**. Paper only, no broker call.
- **Percentage trail per leg** (leg footer, "Trail stop: every X % move stop Y %", needs a stop): every full X % of the ENTRY premium the leg moves in your favour moves the stop Y % of the entry premium the same way, from the stop you typed. The stop only tightens, so no peak needs storing. A trailed stop may sit on the profit side of the entry (locks profit); a typed one still may not. Typing a new stop clears the trail. Re-entry/roll keep the stop distance you originally set (`stopBase`), not the trailed one.
- Worked example (sold 100, stop 130, X=10, Y=5): price 90 → stop 125; 80 → 120; 30 (seven steps) → 95.
- Same rules in `frontend/src/lib/strategy.ts` (`trailLeg`, `applyStrategyRules`, `lockFloor`, `rulesProblem`) and `backend/app/strategy/automation.py` (`trail_leg`, `apply_strategy_rules`, `lock_floor`, `rules_problem`); the server checks them every second with the leg stops. The profit floor and which rule fired are stored in the running document (`rstate`); the server owns it: a browser edit keeps it unless it sends a new `rearmAt`. Floor changes bump `rev`, like an exit.
- Safety: rule boxes commit on blur/Enter (a half-typed "2" on the way to "2000" arms nothing). An impossible lock (locked profit ≥ trigger, trail step bigger than the profit step, half a setting) is flagged in red and ignored, never half-applied.
- Limits: rules belong to the working strategy (browser copy + server running document); they are NOT saved with a named saved strategy yet. The trail starts at the first full step (no separate start threshold). Not exercised on live prices yet (market was closed).
- Tests: backend 678 passed (new hand-calculated trail, lock floor, SL/target, service tests; one unrelated swing-service test failed once in a full run and passed on rerun and alone), frontend 437 passed, ruff and tsc clean.

## Futures charts audit and fixes (5 Nov 2026)
- **Why "OI" and "OI change" looked identical:** by definition OI change = OI − one fixed baseline, so the curves differ only by a constant. The OI change widget now draws **OI added (green) / removed (red) per minute** (`oi_per_min`, change since the previous recorded OI) and shows the change since the baseline as a corner number.
- **Baseline honesty:** the baseline is the last stored OI of this contract on an earlier day within 12 days, not necessarily the previous session. `oi_baseline.sessions_ago` (weekdays between) is returned and a warning appears when it is more than 1 ("OI change spans several sessions").
- **Data-quality warnings:** one-minute OI moves above 1 % of OI are counted and flagged as a possible feed artefact (the chart showed a sawtooth of 3–8 lakh drops that real futures OI does not do; cause NOT established, needs the server's stored `fut` samples and the exchange's end-of-day OI to compare); samples stamped later than the server clock are flagged (the audited screenshot showed 9 Nov 2026 while the clocks said 5 Nov).
- OI axis now reads in crore with three decimals (1.375 Cr) so neighbouring ticks no longer repeat.
- To do when the market opens: look at the OI chart live for the sawtooth; compare the last OI of the day with NSE's F&O bhavcopy for the same contract; check the server clock.

## 2026-11-05 Prediction audit (partial, uncommitted)
- Found: model features reuse the last bar of a global series for up to 5 days (`Series.idx`), so a late DXY/Brent bar shows an older day's move without any warning.
- Changed: the report now carries `data.input_dates` (bar date each input comes from, schema 6) and the Model inputs panel lists any series older than the reference session.
- Server check 5 Nov (read-only): 3 Nov preview only, 4 Nov no run, 5 Nov DXY not final in time; fixed by D67 (provisional, flagged overnight bars; not verified in a live morning yet). Earlier open point: the Yahoo `hour >= 12` date shift. Check the server's `prediction_daylog.sqlite3` and `history_service` fetch runs.

## Future Lab: flow and sectors; CVD / book-imbalance audit (2026-11-05, D68)
- "Futures flow and top-5 heavyweights" and "Sectors" moved from the Intraday Booster to Future Lab tools (`future-flow`, `future-sectors`).
- Audit results and fixes (coverage of day volume, freshness/stale flag, 60 s limit on the book imbalance, futures note after restart) are in D68. Verified live only for the first minutes after the 09:15 open on 5 Nov; CVD cannot be validated against a real trade tape.
- Options Lab / Future Lab: IV - HV, IV - Intraday and Future Price vs OI are now ready tools (D69). Tested with hand calculations, the real captured chain and mocked pages; HV verified on the server's real closes. The intraday IV series and the buildup page have not yet been seen with live market-hours data.
- Smart OI price candles (D70): one-minute NIFTY index bars are now recorded from the live feed and used for the candles (real wicks, no gap to the next candle); days before 5 Nov keep the sampled candles. Tested with a scripted feed and hand-calculated candles; not yet seen over a full live session.
- Swing audit (D71): live checks only for orders meant for today's session, volume not judged before 09:45, clearer volume wording, backtest report bundled with the release. The paper book is one session behind (last processed 3 Nov); tonight's 17:00 IST run replays 4 and 5 Nov in order. Live "would buy" events from 5 Nov (stale queue) are not evidence for the book. Still to verify after tonight's run: the catch-up result.
- "Total OI — calls vs puts" and "Total OI change — calls vs puts" moved from the Analysis page to the Options Lab Open Interest tool (`LAB_ONLY_WIDGETS`); saved Analysis layouts drop them, nothing else changed.
- Swing data holes (D72): a missing bar for a held or queued stock is read from NSE's bhavcopy or the pass waits; it is never recorded as a skipped decision. Expected tonight on the real 4 Nov bars (not yet run): KRISHANA and ARIS enter, the other five orders are skipped for the reasons in D72.
- Mobile / PWA / light theme (D73): content-height widgets with fixed chart heights, compact phone header, install files exempt from the login (D73; applied on the server with `deploy/apply-caddyfile.sh`), theme-aware Vega colours and a firmer light palette. Checked in a browser at 390 px (with a raised font size) and 1366 px, dark and light, with test fixtures; not yet on the phone itself.
- Price boards (Price vs OI, Multi Strike, Multi-Straddle, Vega): Session selector and Timeline (Fit / Full day / 2 h / 1 h / 30 min), fitted to the data by default (D74).
- Swing page: single scrollbar (D76); entries, exits, decisions and orders show their day, when the job booked it and, where the live feed saw it, the exact time. Entry/exit minutes are unknown for the first two paper trades (before the live layer ran with a current queue).
- Vega Analysis rebuilt (D77): level view with replay, six cards (percentile and regime need 100 samples over two sessions, so they read "not enough stored history" until the server has stored more sessions), and the vega change of the anchored band with table, statistics and insights. Not yet compared against live market data on the server.
- Gamma Exposure rebuilt (D78): cards, regime, walls, peak, flip (by re-pricing), density, session structure, strike table. Tested on Black-76-generated prices with hand-derived checks; not yet compared with live data on the server. The old "Gamma exposure by strike" widget remains in the Analysis widget list.
- IV tools (D79): IV Grid removed; new IV / HV / IVP Chart (India VIX vs HV with IVR/IVP) and daily IV − HV bars on the IV − HV page. Backend 710 and frontend tests pass (strategy tests time out only under full-suite load). IV − Intraday now multi-expiry with session, candle and term views; Volatility Skew rebuilt with cards, Smile, Term and Table (D79). Not checked by eye in the browser or on the server.
- Future Lab (D80): Future Heatmap and Future Sentiment Cycle removed from the menu; Future Price vs OI now has 1/3/5/15-minute windows, buildup counts, a bullish/bearish window bar, a price/OI chart with toggles and a newest-first table. Not checked by eye in the browser.
- Audit fixes (D81): evening daily-history run, chart date axes and range, skew term view after midnight, one frontend rate constant. 5 Nov daily bar still to arrive (next history run).

- Server Management Centre (D89): built and tested in development on branch `wip/server-management` (backend module, helper script and units, 14-tab page, tests, [server-management](server-management.md)). **Not merged, not deployed, not verified on the server.** Merging to main deploys it; the restart helper needs the one-time setup in the document.
