# Strategy builder specification

Route `/strategy`. Underlying NIFTY 50 only (see the integration plan).

## Panels
1. **Instrument and expiry**: expiry list from the instrument master, spot and snapshot time of the stored chain, lot size from the chain, interest-rate assumption for the model. A missing chain or lot size is stated; nothing is assumed.
2. **Strategy**: template picker (18 templates, grouped) and the leg table. Columns: action, type, expiry, strike, lots, entry premium, premium source ("stored quote", "you entered", "missing"), market premium (stored snapshot), implied volatility, position value, unrealised P&L, duplicate/remove. Strikes are limited to the strikes listed for that expiry. Net premium and unrealised P&L against the snapshot are shown under the table. Strategies are saved by name in this browser.
3. **Payoff and risk**: exact expiry payoff chart (profit green, loss red), spot / target / breakeven markers, optional dashed estimate for a chosen date, max profit, max loss, breakevens, net premium, net delta / gamma / theta / vega, what-if sliders (target spot, days from now, volatility change), P&L table, editable cost assumptions, estimated costs and net.
4. **Historical test**: availability of stored sessions, controls, results (see the backtesting document).

## Labelling rules
User-entered values, stored quotes, model estimates and test results are labelled as such. The dashed curve is always "Estimated … (model)". Nothing is called live; market premiums are "last traded price in the stored snapshot at HH:MM".

## Validation (`validateStrategy`)
Whole-number lots >= 1; positive strike; strike listed for that expiry; expiry listed and not past; premium >= 0; missing premium is a warning that blocks the payoff; duplicate legs warned. Template errors say why (no listed strike that many steps away, no second expiry).

## Not offered because not implemented
Futures legs, orders, margin, indicator rules, re-entry, trailing stops, adjustments, partial exits, optimisation, walk-forward. They are absent from the interface rather than shown disabled.
