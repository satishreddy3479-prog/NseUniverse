# Requirements and working agreements

_Written 27 Nov 2026 from `CLAUDE.md`, `roadmap.md`, `decisions.md` and the owner's own instructions during the 27 Nov session. **The owner should read this and correct it**: where a statement is an inference, it says so. When the owner changes a requirement, change it here and add a `D###` to `decisions.md`._

## 1. What this is for

- A **personal, long-term research platform for the Indian options market**, built and used by one owner. It is not a product for sale and not an execution system.
- The chain of value, in order: reliable broker connectivity, then live option-chain data, then a professional dashboard, then OI / Greeks / IV / straddle analysis, then historical research and backtests, then more NSE instruments (see [roadmap](roadmap.md)). Today the platform covers **NIFTY 50 only** and is in **Phase 1** (live data and analysis), with the research pieces built on top.
- Data comes from **Kotak Neo** (login, option chain, live feed) and a few public sources (NSE files, Yahoo, RSS) for context.
- The owner uses it on **a phone and a PC**. Both must work; screenshots from the phone are the usual way a problem is reported.

## 2. What it must do (as built; see [current-state](current-state.md) for the status of each)

- Capture the live NIFTY 50 option chain (weekly and current-monthly expiries), stream it, and store a sample every minute in market hours, so any analysis can be redone from stored data.
- Show it: option chain, OI / volume / PCR / max pain, IV and Greeks, GEX, futures and breadth, market intelligence (the fused verdict, Day board, turn watch), the straddle decay engine with buyer and seller environments, Smart OI, global markets context.
- A **paper Strategy Builder**: build option strategies, see the payoff, track them on live prices, with stops, targets, trailing, re-entry, holding-period close and strategy-level rules, all checked **on the server every second** whether or not a page is open. Plus a swing paper book, a forward test and an edge monitor.
- Keep the system alive and honest: a watchdog, backups, restore checks, a deploy guard, and a Server Management Centre.

## 3. Out of scope, until the owner says otherwise

- **Placing orders**, or any broker call that changes anything. The platform is read-only.
- **Instruments other than NIFTY 50.**
- **Prediction models.** They were built and removed on 13 Nov 2026 (D148). Rules-based, explainable readings are fine; a forecast must never be presented as validated unless an independent check exists.
- **Mock or demo data.** Never fabricate live data; tests replay real captured payloads.

## 4. The quality bar

- **Data integrity first**: missing stays missing (never zero-filled), stale or incomplete data is flagged, exchange time and receipt time are kept apart, provenance is recorded. The full rules are in [`.claude/rules/financial-data.md`](../.claude/rules/financial-data.md).
- **Every formula verified** with an independent hand calculation on real captured data before it is called correct. "Validated" is a word that needs evidence.
- **Honest reporting**: say what is verified, what is only tested offline, and what has not run in a real market session. Do not claim an integration works without evidence.
- **A professional, consistent dashboard** with explicit loading, empty, error and stale states, working controls only, responsive on phone and PC ([`frontend-ui.md`](../.claude/rules/frontend-ui.md)).
- **Reliable on a very small server** (one core, about 1 GB of memory): nothing may block the loop that carries the live feed, and storage and load are measured before they are changed.

## 5. What the owner asked for on 27 Nov 2026 (for context: these explain recent decisions)

- The header must show the broker's closing value (25,884.50), not the frozen chain level, and keep it across reloads (D332).
- Charts and captured data should start at **09:15**, and the system should handle the market open without missing anything (D334).
- When the site stopped loading, find the cause and fix it, and add an alert so it is caught next time (D333).
- Strategy Builder fixes on both phone and PC (settings panel, Greeks columns), and payoff graphs for the calendar strategies.
- When a symptom had a cause that could be found (loop stalls, feed silences, a hung shutdown), **fix the cause, not only the delay** (D335 to D338).
- A **managed straddle** as a ready-made strategy: sell the ATM straddle; when NIFTY moves a chosen number of points (100, 150, 200, any value) close both legs and take the new ATM straddle. It must be **entirely on the server, with nothing dependent on a device** (D339).
- A **log and history** of the 100-point managed straddle's trades on the straddle engine page (D340).
- Repository documentation that lets any AI understand the app and the requirements.

## 6. Working agreements: how the owner wants the AI to work

- **Server-first.** Logic that must keep running (rules, checks, records) lives on the server. A page may configure and display; it must not be the only place something happens, and a device must not change what the server decides (the managed straddle takes only a distance from a page).
- **Ask before anything outward-facing.** Do not commit, push or deploy without being told. Pushing or merging to `main` is a production release (the server pulls it within a minute). The owner will say "push and deploy" when ready; "push, no deploy" means push to a **separate branch**, not `main`. A deploy during market hours (08:55 to 15:50 IST on weekdays) needs the owner's explicit word and the one-time override on the server; the AI says so first.
- **Report plainly.** Lead with what happened, say what was and was not verified, and name what is still open. A fix is "fixed" only with evidence, ideally a real market session.
- **Find causes.** Investigate with the stored events, logs and metrics before changing code; say when a cause is not established.
- **Small, tested, reversible steps.** Run the backend and frontend checks before saying a change is done; keep a decision record (`D###`) and update `current-state.md` after meaningful work.
- **Standing decisions the owner has given:** the single existing login for the control endpoints stays (no second credential, no source-address list); there is no off-server backup copy; latency to the broker is not a concern for the current research use (the production server is in the US, the feed in India).

## 7. Open points for the owner to confirm

- Is the 100-point managed straddle on the straddle engine page meant to stay fixed at 100, or should that page take the same distance as the builder? (Today: fixed at 100.)
- Should the Holding box show the actual next close date ("Next close: Mon 30 Nov 15:20")? On 27 Nov a strategy armed at 15:27 looked as if it had missed its 15:20 close. (Proposed, not built.)
- Should the builder's managed straddle also pause or warn visibly when the new strike has no live price? (Today it waits silently.)
- What should be next after Phase 1 verification: more history and research (Phase 4), or more instruments (Phase 5)?
