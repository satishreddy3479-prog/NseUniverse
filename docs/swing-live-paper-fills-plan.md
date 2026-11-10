# Plan: live intraday paper fills for the swing book (not built)

Status: BUILT 10 Nov 2026 as the separate provisional ledger described below (`backend/app/swing/live_ledger.py`, `SwingLive.live_fill_pass`, `GET /api/swing/live-fills`, the Live paper ledger panel). Choices on the open questions: the ledger sizes from its own equity; a rejected live position is closed at its last live price, marked void and stays listed; no on-screen alert. Setting `swing_live_fills_enabled` (default on; it cannot change the official book). Not yet seen with real ticks in market hours.

## What happens today
* The evening run (after 17:00 IST) settles one finished session with `settle_session` (`engine.py`): a queued order fills at `max(open, trigger)` only if the day's open is under the no-chase limit, the high reached the trigger, and the **full-day** volume reached the minimum (1.25 x the 20-day average). It is then tested on the same day against the day-1 rules (stop, close below the pivot, rejection wick), which need the **close**.
* The live panel (`live.py`, `live_rules.py`) shows the same rules on live prices in shadow mode and logs one event a day. It never writes to the book.

## Why a live fill cannot simply be switched on
1. **Two facts are only known at the close.** The volume test and the day-1 exits depend on the day's final volume, high, low and close. A buy made at 09:46 may be one the evening run would have skipped (volume short) or closed the same day (day-1 rules). Booking it live would put into the permanent record trades the rules would not have taken.
2. **Double booking.** The evening run inserts decisions, trades and positions in one transaction and refuses a session already recorded. A live fill would need the run to know about it, or it would book the same stock again.
3. **The record is permanent** (CLAUDE.md, `live.py` header): a wrong fill cannot be taken back.
4. **The feed can be wrong or stale**: a bad tick through the trigger, a stock with no token, or a feed gap would create a fill.

## Recommended design: a separate provisional live ledger, reconciled by the evening run
The official book stays exactly as it is. Add a second, clearly labelled ledger of *live paper* positions:
1. **Table `live_fills`** (session, symbol, order id, time, price, shares, state, reason) in the swing paper DB; states `open`, `confirmed`, `rejected`, `closed`. Nothing in `orders/positions/trades/equity` is touched.
2. **Entry (live):** when `check_entry` first returns `triggered` on a fresh tick (age under 120 s, pace at least 1.0, after 09:45, price confirmed on two consecutive polls, stock has a token), size it with the same rule as the evening run (risk % of the live-ledger equity, one slot per position, cash check, cooldown, slot limit) and record the fill at `max(day open, trigger)`, the same price the evening run uses. One fill per order per day (unique key).
3. **Exits (live):** the stop (`check_position`) closes a live position at the stop price or the gap price, exactly as in the engine. Day-1 close rules are applied only at the close, when the day's bar is known.
4. **Reconciliation (evening run):** after the official settlement of the session, compare each live fill with the official decision: `confirmed` if the official book also filled it (record the price difference), `rejected` with the official reason if not (for example volume short). The page shows both books and the differences; the official book is the record.
5. **UI:** a "Live paper" panel with its own equity, positions and fills, labelled provisional, plus a daily reconciliation table (live fill, official fill, reason, price gap). The "Triggered so far" wording changes to "Bought live (provisional)" only once a live fill exists.
6. **Safety switches:** a setting `swing.live_fills` off by default; fills only while the market is open and the feed state is `streaming`; no fills when the book is behind (`queue.current` false); a daily cap on live fills; every live decision logged with its inputs; no broker call anywhere.

## Alternative if you want the official book itself live
Possible only after (a) a full session of shadow events has been compared with the evening settlement (the original condition in `live.py`), (b) the day-1 rules and the volume test are redefined so they can be evaluated at entry time, which changes the strategy and its published backtest, and (c) the evening run is changed to adopt rather than redo fills. This is a rule change, not a feature, and I recommend against it before the reconciliation data above exists.

## Steps and tests
1. Schema and store methods (`live_fills`), unit tests for uniqueness and state changes.
2. Live entry and exit module reusing `check_entry`, `check_position` and the engine's sizing function (extract it so both use one implementation), tests on captured tick sequences including: stale tick, one-tick spike, gap above the limit, volume short, no token, slot full, cooldown.
3. Reconciliation after `settle_session`, tests that confirmed, rejected and price-gap cases are labelled correctly and that the official book is unchanged by the live ledger (a property test comparing official results with the ledger on and off).
4. API (`/api/swing/live-fills`, reconciliation) and the page panel with loading, empty, stale and error states.
5. Run in shadow-plus mode for at least five sessions: live fills recorded, reconciliation reviewed, before the setting is turned on for display on the main page.

## Acceptance
* Official book results are identical with the feature on or off.
* Every live fill has a matching reconciliation row the next evening.
* No live fill occurs on stale, missing-token or behind-book conditions.
* The page never calls a live fill an official trade.

## Open questions for you
1. Should live paper positions size from their own equity (recommended) or the official equity?
2. Should a live position that the evening run rejects stay visible until it is closed, or be marked void immediately?
3. Do you want an on-screen alert when a live fill is made?
