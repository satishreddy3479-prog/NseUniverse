# Strategy builder specification

Route `/strategy` (side-nav entry "Strategy builder"). Scope decided by the owner on 30 Oct 2026: **building a strategy and its payoff graph only**. Greeks, what-if sliders, cost estimates, a historical backtester and multi-expiry strategies were built first and then removed on request; they are in git history (commits `0bf3ecf`, `016dcc1`) if ever wanted again.

## Panels
1. **Option chain** (the app's own stored chain): underlying NIFTY 50, expiry selector (from the instrument master), spot, lot size and snapshot time from the stored chain, strikes shown (±5, ±10, ±20, all). Each strike row: call OI, call last traded price, **B** and **S** buttons for the call, strike (ATM highlighted), B and S for the put, put last traded price, put OI. B/S adds a leg of one lot priced at the stored quote; clicking again adds a lot; the button shows what is held ("B 2"). A contract with no stored quote is added with the premium blank for the user to enter. Changing the expiry clears the legs and says so.
2. **Strategy**: a template picker (16 templates in three groups) and the leg table: action, type, strike (listed strikes only), lots, entry premium (editable), premium source ("stored quote", "you entered", "missing"), market premium from the stored chain with a "use" shortcut, duplicate, remove. Validation messages appear on the leg. Save by name / load / delete saved (browser only).
3. **Payoff at expiry**: payoff chart (profit green, loss red, spot marker, breakeven markers, hover for P&L at any NIFTY level), max profit, max loss (or "Unlimited"), breakevens, net premium (credit or debit), lot size.

## Rules
* Lot size, strikes, expiries and premiums come only from the stored chain and the instrument master. Nothing is assumed; a missing lot size or chain is stated and blocks the rupee payoff.
* Premiums are last traded prices in a stored snapshot, labelled as such, not live quotes.
* The payoff is exact arithmetic on the entered premiums, before brokerage, taxes and charges.
* Only NIFTY: the other indices have no contract master or collected chain in this app.

## Templates
Long call, long put, short call, short put, long and short straddle, long and short strangle, bull call spread, bear put spread, bull put spread, bear call spread, iron condor, iron butterfly, call butterfly, 1:2 call ratio spread. Strikes are ATM plus or minus a number of **listed** strikes, so spacing is never hard-coded; a template that does not fit the chain says why. Every template produces ordinary editable legs.

## Validation
Lots whole and at least 1; strike positive and listed for the expiry; expiry listed and not past; premium not negative; a missing premium blocks the payoff and is asked for; duplicate legs are warned about.
