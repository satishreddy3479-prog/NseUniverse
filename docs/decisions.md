# Decisions
Status: **Final** or **Proposed**. Date 2026-10-28 unless noted.

1. **GitHub is the shared source of truth.** Reason: laptop and Codespaces must share work. Consequence: all state lives in Git, not sessions. — Final (stated by user)
2. **Windows 11 and Codespaces are development environments; production is a separate Linux server.** Consequence: no assumption of shared files/env; deploys separate. — Final
3. **Phase 1 begins with Kotak Neo market-data integration.** — Final
4. **NIFTY 50 is the initial underlying; initial expiries are weekly and current-monthly.** — Final
5. **Web dashboard is a core product requirement.** — Final
6. **Backend manages broker credentials and connectivity; frontend consumes normalized backend data.** Reason: keep secrets out of browser. — Final
7. **Advanced analytics deferred until reliable data collection is established.** — Final
8. **Backend Python, frontend React + TypeScript.** Reason: stated in brief (Python/TypeScript standards). Framework (e.g. FastAPI, Vite) not chosen. — Proposed
9. **Intended layout `backend/ frontend/ tests/ docs/`.** — Proposed
10. **Claude Code settings:** no `.claude/settings.json`, no subagents or MCP servers added. Reason: not needed yet. — Proposed
11. **Server-first architecture: GitHub stores source; the Linux server runs production and pulls approved commits to deploy automatically.** Reason: server is the real runtime; pull model avoids exposing the server to CI. Consequences: server needs a deploy agent, rollback, read-only deploy key; production config/secrets stay on the server. — Proposed (user-stated direction; details unconfirmed)
12. **"Approved commit" = reviewed merge to `main` or an owner-created release tag.** — Proposed
13. **Build locally first; GitHub is touched only after the local build is done, then push.** Reason: user's sequencing choice. Consequences: no remote/push/Codespaces work until the user says so; the Codespaces and server-deploy parts of the workflow stay documented but dormant. — Final (stated by user, 2026-10-28)
14. **Kotak Neo SDK: `kotakneoapi` (repo Kotak-Neo/kotak-neo-python), v3.0.x, Python ≥3.10; SFeed via `create_websocket()`.** `kotak-neo-api-v2` is retired. — Final (verified from SDK source v3.0.13, 2026-10-28)
15. **TOTP: the TOTP secret is stored in the backend `.env` and codes are generated with pyotp for automatic re-login.** Consequence: whoever has the `.env` can log in; `.env` must never leave the machine/server, is git-ignored, and is never logged. — Final (user choice, 2026-10-28)
16. **Monthly expiry roll: when the current calendar month has no remaining listed expiry, use next month's last listed expiry, labelled "next month".** — Final (user choice)
17. **Storage: snapshots as JSON (+CSV export), live ticks as JSONL per session; a stdlib SQLite file indexes sessions/snapshots only.** No DB server, no extra dependency. — Final (user choice)
18. **Snapshots come from `option_chain()` (which also provides contract tokens); the scrip master is not needed for Phase 1 discovery.** — Proposed
19. **Stack: FastAPI + pydantic-settings backend; React + TS + Vite + Tailwind, Radix primitives, TanStack Table/Virtual/Query, Zustand, Apache ECharts frontend.** — Final (approved plan)
20. **Dependencies are installed per machine (Windows laptop, later server); never copied between OSes.** — Final
21. **Verified live `option_chain()` shape (2026-10-28, nse_fo NIFTY) differs from the SDK docs; parser accepts both.** Observed: `inst{neoSymbol,symbol,optType,strkPrc,exp,moneyness(lowercase itm/atm/otm)}`, `quote{ltp,o,h,l,c,pc,vol}`, `oi{cur,prev,chg,chgPct}`, plus `spot{ltp,prevClose}`, `common_data{mktLot,...}`; 81 strikes per side for count=40 (±40 around ATM, step 50). Values are strings. — Final (observed)
22. **Kotak's `oi.chg`/`oi.chgPct` are NOT open-interest change** (they equal LTP − previous close and its %, in 158 of 162 contracts). OI change is computed as `cur − prev` (percentage only when `prev > 0`); the source fields are never used. Also `quote.c` equals `quote.pc` for every contract and `future.prevClose` is implausible; neither is used for display. — Final (observed; re-verify if Kotak changes the API)
23. **Underlying price comes from the chain response's `spot` block and is shown only as a labelled snapshot value ("not live").** — Final
24. **One broker feed, many browsers:** a single `StreamManager` owns the one Kotak SFeed connection; browsers receive batched, normalized updates from `/ws/market-data` (250 ms coalescing, bounded per-client queues, client limit). The browser never connects to Kotak. — Final
25. **Stream start sequence:** connect, subscribe market status (`subscribe_exchange`), small test subscription (index + ATM CE/PE), wait for first data (10 s), then the full universe (weekly + monthly chains, deduplicated, index included) in chunks of 200. No data during the test is reported (`no_data`) and does not block. SDK's 3000-token limit applies (~325 used). — Final
26. **Reconnect policy:** the SDK reconnects by itself (5 attempts); when it gives up, our supervisor retries with exponential backoff 2 s, 4 s, ... capped at 60 s, at most 8 attempts (a session that lived 60 s resets the budget), then state FAILED until a manual start. Auth failure triggers one re-login. Start is idempotent (never a second ingestion process). — Final
27. **Connection state, subscription, message flow and freshness are separate:** states stopped/connecting/subscribing/waiting_for_data/streaming/reconnecting/auth_failed/failed; freshness fresh/stale/market_closed/none derived from the age of the last market-data message (default stale after 30 s). A connected socket never implies fresh data. — Final
28. **Market status comes only from the exchange feed** (`SFeedMarketStatus`: open codes 1 and 4, closed code 2; others shown as "other"). Trading hours and holidays are never assumed; status resets to Unknown when the stream stops. — Final
29. **Stream values: wire prices of 0 become missing; volume and OI keep 0.** Exchange timestamps are NOT derived: `last_trade_time`/`last_update_time` are carried as raw provider integers (unit and epoch unverified, audit F5). Exact repeats are dropped and counted as duplicates. — Final
30. **UI overlay rule (superseded in part by #33):** live values overlay the snapshot rows, matched by instrument token with row-level subscriptions; stale streams dim the live cells.
31. **Snapshot lookup prefers the newest non-empty snapshot** so a failed-parse (empty) snapshot cannot hide a good one (audit F3). — Final
32. **No mock or demo mode.** The application uses only real Kotak Neo data. Backend credentials are always required (the backend will not start without them). Automated tests replay real captured Kotak responses from `backend/tests/fixtures` (credential-free), never invented numbers. Old demo rows already in `data/index.sqlite3` are hidden, not deleted. — Final (user instruction, 2026-10-28)
33. **Snapshot is the base, the stream updates it.** On start the backend makes sure the weekly and monthly snapshots are current (fetches new ones if older than 5 minutes), subscribes their instruments, and every value that can follow the stream does: LTP, volume, OI, OI change (streamed OI minus snapshot previous-day OI), totals, the ATM strike (nearest strike to the live NIFTY price) and the spot. A streamed OI of 0 never replaces a positive snapshot OI (unverified semantics). With the market closed, everything shows the real snapshot, labelled as the last session. — Final
34. **Streaming starts automatically with the backend** (`STREAM_AUTOSTART=true` by default); Stop/Start buttons remain. One login is shared (`ensure_login`) so startup never double-signs-in. — Final

## Open questions
- Python and Node versions on the Windows laptop and production server.
- Meaning of SFeed `last_trade_time` / `last_update_time` (epoch units, exchange vs server time): `scripts\stream-check.ps1` prints each raw value interpreted as Unix seconds and as seconds since 1980-01-01 so the right reading can be identified during market hours.
- Whether streamed `open_interest` is populated for options and matches the snapshot's OI; whether zero means 'none yet'.
- What the index feed (`SFeedIndex`) sends for the subscribed name `Nifty 50` (key and `close_price` semantics).
- Whether the first messages after subscribe arrive when the market is closed.
- Whether `quote.c` (equal to prev close during/after session) becomes a distinct settlement price later; whether `oi.prev` is the previous trading day's OI.
- Backend/frontend frameworks, package managers, formatter/linter choices.
- Storage technology for snapshots/history.
- Kotak Neo SDK version, auth flow (incl. TOTP), rate limits, streaming limits.
- Hosting details of the production server (OS, resources, process manager such as systemd/Docker).
- Exact approval rule for auto-deploy (main merge vs tag; required CI checks; signed commits?).
- Where builds happen (on server vs elsewhere) given low resources; polling interval; rollback/health-check definition.
- Notification channel for deploy success/failure.
- The local folder was empty and not a Git repo at initialization; GitHub remote to be confirmed.

## D35 — Analysis dashboard from stored snapshots (2026-10-28)
- Widget dashboard at `/analysis` (react-grid-layout v2 + tree-shaken ECharts, lazy-loaded). One `DashProvider` merges snapshot rows with live ticks (throttled 400 ms), applies expiry/strike-range/CE-PE filters; every widget reads that one state so charts, table and key levels agree.
- Time series use only real stored snapshots via `GET /api/history/observations` (universe ATM ± N; premium = sum of LTP; straddle; totals). No candles, no interpolation; <2 snapshots → empty state; all-identical → flat-line note (captured while market closed).
- OI change = current − previous-day OI computed locally (Kotak `oi.chg` is price change). OI/volume are units, lot size shown in Key levels.
- Max pain: candidate settlements are listed strikes; strikes with missing OI excluded and counted.

## D36 — Scheduled market-hours sampling (2026-10-28)
- `SnapshotSampler` (backend, background task) captures the weekly + monthly chains every `SAMPLER_INTERVAL_SECONDS` (default 60, min 30) while the NSE session is on: Mon–Fri 09:15–15:30 IST. Same read-only REST path as "Refresh snapshot"; no orders.
- Exchange-feed "closed" received today blocks sampling (weekday holidays); a "closed" from an earlier day is ignored so it cannot block the morning. Failures back off (interval ×2 up to 5 min) and are shown on the Analysis page; the loop never dies.
- Nothing is sampled outside the session, so history never fills with repeats of closing values. Status: `GET /api/sampler/status`. Cost: see D37 (the original ~40 MB/day estimate was wrong; measured 86 MB/day uncompressed).
- History observations are cached per immutable snapshot id (limit now up to 2000).

## D37 — Compressed snapshots, repeat-skipping, disk guard (2026-10-28)
- Audit measured 230 KB per capture (both expiries; normalized + raw files) = ~86 MB/day at 60 s, about twice the earlier estimate. Now snapshots are written gzip (`.json.gz`, `.raw.json.gz`): ~36 KB per capture, ~13 MB/day. Older plain `.json` files are still read; nothing existing was rewritten or deleted.
- The scheduled sampler skips a chain whose spot, prices, OI and volume equal the last stored one for that expiry (holidays, stream down, after close). Manual "Refresh snapshot" always stores.
- Sampling pauses when free disk is under `SAMPLER_MIN_FREE_GB` (default 2). No automatic deletion; retention/compaction remains a user-approved task.
- Open: control endpoints trust any loopback client; add authentication before any reverse-proxy deployment.

## D38 — Checkpoint 1 audit fixes: market status per segment, "live" only when fresh (2026-10-28)
- Evidence (PC logs 2026-10-28): stream connected, 325 tokens subscribed and 325 acknowledged, test subscription received data; each connect also delivered ten market-status messages with codes 1 (open) and 2 (closed) interleaved. The manager kept only the last message, so the market state depended on arrival order and could show "open", making a quiet feed read as "stale".
- Fix: status is kept per exchange segment (`market_segments`); the market state is NSE F&O, else NSE cash, else unknown. Other exchanges are never borrowed. The segment is now logged. Which segment names Kotak sends is unverified until market hours (`scripts\stream-check.ps1`).
- Fix: the spot price (header, Analysis toolbar, Key levels) is called live only when the stream's effective state is "streaming" (fresh data), not merely connected. Stale, market-closed or waiting streams fall back to the labelled snapshot.
- Stored snapshots are real Kotak data. The four identical ones were all captured after the 15:30 close (spot 22,698.85 each time), so identical values are expected, not a storage bug. Two earlier demo snapshots and two empty (parser-bug) ones remain hidden.
- Open: `oi.prev` is treated as previous-day OI but that is unverified; `exchange_timestamp` is null in every stored snapshot, so history timestamps are local receipt times; sessions are never marked ended when the app is killed.

## D39 — Observation store and OI intelligence (Checkpoints 2-3, 2026-10-28)
- `data/observations.sqlite3` (WAL, one writer) keeps compact observations across restarts: `samples` (one per chain fetch: received time, provider time if any, spot, previous close, lot, source, content fingerprint), `contracts` (only when values changed: LTP in paise, OI, broker previous-day OI, volume; NULL = missing, never 0) and `events` (app start/stop, stream state changes, subscription acknowledgements, per-segment market status, sampler failures). A fetch identical to the previous one is stored as an 'unchanged' sample with no contract rows, so replay can tell "no change" from "no data". Existing stored snapshots are imported once at start-up (idempotent, real data only). Nothing is deleted automatically; size is visible at `GET /api/observations/status`. Estimated ~3-4 MB/day at 60 s (to be measured in market hours).
- Not recorded yet, because the verified data model does not carry them: bid/ask, quote quantities, IV, provider timestamps (`exchange_timestamp` is empty in every stored snapshot), stream-tick observations. These need the live feed to be inspected first.
- OI change is always "now minus an explicit baseline", chosen by the user: previous distinct observation, a selected IST time, session open, previous session (our own stored data), or the broker's previous-day field (meaning unverified). Never extrapolated; a missing baseline gives "Insufficient data", a zero baseline gives no percentage.
- Labels are neutral: OI increased / decreased / unchanged / insufficient data; price-and-OI shows only "OI up, premium down"-style observations. No buildup/writing/bullish/bearish language, and the highest-OI strike is never called support or resistance. Heatmap colours are neutral (blue above baseline, amber below).
- Endpoints: `GET /api/oi/change`, `GET /api/oi/heatmap`, `GET /api/observations/status`. Widgets (Add widget menu): Intraday OI change, OI change heatmap, OI concentration, Price and OI.
- Verified: hand-calculated unit tests for every baseline, concentration, heatmap, missing/zero baselines; real captured chain through the API. Unverified until market hours: that OI really changes between fetches, and the meaning of the broker's previous-day OI field.

## D40 — Collapsible side menu and a minimal top bar (2026-10-28)
- Side menu is a 56 px rail that opens over the page (never pushing it) on hover, touch or keyboard focus, and closes after a choice. "Keep menu open" pins it beside the page (remembered in this browser). The page keeps its full width. Mobile keeps the Menu button.
- Top bar keeps the product name, the NIFTY level and one status pill (problems first, then warnings, then Live / stored-data state). The signal list, selected expiries, last snapshot time, Refresh and theme moved to Settings (System status, Theme). The pill opens Settings.

## D41 — Refresh-only development workflow (2026-10-28)
- One start file, `NSE Universe.cmd`: starts the app if it is not running, otherwise only opens the browser. The separate Start/Stop files are gone (`scripts\stop.ps1` remains for a full shutdown).
- Backend runs with `APP_RELOAD=1` (uvicorn reload on `backend\app` changes, 1.5 s delay); every restart signs in to Kotak again. Frontend is the Vite dev server (hot updates). `scripts\watch.ps1` installs packages when `requirements*.txt` or `package-lock.json` change and nudges the backend to reload.
- Offline checks no longer run on every start (use `scripts\check.ps1` or `launch.ps1 -Checks`). An instance started by the old launcher is replaced once, automatically.
- Untested here: the PowerShell scripts could not be run in the Linux workspace; the backend reload itself was tested (a touched file restarted the app and it answered).

## D42 — Prediction Intelligence: Milestones 1-2 (2026-10-28)
- Two separate forecasters (T+1, T+5) for NIFTY 50; research only, never trades. Specifications in `docs/prediction/` (10 documents). Code in `backend/app/prediction/`: NSE trading calendar (2026 holidays read from NSE circulars CMTR/71775 and CMTR/72260; other years refused), label formulas, point-in-time guard (unknown publication time = unavailable), immutable per-horizon forecast ledger (SQLite triggers + content hash; outcomes attachable only after the target session closes), purged walk-forward splits and metrics.
- Not built: any data adapter, feature pipeline, model, dashboard workspace. No NIFTY price history exists in the project; a source needs the user's approval (docs/prediction/overview.md, decisions 1-6).
- Reasoning on sources: NSE terms ban systematic automated collection; Reuters has no public feed; Moneycontrol has no official feed; ET RSS terms unverified; GDELT terms are open. Option-chain features are prospective (history from 2026-10-28).

## D43 — Prediction decisions and the price-history downloader (2026-10-28)
- User decisions: cutoff 08:30 IST next morning; price history from Yahoo via yfinance (unofficial, personal use); news from official announcements + GDELT + Economic Times RSS (ET terms unverified, headline/link/time only); building later (Milestone 8).
- Built: `HistoryStore` (immutable first-seen bars, `bar_changes` log, run log), Yahoo adapter with a symbol registry (only NIFTY 50's close time is marked verified; everything else is stored but not usable as a feature until checked), `HistoryService` (automatic first download and a daily run after 18:30 IST, per-symbol failure isolation, 1 h retry, 1 request/s), API `GET /api/prediction/history/status` and `POST /api/prediction/history/refresh` (local only), Settings panel "Prediction data". `yfinance` is in `requirements-research.txt` (PC/Codespaces only, not on the server).
- Not testable from Claude's workspace: neither it nor its PC link can reach Yahoo, so the first real download happens on the user's PC; failures show in Settings and logs.
- Verified on the live feed: Kotak segment names (nse_cm, nse_fo, ...), confirming the per-segment market-status fix (D38).

## D44 — Milestone 3 audit: price history accepted for research, baselines recorded (2026-10-28)
- NIFTY 50 history (4,689 bars from 2007-09-17) matches the NSE-circular 2026 calendar exactly; invalid vendor bars are skipped, never repaired.
- Naive baselines (climatology, always-up, previous-direction) are barely better than a coin on Brier/log loss; models must beat them in the same purged walk-forward folds. Results in `docs/prediction/data-audit-m3.md`, reproducible with `research/m3_audit.py`.
- The 63.8% positive opening-gap share is unverified against official NSE opens; no gap model is trusted until checked.
- Non-NIFTY series stay unusable as features until close times are verified (`timing_verified`).

## D45 — First model and Prediction page (2026-10-28)
- `logit-tech` v1: ridge logistic regression on 13 price-only NIFTY 50 features (`tech-v1`), T+1 and T+5 direction, evaluated by purged expanding walk-forward against the training up-frequency. "Better" requires a 95% block-bootstrap interval of the paired Brier gain to exclude zero.
- Result on real data (2012-2026, 3,500 predictions per horizon): no detectable edge for either horizon (T+1 gain +0.0007, interval -0.0006..+0.0021; T+5 gain -0.0007, interval -0.0021..+0.0006). The page states this verdict rather than hiding it.
- Forecasts are recorded in the immutable ledger with cutoff = reference session close (15:30 IST) because only price data through that close is used; outcomes attach automatically after the target close.
- Next: add India VIX and verified global/overnight inputs, then test whether they change the verdict.

## D46 — Model comparison protocol and UI theme (2026-10-28)
- Candidates: logit-tech, logit-small (5 a-priori features), boost-tech (depth-1/2 boosted trees), ensemble (mean of tuned logit-tech and boost-tech). Hyper-parameters are tuned ONLY on the earlier half of the purged walk-forward folds (2012-01 to 2019-03); every verdict comes from the untouched later half (2019-03 to 2026-04). The headline model is the best on tuning, not on holdout.
- Verdicts: "better" requires the Bonferroni-adjusted (8 comparisons) block-bootstrap interval of the Brier gain to exclude zero; "promising" passes only the plain 95% test; otherwise "no edge shown" / "worse". Results (holdout): T+1 boost-tech gain +0.0017 (95% +0.0001..+0.0035) = promising, unconfirmed; every other model/horizon shows no edge or is worse (T+5 logit-tech and ensemble worse than the base rate).
- The ledger records every model's forecast, so the forward test decides whether "promising" is real.
- Results compute in a background thread and are cached in data/prediction_report.json (keyed by last session, model and feature version).
- UI: new vibrant theme (violet/cyan accent, glass panels, gradient headings, SVG nav icons) via design tokens in index.css; dark default, light kept.

## D47 — Separate overnight (T+1) and broad (T+5) models, calibration, calls (2026-10-28)
- Timing rule: every outside series is used only through "the last bar dated on or before the reference session", complete by 08:30 IST next morning. Verified on real history (research/timing_audit.py): US bars dated t correlate +0.38 with NIFTY's next opening gap, bars dated t+1 only +0.10. All series now `timing_verified`.
- T+1 (t1-v1): NIFTY last session, India VIX, US/Europe/Asia closes, Brent, gold, DXY, USD/INR, US 10y. T+5 (t5-v1): adds trend/vol context, 8 sector relative strengths and breadth, global 5-20 day trends. T+5+flows: adds NSE participant positions, evaluated on its own history once >= 1,500 sessions exist.
- Protocol: earlier half of purged walk-forward folds tunes hyper-parameters and fits a Platt calibration; later half is an untouched holdout; verdicts use a Bonferroni-adjusted bootstrap. "Calls" (all base models agree and the ensemble is in the top quarter of tuning-period strength) are scored separately; otherwise "no call".
- Result on real data (holdout 2018-09 to 2025-12, 1,750 predictions): T+1 all four models beat the base rate (Brier gain +0.013 to +0.015, strict test passed, hit rate 60-61%); confident calls (41% of days) right 67.7% vs 52.9% always-up. Leakage sanity: delaying the overnight data by one day removes the edge. T+5 broad: no detectable edge (ensemble worse).
- Recording: forecasts are recorded only 08:35-09:10 IST on the target day, after the overnight data is complete (US session complete after 03:00 IST); otherwise the page shows a preview. History refresh also runs at 07:30 IST.

## D48 — Server-first deployment kit (2026-10-28)
- `deploy/` holds a repeatable bootstrap and a pull-based updater: a timer checks GitHub every minute (`git ls-remote`), builds a new release next to the running one, checks `/api/health`, switches the `current` symlink, and rolls back by itself on failure. Production does not depend on GitHub Actions.
- Public exposure requires authentication (CLAUDE.md rule): Caddy HTTPS with a mandatory login in front of everything; the backend listens on 127.0.0.1:8010 only; ALLOWED_ORIGINS is the public origin.
- Resource and data rules: 1 GB swap file, systemd memory limits, journald cap, nightly integrity-checked SQLite backups, disk monitor (70/80/90 %), no automatic deletion of market data; deploys never touch the data directory.
- Existing services on the VPS (an earlier nse-tradingdesk) are left untouched; the script refuses to continue if ports 80/443/8010 are taken.
- Not done by me: logging in to the VPS, DuckDNS registration, filling broker credentials (they stay on the server). I could not verify the kit on the real server; it is tested here for the update/rollback logic and backend startup only.

## D49 — Events and news inputs (2026-10-29)
- Scheduled events (`backend/app/prediction/reference/events.json`): FOMC 2026-27 (federalreserve.gov calendar), RBI MPC 2026-27 (RBI press release 2025-2026/2306), US election day, India CPI (MoSPI). Each has a source; release clock times that the source does not state are marked unconfirmed.
- Events are shown as event risk beside each forecast. For T+1 only, a directional call is withheld when a high-impact event falls between the reference close and the target close. This is a precaution; there are too few past occurrences to validate it. T+5 lists events but is not withheld.
- News: GDELT DOC API daily tone and coverage share for five themes, collected twice a day and stored append-only (`news.sqlite3`). GDELT serves daily series for only the last three months, so there is no multi-year history: the series builds forward and is NOT a model input yet. Economic Times RSS (terms unverified) and NSE announcements (automated access refused) are not used.

## D50 — US data calendar, FII/DII cash window (2026-10-29)
- Trading Economics is not used: its terms could not be read and its calendar/API is an account/paid product. The US 3-star releases come from the official BLS schedule (CPI and jobs report, 2026-27); FOMC from the Fed; RBI from RBI. Event times the source does not name a zone for are marked unconfirmed.
- Events remain risk flags, not model inputs: too few past occurrences exist to validate them as features.
- FII/DII cash: NSE's report feed refuses automated clients (HTTP 403) and the collector does not work around that. Data enters through `POST /api/prediction/flows/cash/import` from the CSV downloaded from NSE's report; every row must satisfy buy - sell = net. A rolling window keeps only the newest 7 sessions and deletes older cash rows on each import (user-approved retention for this table).
- NSE participant-wise F&O files: pruned to the newest 7 sessions per file type after the user approved it (2026-10-29), with a verified full backup of the database written first to `data/backups/` (kept) and then a rolling window on every run. Consequence: the optional T+5 model with NSE positions cannot be trained; the position tables remain as context.

## D51 — Daily data without gaps (2026-10-29)
- The owner asked for a browser-style User-Agent to fetch NSE's FII/DII feed; the tool runner refused that as bot-protection circumvention and it was NOT built. FII/DII cash stays imported through a scheduled task that reads NSE's page in a real browser on the owner's PC (18:47 IST weekdays) or the CSV import box.
- NSDL's public FPI page (no stated restriction on automated access) is fetched once each evening by the app with an honest identifier: foreign equity activity (stock-exchange route and sub-total), validated (purchases - sales = net), rolling 7 sessions. It measures a different thing from NSE's FII figure and is shown separately.
- History refresh retries every 10 minutes between 07:30 and 09:10 IST while any overnight series (S&P, VIX, Brent, dollar index, USD/INR, US 10y) is older than the last weekday, so the forecast window gets complete data whenever the source has it.

## D52 — Intraday analysis page and command center (2026-10-29)
- The Analysis page is now **Intraday analysis**; the Market Sentiment Command Center sits above the unchanged widgets ([intraday](intraday.md)).
- Built on the existing stores only (observations, market history, flows, events); no new provider, no new dependency. One small append-only `intraday.sqlite3` holds score snapshots so the provisional rules can be evaluated later (no schema change to the existing databases).
- Rules-based, versioned, provisional scoring; correlated price measures form one group; missing groups lower coverage and are never zero; no probabilities anywhere until a validated intraday model exists.
- VWAP is reported as undefined for the NIFTY 50 index rather than approximated. Breadth and intraday sectors are shown as not available.
- The feed's previous close is cross-checked against the stored close of the previous trading session; a mismatch above 0.05 % uses the stored close and shows a warning.
- The master spec asks for the PC as the runtime and no external server; the VPS deployment (D48) was authorised earlier by the owner and is left as it is. Both run the same code.

## D53 — Prediction models are walled off from intraday data (2026-10-29)
- **Finding (audit):** 12 daily bars for 28 Oct (S&P, Dow, Nasdaq, Brent, WTI, gold, dollar index, VIX, US 10y, USD/INR, DAX, FTSE) had been stored at 15:15 UTC, mid-session, and 4 Asian bars for 29 Oct at 02:03 UTC. The bar store never overwrites, so partial intraday bars would have stood as final data feeding today's T+1 forecast.
- **Rules now enforced:** (1) a downloaded bar is stored only once its session has finished (`complete_after`: exchange close + 30 min; futures/FX series use 17:00 New York or end of the UTC day); (2) a bar stored too early is excluded from every read, and replaced by its final bar through the append-only `bar_corrections` table (the original row is kept, nothing deleted); (3) series whose newest bar is held back count as missing, so the overnight retry and the stale-data checks fire and the forecast is withheld rather than made on partial data; (4) the models are trained and evaluated only outside 09:15-15:45 IST on trading days, a cached report is still served; (5) a test fails the build if anything under `app/prediction` imports live, broker, stream, observation-store, API or intraday code, or if the intraday package imports the model code.
- Data flow is one-way: intraday code reads stored daily bars; the models never read intraday samples, option chains, live ticks or the intraday score ledger.
- News tone (GDELT) is collected but is not a model input (D49), so its 12-hourly schedule is not restricted.

## D54 — Data and storage plan for the 15 GB server (2026-10-29)
- Plan in [storage-plan.md](storage-plan.md), sized from measured data: a full session is about 16 MB of raw snapshot files, 5.5 MB in the observation database and 1.4 MB as a compressed archive (about 5 GB a year if nothing is removed). The server is the production collector, so the budget is the 15 GB SSD, not the PC.
- After 15:45 IST each finished session is validated, archived (verified by checksum and row counts), summarised (including the close-of-day option chain, permanent) and given a manifest; after 19:00 the databases are backed up (the server's own timer does this; the app skips its copy there) and regenerable leftovers are tidied. Daily T+1/T+5 models retrain on each new final price bar, never during 09:15-15:45.
- Deletion: only regenerable files (old exports, stray `*.tmp`, expired backup folders) are removed automatically. Removing snapshot files (raw payloads, normalized) is implemented with safety checks but **disabled** (`SNAPSHOT_RAW_KEEP_DAYS=0`, `SNAPSHOT_NORMALIZED_KEEP_DAYS=0`) until the owner approves limits. The recommended limits are 14 days (raw) and 30 days (normalized); the observation database and archives are kept.
- The intraday data is not an input of the daily models and cannot be (D53); it is retained because Kotak provides no historical option chains and it is cheap when archived.

## D55 — Intraday regime measure and the staged intraday-ML plan (2026-10-29)
- The one-minute efficiency ratio called a +171 point, 1.6x-normal climb "sideways". The regime now uses a z-score of the move against the 60-session daily volatility and the 5-minute path efficiency.
- Scenarios shown only when supported; the others are listed as ruled out with a reason.
- Intraday ML is staged by labelled sessions (5 experimental, 20 paper-test, 60 eligible for "validated"), and a labelled feature/label dataset is built every night from day one ([intraday-ml-plan](intraday-ml-plan.md)). No model is trained yet; no probability is shown.

## D56 — Market breadth, heavyweights, volume and sector analysis: plan (2026-10-29)
- Plan in [market-breadth-plan](market-breadth-plan.md); nothing built. Breadth (0.15) and sector (0.10) score groups stay "not available" until it is.
- Feasibility checked against Kotak's documentation: up to 3,000 subscribed tokens per connection, a scrip master and quotes API; our ticks already carry previous close and cumulative volume. Everything else (token coverage of NIFTY 500, tick rate, server load, weights/constituent sources and terms) is verified in a market-hours capture before any code depends on it.
- "Is the move real" is answered by breadth (NIFTY 50 and 500), equal- vs cap-weighted return, heavyweight contribution, and relative volume; thresholds are provisional and will be checked against the labelled dataset.
