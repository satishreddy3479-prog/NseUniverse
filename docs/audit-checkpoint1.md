# Audit, Checkpoint 1 (2026-10-28)

Scope: the dashboard as of Phase 1 Checkpoint 1 plus the option-chain page. Evidence comes from the
user's real files on this PC (`data/snapshots`, `logs/backend.log`) and the SDK source (kotakneoapi 3.0.13).
No broker calls were made for this audit. Nothing was changed except this document.

## 1. Verdict
- **The displayed chain is real Kotak Neo data, but it is a one-time snapshot, not a stream.** Evidence: spot block
  `exchId "Nifty 50"`, symbols like `NIFTY26NOV22700CE`, lot size 65, tokens `nse_fo|<id>`, and internal checks (below).
  There is no streaming code in the application yet, so nothing is "live" in the streaming sense.
- The snapshot was captured at 15:49 IST, **after the 15:30 close**, so its values are the last session's closing state.
  The application cannot currently tell the user that (finding F1).
- Only one complete live snapshot exists (weekly 2026-11-03). The monthly (2026-11-23) latest is an **empty** snapshot from
  before the parser fix. Two older snapshots are **mock**. All five carry a `source` tag, so nothing is mislabelled.

## 2. Data path (traced)
Kotak `option_chain(exchange="nse_fo", underlying="NIFTY", expiry, count=40)` → `KotakBroker` (worker thread,
>=0.35 s spacing, relogin on auth errors) → `normalize_option_chain` → `SnapshotStore.save` (JSON + scrubbed raw
JSON + SQLite index) → `GET /api/option-chain?expiry=` (reads the **latest stored** snapshot; never calls the broker)
→ React page. `POST /api/snapshots/capture` is the only thing that calls the broker for chains (local-only, origin-checked).
Expiries: `expiries()` → `select_expiries` (cached 10 min) → weekly/monthly.

## 3. Field dictionary (what each displayed value means)
| Field | Source | Status |
|---|---|---|
| Strike, CE/PE, token, symbol | `inst.strkPrc/optType/neoSymbol/symbol` | Verified (162/162 contracts consistent) |
| ATM | `inst.moneyness == "atm"` (lowercase in payload) | Verified: 22700 = nearest strike to spot 22698.85 |
| LTP, open, high, low | `quote.ltp/o/h/l` | Verified: LTP within [low, high] for every contract with volume |
| Previous close | `quote.pc` | Plausible; `quote.c` equals `pc` for all 162 contracts, so **close is unusable** |
| LTP chg % | computed `(ltp - pc) / pc` | Our calculation; shown only when both exist |
| Volume | `quote.vol` | **Units, not lots**: 162/162 values divisible by lot size 65 (F2) |
| OI | `oi.cur` | **Units, not lots**: 162/162 divisible by 65 |
| OI change | computed `oi.cur - oi.prev` | Our calculation. Source `oi.chg`/`chgPct` are **price change** (equal LTP-pc in 158/162), so are never used |
| `oi.prev` | `oi.prev` | Meaning assumed previous trading day; **not verified** |
| Underlying price | `spot.ltp` (snapshot) | Real, shown as "from snapshot, not live". `spot.prevClose` available |
| Lot size | `common_data.mktLot` ("65") | Verified |
| Exchange timestamp | none in `option_chain()` | Not provided; the UI says so |
| Futures block | `future` | Ignored: `prevClose` is implausible (15572310) |

## 4. Findings
| ID | Sev | Finding | Proposed action (checkpoint) |
|---|---|---|---|
| F1 | High | No market-status awareness. The top bar would say "Fresh snapshot" for a post-close capture; values are the last session's close. | Subscribe to exchange status (`subscribe_exchange`, SDK `SFeedMarketStatus`) and show Market open/closed; do not assume hours or holidays. (CP2) |
| F2 | High | OI and volume are in **units**; users may read them as lots. Not labelled. | Label units; offer a lots view (units / lot size). (CP4) |
| F3 | Med | "Latest snapshot" can be an Empty (failed-parse) snapshot that hides an earlier good one. Currently the case for the monthly expiry. | Prefer latest non-empty; store a quality flag. (CP3) |
| F4 | Med | Mock and live snapshots share one store. History/charts must never mix them. | Partition by source and data mode before building history. (CP3) |
| F5 | Med | No exchange timestamp in snapshots. SFeed messages carry integer `last_trade_time`/`last_update_time`, but the SDK does not document units/epoch. | Verify live during market hours before displaying any exchange time. (CP2) |
| F6 | Med | The expiry list is not stored. Weekly 2026-11-03 and monthly 2026-11-23 (a Monday) look consistent with a holiday-shifted last expiry, but this is **unverified**. | Store the scrubbed expiries response with each capture; cross-check against the NSE calendar. (CP3) |
| F7 | Low | `quote.c` equals `pc`; `oi.prev` meaning unverified. | Re-check in a live session; keep computed fields labelled. |
| F8 | Low | A session killed by the Stop script gets no end time ("Not recorded"). | Heartbeat/last-seen timestamp. (CP3) |
| F9 | Low | Storage: ~115 KB per live snapshot (normalized + raw). At one snapshot per minute for two expiries over a 6.25 h session that is about 86 MB/day (about 1.7 GB per 20 trading days). No sampling or retention policy exists. | Compact observation tables in SQLite, raw payload sampled or compressed, retention settings, measured disk use. (CP3) |
| F10 | Low | Session expiry/relogin is only triggered by an auth-classified error. Kotak session lifetime is unknown and untested. | Test over a full session; proactive relogin. (CP2) |
| F11 | Info | No duplicate broker calls found. One `expiries()` (cached 10 min) plus one `option_chain()` per expiry per capture; no rate-limit headers appeared in responses. Frontend polls only the local backend (status 5 s, snapshots 15 s). | None |
| F12 | Info | Table performance is fine for 81 strikes x 2 sides; full-table re-render per tick will not scale to streaming. | Row-level memoized updates. (CP4) |
| F13 | Info | `count=40` returns 81 strikes (20700-24700, step 50). Any PCR or total must name this universe explicitly. | Define in analytics. (CP6) |

## 4b. Status after Checkpoint 2
F3 fixed (snapshot lookup prefers non-empty). F1 mechanism built (market status from `subscribe_exchange`), pending live verification. F5/F7/F10 need the live market check. F2, F4, F6, F8, F9 remain for Checkpoint 3/4.

## 5. Brief vs verified data availability
| Requested | Available from | Note |
|---|---|---|
| Underlying price | `option_chain().spot` (snapshot); SFeed index feed (`SFeedIndex`) | Index OHLC/change only via stream |
| Option LTP/OHLC/volume/OI | `option_chain()` and SFeed `SFeedScrip` | |
| Bid/ask and quantities | `quotes(quote_type="market_depth")` or SFeed depth subscription | Not in `option_chain()` |
| Market status | SFeed `subscribe_exchange` | No REST source verified |
| Intraday history (index/options) | SDK `historical_data()` exists; **not verified** (rate-limit issues reported upstream) | Review its docs in CP5 |
| IV, delta, gamma, theta, vega | **No verified provider field** | Must be computed and labelled theoretical (CP7) |
| Exchange timestamp | SFeed integer fields, units unverified | See F5 |

## 6. Preserved vs to change
Preserved: backend layers (config, broker adapter, normalization, storage, API), the dashboard shell, signal bar,
Overview, Data & sessions, Diagnostics, Settings, and the option-chain page. Planned changes are additive (streaming
service, observation store, richer table, charts, analytics).

## 7. Limits of this audit
Live streaming behaviour, timestamps and market-hours values cannot be observed until the market is open (next session
09:15 IST by usual NSE hours; not assumed by the application). Everything marked "verified" above was checked against the real
saved payload only.
