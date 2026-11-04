/**
 * Plain-language help for the numbers and charts on every page. One place, so the same term explains itself the
 * same way wherever it appears. `lookup(label)` matches a title or label loosely (case, punctuation, and a title that
 * only STARTS with a known term); a label with no entry shows no info button, nothing is invented.
 * Each entry says what the number is, how to read it, and what it does not tell you.
 */
export interface GlossaryEntry { what: string; read: string; caution?: string }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+% ]+/g, " ").replace(/\s+/g, " ").trim();

const E: Record<string, GlossaryEntry> = {
  // ---------------------------------------------------------------- Options Lab and Analyse tools
  "smart oi": {
    what: "How much more put OI than call OI was added inside each candle (1, 3, 5 or 15 minutes): (put OI now − put OI one candle ago) − (call OI now − call OI one candle ago). It is drawn as a bar from the zero line beside NIFTY's own candles.",
    read: "Green bars mean puts were added faster than calls in that candle (support building); red means calls were added faster (resistance building). Because each bar covers only its own candle, it turns before the day-total change does. The side panels show the day change since the first candle and the OI and volume put-call ratios.",
    caution: "OI changes can be new positions or closures, and OI does not say who is long or short, so this is a flow signal, not proof of intent. Candles with no stored sample are left out, not filled in; the strikes summed are fixed for the whole day.",
  },
  "oi buildup": {
    what: "For every option contract, whether today's price move and today's change in open interest point to new positions being opened or old ones closed: long buildup (price up, OI up), short buildup (price down, OI up), short covering (price up, OI down), long unwinding (price down, OI down).",
    read: "It describes the contract itself. Look at where the largest buildups cluster.",
    caution: "OI is reported for the day, so the label is a daily picture. Contracts without a previous close, or with no change, carry no label.",
  },
  "pe ce difference": {
    what: "Put minus call for open interest, OI change or volume at each strike.",
    read: "Bars above zero (green) mean more put than call at that strike, below zero more call. The total at the top is the sum over the strikes shown.",
    caution: "More puts than calls is not by itself bullish or bearish: it depends on who holds them. Strikes missing a value on either side are left out and counted.",
  },
  "volatility skew": {
    what: "The implied volatility of each strike's call and put, solved from its own last traded price with the Black-76 model.",
    read: "A line that rises away from the money means the market pays more for protection or for large moves at those strikes. Calls and puts at one strike should be close; a gap hints at stale prices.",
    caution: "Illiquid strikes have stale prices and noisy volatility. The model uses a 6 % rate and a forward from put-call parity; gaps in the line are contracts that gave no volatility.",
  },
  "gamma exposure": {
    what: "Gamma × open interest × spot² × 1 %, per strike: the rupee value of NIFTY whose delta changes when the index moves 1 %.",
    read: "Large bars show strikes where positions are most sensitive to a move. Call and put bars are separate; net = call − put assumes the market is long calls and short puts.",
    caution: "Who is long or short is not observable from open interest, so the net line is a convention, not measured dealer positioning. Treat it as a map of where sensitivity sits.",
  },
  "vega analysis": {
    what: "Vega per volatility point × open interest, per strike: how much all contracts at a strike would gain or lose for a one-point change in implied volatility.",
    read: "The tallest bars are the strikes where a volatility change matters most. Calls and puts are shown separately.",
    caution: "It sums contract sensitivities without knowing which side holds them. It uses the same model volatility as the skew chart.",
  },
  "vega exposure": {
    what: "Vega per volatility point × open interest at each strike, for calls and puts.",
    read: "Tall bars are where a change in implied volatility moves contract values most.",
    caution: "Model values from each contract's own price; strikes without a usable price are left out and counted.",
  },
  "index contributors": {
    what: "How many percentage points each NIFTY 50 stock has added to or taken from the index today: its weight × its change since the previous close.",
    read: "The longest bars are what moved the index. The sum of all contributions should be close to the index's own change.",
    caution: "Needs weights. They are as of the date shown and rolled to recent closes, so small differences from the official index are normal.",
  },
  "advance decline": {
    what: "How many NIFTY 50 stocks are above and below their previous close right now.",
    read: "A ratio above 1 means more stocks are up than down. Compare it with the index: an index rising on a few heavyweights while most stocks fall is a narrow move.",
    caution: "Only stocks with a current price count; the coverage is shown. It covers the 50 index stocks, not the whole market.",
  },
  "index weightage": {
    what: "The share of each NIFTY 50 stock in the index, with its sector and today's change.",
    read: "Higher weights move the index more for the same percentage change.",
    caution: "Official weights change with prices and are reviewed periodically; the table shows their date and source.",
  },
  "sector rotation": {
    what: "NIFTY 50 stocks grouped by sector, ranked by their return today minus the index's return.",
    read: "Sectors at the top are leading the index, those at the bottom lagging. Compare the up/down counts with the return.",
    caution: "Sectors with few stocks in NIFTY 50 are noisy. Groupings follow the NIFTY 50 list stored on this server.",
  },
  "market movers": {
    what: "The NIFTY 50 stocks with the largest gains and losses today.",
    read: "The volume multiple compares volume so far with the stock's recent average for this time of day.",
    caution: "NIFTY 50 only. Relative volume needs enough stored sessions and is hidden until it has them.",
  },
  // ---------------------------------------------------------------- sentiment and intraday command center
  "current market sentiment": {
    what: "A score from −1 (clearly bearish) to +1 (clearly bullish) that adds up what the market is doing right now: NIFTY price action, breadth, sector participation, options positioning, overnight global markets and institutional cash flows.",
    read: "Above about +0.2 leans bullish, below about −0.2 leans bearish, in between is neutral. Coverage says how many of the evidence groups had data; a low coverage score is less reliable.",
    caution: "It is rules-based with provisional weights, not a trained model and not a forecast of where NIFTY goes next.",
  },
  "evidence breakdown": {
    what: "The groups of evidence behind the sentiment score, each with its own score from −1 to +1 and the weight it carries.",
    read: "A bar to the right is bullish evidence, to the left bearish. The final score is the weighted average of the groups that have data. Tap a row for its formula, inputs and source.",
    caution: "Weights are provisional, not fitted. Groups that move together (price action and breadth) count as separate votes.",
  },
  "sentiment history today stored": {
    what: "The sentiment score recorded once a minute during today's session (orange line, left axis, −1 to +1) next to NIFTY at the same moments (blue line, right axis, index points).",
    read: "Compare the two: when the orange line leads or confirms the blue one, the evidence agreed with price. A score near 0 with NIFTY moving means the evidence was mixed. The dashed line is zero (neutral).",
    caution: "Each score was stored at the time, never recalculated afterwards. Overlapping minutes are not independent observations, so a long agreeing stretch is not proof the score predicts anything.",
  },
  "forward check of the rules based sentiment": {
    what: "A test of whether the stored sentiment scores were followed by price moves in the same direction, using only scores saved before each outcome.",
    read: "Compare the mean move after bullish scores with neutral and bearish ones. Sentiment carries information only if bullish scores are followed by clearly higher moves than the others, over enough sessions.",
    caution: "Until about 20 sessions are stored this is a record, not evidence. Samples overlap, so counts overstate how much independent data there is.",
  },
  "market regime scenarios": {
    what: "What the market is doing now (observed regime, for example trending or mean-reverting/choppy) and the scenarios that could follow, each with what strengthens it and what weakens it.",
    read: "The regime is measured from today's price path: size of the move versus a typical move, and how directly price travelled (path efficiency). Scenarios list conditions to watch, with price levels.",
    caution: "No probabilities are given because no validated intraday model exists. Scenarios are conditions to watch, not predictions.",
  },
  "market breadth move quality": {
    what: "How many stocks are rising versus falling, and whether the index move is broad or carried by a few heavyweights.",
    read: "More advancers than decliners with the index up is a broad, healthier move. An index up on few stocks, or down while most stocks are up, is a narrow move.",
    caution: "Equal-weighted breadth treats a small stock like a large one; the index is cap-weighted. Both views matter.",
  },
  "nifty 50 heavyweights": {
    what: "The largest NIFTY stocks and how much each added to or took away from today's index move, in index points.",
    read: "A few large positive contributors can lift the index while most stocks fall, and the reverse. Read the biggest bars first.",
    caution: "Contribution uses official index weights as of the last published date, so it is an estimate during the day.",
  },
  "breakout intelligence": {
    what: "Whether NIFTY has moved out of its opening range (first 15 minutes) or key levels, and whether the move is holding, with volume and breadth as support.",
    read: "A break with rising volume and broad participation is stronger than a break without them. A move that returns inside the range is a failed breakout.",
    caution: "Rule-based observations, not predictions. Rules are provisional until enough sessions are stored.",
  },
  "futures flow and top 5 heavyweights": {
    what: "An estimate of buying and selling pressure in NIFTY futures and in the five largest stocks, from the exchange feed.",
    read: "Rising price with rising futures activity suggests new positions; rising price with falling activity suggests covering. Compare the futures reading with the heavyweights.",
    caution: "Estimated from the feed, not official exchange flow figures.",
  },
  "implied volatility greeks": {
    what: "The market's expected size of moves (implied volatility, IV) and the sensitivities of options (Greeks), computed from today's option prices with the Black-76 model.",
    read: "Higher IV means options are priced for bigger moves. ATM IV is the level near the current price; a smile shows IV across strikes. Delta, Gamma, Theta and Vega are explained on their own info buttons.",
    caution: "Model values from last traded prices. Prices from thin contracts give noisy IV.",
  },
  "options positioning detail": {
    what: "Where option buyers and sellers have built positions: open interest by strike, put-call ratios and the strikes with the largest call and put OI.",
    read: "Large put OI below the price is often described as support and large call OI above as resistance, because writers defend those strikes. Changing OI shows where positions are being added or removed.",
    caution: "Open interest does not say who is long or short. Concentrations are positioning, not guaranteed support or resistance.",
  },
  "options positioning": {
    what: "A summary of today's option positions: total call versus put open interest, put-call ratio (PCR) and the strikes where positions are concentrated.",
    read: "PCR above about 1 means more puts than calls are outstanding, below 1 more calls. Extremes can indicate crowded positioning. Use the biggest call and put OI strikes as reference levels.",
    caution: "PCR alone is not a buy or sell signal. It describes positioning, not direction.",
  },
  "intraday decision context": {
    what: "The questions a trader asks during the day (is it trending or rotating, where is price relative to key levels, is volatility normal) with the data-based answer to each.",
    read: "Each answer shows the numbers behind it. Read the answer, then the numbers, then decide whether you agree.",
    caution: "Context, not a trade signal.",
  },
  "key levels": {
    what: "Prices that traders watch: the previous day's high, low and close, today's opening range and session high/low, the ATM strike and the strikes with the largest call and put open interest.",
    read: "The list is sorted by price with the current price in between, and shows how many points each level is from now. The nearest level above and below are the first ones to watch.",
    caution: "Levels are references, not guarantees. Open-interest strikes show positioning, not support or resistance.",
  },
  "data coverage warnings": {
    what: "Which data feeding this page is fresh, stale or missing: option chain, daily history, breadth, sectors, weights, volume baseline, flows, global markets, calendars and the intraday model.",
    read: "Green Fresh means usable. Anything else lowers how much to trust the readings that depend on it. The score's coverage figure counts how many groups had data.",
    caution: "A missing feed is shown as missing and left out, never filled with a made-up value.",
  },
  "global sectors flows": {
    what: "Overnight global markets, sector performance and the institutional cash flow (FII/DII) figures used as context for the day.",
    read: "Global markets set the opening tone. Sector bars show which parts of the market lead or lag. FII/DII cash figures are the official provisional numbers from the previous session.",
    caution: "Flows are published after about 18:00 IST, so they are never an intraday figure.",
  },
  "events ml model": {
    what: "Scheduled events that can move the market (results, elections, policy dates) and the status of the intraday machine-learning model.",
    read: "Events marked with ? have an unconfirmed time. The model stages show whether enough complete sessions exist to train and validate it.",
    caution: "Until the model is trained and validated, the sentiment on this page is rules-based, not ML.",
  },
  "paper trading of the setups after costs": {
    what: "A simulation of the rule-based setups on stored sessions, including trading costs and slippage. Nothing is sent to any broker.",
    read: "Net after costs is the result; win rate is how often trades won; expectancy is the average per trade; profit factor is gross wins divided by gross losses; max drawdown is the biggest peak-to-trough fall.",
    caution: "With fewer than about 30 trades the result is noise-sized and proves nothing.",
  },
  "setup monitor": {
    what: "Rule-based trade setups (such as an opening-range breakout) and whether their conditions are met right now.",
    read: "Each setup lists its trigger, the invalidation level and the current state. It is a checklist of conditions, nothing more.",
    caution: "Read-only, no orders and no probabilities.",
  },
  "prediction model research 15 min": {
    what: "A walk-forward test of whether a model can predict the next 15 minutes from stored intraday data.",
    read: "Compare the model with simple baselines on data it never saw. Only a clear, repeated edge over the baselines would justify using it.",
    caution: "With few labelled sessions the result is insufficient data and says nothing about future accuracy.",
  },
  "session replay": {
    what: "Shows this dashboard as it was at an earlier time of a stored session, using only what had been stored at that moment.",
    read: "Pick a session and a time, then press Show. Useful to review a decision without hindsight.",
  },
  "sectors": {
    what: "Return of each sector today, from equal-weighted NIFTY 500 stocks, ranked by strength against the index.",
    read: "Return is the average stock move in the sector; vs index is the difference from NIFTY; up/down counts stocks; volume vs normal compares today's volume with the 20-day average.",
    caution: "Equal weighting makes small stocks count as much as large ones, so it can differ from the official sector indices.",
  },

  // ---------------------------------------------------------------- option-chain analysis widgets
  "nifty 50 snapshot observations": {
    what: "NIFTY's level at each stored snapshot of the option chain, against the previous close (dashed line).",
    read: "The line shows how the index moved during the session. Gaps are times with no snapshot.",
    caution: "Points are snapshots (about once a minute), not every tick.",
  },
  "open interest by strike": {
    what: "Open interest (OI): the number of option contracts still outstanding at each strike, calls and puts.",
    read: "Tall bars are strikes with many open positions. Calls (green) above the price and puts (red) below it show where positioning is concentrated.",
    caution: "OI is in units, not lots (1 lot = 65 units). It says nothing about who is long or short.",
  },
  "oi change by strike": {
    what: "Change in open interest per strike: today's OI minus the previous day's OI, calculated here.",
    read: "Rising OI means new positions were opened, falling OI means positions were closed. Compare with price: rising OI with rising price is fresh buying or writing, depending on the side.",
    caution: "Direction of OI change does not reveal whether traders bought or sold the option.",
  },
  "option chain": {
    what: "Every listed strike with call and put prices, open interest, volume and implied volatility.",
    read: "The strike in the middle is the one nearest the index (ATM). Calls to the left, puts to the right. Highlighted rows are your strategy legs.",
  },
  "total premium": {
    what: "The sum of last traded prices of all call options and of all put options in the selected strike range, over the session.",
    read: "Both rise when volatility or time value rises and both fall as options decay. A gap between calls and puts shows which side is richer.",
    caution: "Samples missing prices for some contracts are drawn as gaps so the total does not jump for the wrong reason.",
  },
  "premium decay": {
    what: "How the premium of a fixed set of strikes has changed since the first sample of each day (each day starts from zero).",
    read: "Below zero means those options lost value since the day began. Faster decay on one side shows where selling pressure or falling volatility hit.",
    caution: "The same strikes are used at every point so the line compares like with like.",
  },
  "nifty futures open interest": {
    what: "Open interest of the NIFTY current-month future: the number of futures contracts still open (units, 1 lot = 65), through the session.",
    read: "Rising OI with rising price usually means new long positions; rising OI with falling price, new shorts; falling OI means positions are being closed. The dotted line is the future's price.",
    caution: "OI shows positions, not who is long or short. The line is empty if the feed did not supply OI for the future.",
  },
  "nifty futures oi change": {
    what: "Open interest of the NIFTY future now minus its previous session's last OI (or the session's first value when yesterday was not recorded; the note under the chart says which).",
    read: "Above zero means positions were added since the baseline, below zero means they were closed. Read it with the price: price up with OI up is new buying; price up with OI down is short covering.",
    caution: "The broker does not supply previous-day OI for futures here, so the baseline is from our own recordings.",
  },
  "nifty spot vs futures gap": {
    what: "The NIFTY index and its current-month future on one axis, with the gap between them: future minus index, in points (area, right axis). The corner shows the latest gap, its percentage of the index, the carry it implies per year, and the gap that financing alone would justify.",
    read: "The future normally trades above the index by the cost of carry, shrinking to zero at expiry. Carry p.a. = ln(future ÷ index) ÷ years to expiry. 'Fair' is index × (e^(rT) − 1) at an assumed rate, with no dividends; 'vs fair' above zero means the future is rich to financing, below zero cheap. A sudden narrowing or a discount can signal selling pressure in futures.",
    caution: "The assumed rate is 6% and dividends are ignored, so 'fair' is a reference, not a measurement. The index and future are read at the same moment from the live feed; older points may use the nearest stored snapshot.",
  },
  "nifty futures volume": {
    what: "Contracts of the NIFTY future traded today (line, cumulative) and per minute (bars).",
    read: "Bars show when trading was heavy. A rising line with a flat price means turnover without direction; a burst of volume with OI change shows conviction.",
  },
  "total volume over time call vs put": {
    what: "Contracts traded today in all calls and in all puts of the selected strikes, cumulative since the open, at each stored sample.",
    read: "The side with the steeper line is the one being traded more actively. Compare with the OI charts: heavy volume with little OI change means positions were opened and closed inside the day.",
    caution: "Volume counts trades, not positions; it does not say who bought or sold.",
  },
  "total oi calls vs puts": {
    what: "Total open interest of all calls compared with all puts in the selected strikes.",
    read: "More puts than calls gives a ratio above 1. Look at the split bar for the balance.",
  },
  "total oi change calls vs puts": {
    what: "Total change in open interest, calls versus puts, since the previous day.",
    read: "Which side added more positions today. Both rising means heavy activity; one side shrinking means unwinding.",
  },
  "volume by strike": {
    what: "Contracts traded today at each strike.",
    read: "High volume shows where trading is active now, as opposed to open interest, which shows positions that stay open.",
  },
  "atm straddle": {
    what: "The price of the ATM call plus the ATM put, over the session.",
    read: "It approximates the market's expected move to expiry. A rising straddle means options are getting more expensive; a falling one means decay or lower volatility.",
    caution: "It is a price, not a forecast.",
  },
  "pcr atm and overall": {
    what: "Put-call ratio: put open interest divided by call open interest, near the ATM strikes and across the whole chain.",
    read: "Above 1 there are more puts than calls outstanding, below 1 more calls. A rising PCR means puts are being added faster.",
    caution: "PCR describes positioning, not direction, and means different things at different times in an expiry cycle.",
  },
  "put call ratio over time": {
    what: "The put-call ratio at each stored sample today.",
    read: "A line climbing above 1 shows put positions building; falling below 1 shows call positions building. The dashed line marks 1.0.",
    caution: "Corrupt or missing samples are left out, never drawn as zero.",
  },
  "oi change over time call vs put": {
    what: "Total OI change since the previous day for calls and puts, at each sample.",
    read: "Shows when during the day positions were added. A steep step is a burst of activity.",
  },
  "total oi over time call vs put": {
    what: "Total call OI and put OI at each stored sample.",
    read: "Parallel lines mean little change; diverging lines show one side being built faster.",
  },
  "intraday oi change": {
    what: "Change in open interest since a chosen point in today's session (session open, previous snapshot or a chosen time).",
    read: "Choose the baseline above the chart. Bars show where positions were added or closed since that time.",
  },
  "oi change heatmap": {
    what: "OI change by strike (rows) over time (columns), as colours.",
    read: "Bright cells show strikes and times with the most change. A bright band that stays shows persistent building at that strike.",
  },
  "oi concentration": {
    what: "How concentrated open interest is: the share of OI held by the top strikes.",
    read: "A few strikes holding most OI mean the market has clear reference prices. Spread-out OI means no strong anchor.",
  },
  "price and oi": {
    what: "NIFTY's price next to open interest through the session.",
    read: "Price up with OI up on puts suggests puts being written (support building); price up with call OI falling suggests call covering.",
    caution: "These are common readings, not rules.",
  },
  "strike detail": {
    what: "All figures for the strike you selected: prices, OI, OI change, volume and IV for the call and the put.",
    read: "Click a row in the option chain to choose a strike.",
  },

  // ---------------------------------------------------------------- strategy builder
  "p l now vs entry": {
    what: "Profit or loss of all active legs right now, using the latest prices against your entry premiums.",
    read: "Green is ahead, red is behind. It is before brokerage, taxes and charges.",
  },
  "pop model estimate": {
    what: "Probability of profit: the model's chance that the strategy ends in profit at expiry.",
    read: "Above 50% means profit is more likely than not under the model, but a high POP often comes with small profit and large loss.",
    caution: "Assumes NIFTY moves like a lognormal with today's ATM volatility. A model estimate, not a forecast.",
  },
  "reward risk": {
    what: "Maximum profit divided by maximum loss at expiry.",
    read: "0.22 : 1 means the best case earns about 0.22 for every 1 risked. N/A when profit or loss is unlimited.",
  },
  "max profit": {
    what: "The best possible profit at expiry across all NIFTY levels, on your entry premiums.",
    read: "For a credit strategy this is often the premium you collected. Unlimited means profit has no cap.",
  },
  "max loss": {
    what: "The worst possible loss at expiry across all NIFTY levels.",
    read: "Unlimited means loss grows without a cap if NIFTY keeps moving, which needs a stop-loss or a hedge.",
  },
  "breakevens": {
    what: "The NIFTY levels at which the strategy neither gains nor loses at expiry.",
    read: "Between the two breakevens of a short straddle or strangle you profit, outside you lose. The percentages show their distance from the current price.",
  },
  "net premium": {
    what: "The total premium paid or received when entering the legs. Credit means you received money.",
    read: "A credit is the most a pure short strategy can earn; a debit is the most a pure long strategy can lose.",
  },
  "net model": {
    what: "Net delta: how many NIFTY units the position behaves like. Theta is the change per day from time passing and Vega the change per volatility point.",
    read: "Delta +10 gains about ₹10 for every 1-point rise in NIFTY. Positive theta means time passing helps you; negative vega means a rise in volatility hurts you.",
    caution: "Black-76 model values from last traded prices.",
  },
  "if targets hit": {
    what: "Total profit or loss if every leg that has a target reaches its target premium.",
    read: "Exact arithmetic from your targets: (target premium − entry) × quantity, summed.",
  },
  "if stops hit": {
    what: "Total profit or loss if every leg that has a stop reaches its stop premium.",
    read: "Shows the loss you are accepting. Check it against what you can afford.",
  },
  "delta": { what: "How much an option's price changes when NIFTY moves 1 point.", read: "A call has delta between 0 and 1, a put between −1 and 0. Delta is also roughly the market's chance that the option expires in the money." },
  "gamma": { what: "How much delta changes when NIFTY moves 1 point.", read: "High near expiry and near the ATM strike: the position's direction exposure then changes quickly." },
  "theta": { what: "How much an option loses per day from time passing, in ₹ per unit.", read: "Sellers collect it and buyers pay it. It speeds up as expiry approaches." },
  "vega": { what: "How much an option's price changes for 1 volatility point.", read: "Buyers gain when volatility rises, sellers lose." },
  "iv": { what: "Implied volatility: the yearly volatility that reproduces the option's traded price in the model.", read: "Higher IV means the market expects bigger moves. Compare strikes (smile) or days." },
  "oi": { what: "Open interest: contracts outstanding, in units.", read: "Rising OI means positions are being added." },
  "ltp": { what: "Last traded price of the contract.", read: "May be old for contracts that trade rarely." },


  // ---------------------------------------------------------------- data clean-up page
  "disk": { what: "How full the server's disk is, how much of it is this app's data, how fast it grows and how many days of room remain at that rate.", read: "Ok means plenty of room. Watch or low means plan a clean-up. Critical pauses the sampler to protect the server.", caution: "Growth is an estimate from recent days." },
  "todays data": { what: "What has been stored so far today: samples of the option chain, the per-contract rows behind them, the snapshot files and the rows the intraday model learns from.", read: "Samples arrive about once a minute in market hours. The intraday ML rows are the model's training data and are never removed.", caution: "Today's data stays until the end-of-day job has archived and verified it." },
  "what could be removed": { what: "Data that is safe to remove because the verified daily archive already holds the same information, or because it can be created again.", read: "Select items, press Review, check the exact amounts, confirm. Sizes are measured now, not guessed. A day the archive does not fully cover is kept and listed.", caution: "Removal cannot be undone, which is why only archived or regenerable data is offered." },
  "what is stored": { what: "Every database and folder this app keeps, what it holds, its size, how many rows each table has and why it is kept.", read: "Large rows counts in the observations store are normal: one row per contract per changed sample.", caution: "Sizes include the database's write-ahead log files." },
  "never removed": { what: "Data this page never offers for removal.", read: "These are either the training and testing evidence for the models, the archive that makes other removals safe, or small append-only records.", caution: "They can only be removed from the server by hand." },
  "samples today": { what: "Option-chain snapshots stored today, per expiry.", read: "About one a minute during market hours; unchanged repeats are counted but store no contract rows.", caution: "" },
  "contract rows": { what: "One row per option contract per changed sample (price, open interest, volume).", read: "This is the biggest part of the observation database, and what old sessions can shed once archived.", caution: "" },
  "snapshot files": { what: "Compressed copies of each broker response and its normalized form, one folder per day.", read: "Raw responses are kept for the approved number of days after the archive is verified.", caution: "" },
  "intraday ml rows": { what: "Feature rows with their outcomes, which the intraday model trains and is tested on.", read: "More complete sessions mean a better chance to validate the model. Needs about 60 sessions before it is trained.", caution: "Never removed." },

  "roll": { what: "Moves a leg to another strike the way a trader adjusts a position: the current leg is closed at its live price and the same leg is opened at the new strike at that strike's live price.", read: "The profit or loss of the closed part is booked (it stays in the P&L and in the payoff as a fixed amount) and the new leg starts fresh with the stop and target at the same percentage distance. Changing the strike with the arrows does NOT book anything: that is for planning before you enter.", caution: "Paper only, nothing is sent to a broker. Needs live prices for both strikes." },
  "running strategies live": { what: "The total profit or loss right now of every saved strategy that still has an open leg, at live prices.", read: "Each strategy's figure is what its exits, stops, targets and rolls already booked plus its open legs at the market price against their entry premiums. Strategies with a missing price are left out of the total and counted separately.", caution: "Before brokerage, taxes and charges. Paper positions: nothing is sent to a broker." },
  "closed strategies": { what: "The realised profit or loss of strategies closed with Exit all, added together.", read: "Exit all moves a strategy from Saved to Closed at the prices of that moment; the figure is final.", caution: "Closed at stored prices when no live price was available (marked 'stale prices')." },
  "total p l": { what: "Running strategies at live prices plus closed strategies' realised P&L.", read: "Your overall paper result across the strategy builder.", caution: "" },
  "booked in running": { what: "Profit or loss already locked in inside strategies that are still running: legs closed by stops, targets, manual exits and rolls.", read: "Compare with the open P&L to see how much is realised and how much still moves with the market.", caution: "" },
  "running strategies": { what: "Saved strategies that still have at least one open leg, with their live mark-to-market.", read: "Click a row to open it in the strategy builder and adjust it: exit or roll legs, change stops and targets.", caution: "" },
  "re entry": { what: "How many times a leg closed by its STOP is entered again, automatically, at the live price.", read: "After a sold leg is stopped out (its premium rose to the stop), if the premium falls back to its own entry premium or below, the leg is entered again at the live price, and the stop and target keep the same percentage distance from the new entry. A bought leg is the mirror image: stopped below, entered again when the premium rises back to its entry. 1 means once; 0 means never.", caution: "Paper only, nothing is sent to a broker. Only stops re-enter, not targets or manual exits." },
  "auto stop and target": { what: "When switched on, a leg whose live price reaches its stop or target is closed in this strategy at the live price, and its profit or loss is booked.", read: "The closing price is the live price at that moment, which can be beyond the level you set. Booked P&L shows in the P&L box; the payoff chart treats the closed leg as a fixed amount.", caution: "Paper only: it never places an order. It runs only on live streamed prices and only while this page is open, so it does not act when the market is closed or the stream is stale." },

  // ---------------------------------------------------------------- table columns
  "lots": { what: "Number of lots of this option in the leg. One NIFTY lot is 65 units.", read: "The quantity line underneath shows lots × multiplier × lot size.", caution: "" },
  "entry": { what: "The premium (price per unit) at which this leg is taken. It starts as the stored last traded price and you can overwrite it.", read: "All P&L, breakevens and maximum profit and loss use this number.", caution: "A hand-entered premium is labelled 'you entered'." },
  "strike": { what: "The strike price of the option.", read: "The percentage under the strike is its distance from the current NIFTY level.", caution: "" },
  "target": { what: "The option premium at which you plan to take profit on this leg. Type a percentage and the price fills in, or type the price.", read: "For a bought option the target is above the entry; for a sold option it is below.", caution: "A plan, nothing is sent to a broker." },
  "stop": { what: "The option premium at which you plan to exit to limit the loss on this leg.", read: "For a sold option the stop is above the entry; for a bought option it is below. The ₹ under it is the loss at that stop.", caution: "A plan, nothing is sent to a broker. Real fills can be worse than the stop." },
  "p l": { what: "Profit or loss of this leg now: (current price − entry) × quantity, with the sign flipped for sold options.", read: "Green is ahead, red is behind.", caution: "Before brokerage, taxes and charges." },
  "delta per day": { what: "This leg's delta (change in value per NIFTY point) and theta (change per calendar day), both for the whole position size.", read: "Delta −33 means the leg loses about ₹33 for every NIFTY point up. Theta +₹1,500 means about ₹1,500 earned per day from time passing.", caution: "Black-76 model values." },
  "call oi": { what: "Open interest of the call at this strike, in units.", read: "Bars to the left of the strike; longer means more open positions.", caution: "" },
  "put oi": { what: "Open interest of the put at this strike, in units.", read: "Bars to the right of the strike; longer means more open positions.", caution: "" },
  "delta per unit": { what: "Change in the option's price for a 1-point NIFTY move, per unit.", read: "Calls 0 to 1, puts −1 to 0.", caution: "" },
  "position delta": { what: "Delta of the whole leg: per-unit delta × lots × lot size.", read: "How many NIFTY units the leg behaves like.", caution: "" },
  "theta per day": { what: "Value an option loses per calendar day from time passing.", read: "Sold options earn it, bought options pay it.", caution: "" },
  "vega per vol point": { what: "Change in value for a 1-point rise in implied volatility.", read: "Positive for bought options, negative for sold ones.", caution: "" },

  // ---------------------------------------------------------------- prediction and data
  "model comparison": {
    what: "Several forecasting models compared on data none of them was tuned on (the untouched holdout period).",
    read: "A model is only worth using if it beats the simple baselines clearly and repeatedly on the holdout. Look at hit rates and errors, not at one good day.",
    caution: "Past accuracy does not guarantee future accuracy.",
  },
  "forward scoreboard": {
    what: "Results of forecasts that were locked before the outcome was known.",
    read: "This is the honest test: only forecasts recorded in advance count. Wait for enough days before trusting any percentage.",
  },
  "forward test ledger": {
    what: "The permanent record of each forecast, written before the outcome and never edited.",
    read: "Each row shows the forecast, the cutoff time and, after settlement, what happened.",
  },
  "daily forward test log": {
    what: "Every forecast day, whether it was recorded on time or missed.",
    read: "Missed days are shown as missed, never filled in afterwards.",
  },
  "post mortem": {
    what: "A review of settled forecasts: what the model got right and wrong.",
    read: "Look for patterns (for example always too bullish after a gap) rather than single results.",
  },
  "institutional positions": {
    what: "Open positions of FII, DII, proprietary traders and clients in NSE index futures and options, from the exchange's participant file.",
    read: "Net = long − short, in contracts. A large net short by FIIs in futures is read as bearish positioning.",
    caution: "Published after the close, so it describes the previous session.",
  },
  "fii dii cash activity": {
    what: "Net buying or selling of Indian stocks by foreign (FII) and domestic (DII) institutions in the cash market, in ₹ crore.",
    read: "Positive net = buying. Heavy FII selling offset by DII buying is common.",
    caution: "Official provisional figures, published after about 18:00 IST.",
  },
  "live stream": {
    what: "The live price feed from the broker: connection state, subscribed instruments and how recent the last tick is.",
    read: "Streaming and fresh means prices on screen are live. Stale means the feed is connected but silent.",
  },
  "storage and end of day": {
    what: "What the system stores, how much disk it uses, and the nightly end-of-day archive, backup and cleanup jobs.",
    read: "Check free space and that the latest day shows a verified archive.",
  },
};

const KEYS = Object.keys(E).sort((a, b) => b.length - a.length);

/** Entry for a label or title, or null when there is none. */
export function lookup(label: string | undefined | null): { key: string; entry: GlossaryEntry } | null {
  if (!label) return null;
  const n = norm(label);
  if (E[n]) return { key: n, entry: E[n]! };
  const k = KEYS.find((x) => x.length >= 5 && (n.startsWith(x + " ") || n === x));
  return k ? { key: k, entry: E[k]! } : null;
}

export const GLOSSARY_SIZE = KEYS.length;
