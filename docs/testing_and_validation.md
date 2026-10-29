# Testing and validation: strategy builder

Run `cd frontend && npx vitest run`.

* `src/test/strategy.test.ts` (19 tests): hand-calculated payoffs at lot size 65 for long and short call and put, bull call spread, long straddle, short strangle, iron condor, call butterfly and 1:2 ratio spread; lots multiplication; zero intrinsic and deep in-the-money; unlimited and bounded sides; one, two or no breakevens; curve equals the exact payoff and its maximum equals the reported maximum; missing premium, no legs and mixed expiries give "undefined"; all 16 templates build on listed strikes; the iron condor strikes; a template that does not fit the chain explains why; validation of bad lots, unlisted strikes, past and unknown expiries, negative and missing premiums and duplicates.
* `src/test/strategy-page.test.tsx` (11 tests): the stored chain shows with ATM highlighted and missing quotes as dashes; B/S adds a leg at the stored quote and a second click adds a lot; a contract without a quote is added with a blank premium and the payoff asks for it; a hand-built bull call spread gives the hand-calculated maximum loss, maximum profit and breakeven (lot size taken from the chain response); strikes shown can be narrowed; changing expiry clears legs and says so; a template fills editable legs with hand-calculated risk figures; lots, duplicate and remove with validation messages; save and load by name.
* `src/test/chartOptions.test.ts`: the payoff chart series, data and markers.

Not validated: the cost-free payoff against any third-party tool (none was available without a login); the maths is checked against hand calculations only.
