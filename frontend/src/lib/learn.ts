import { MENU_ORDER, MENU_TITLES, TOOLS, type MenuId, type Tool } from "./tools";

/**
 * The Learn page's teaching text: one lesson for every tool in lib/tools.ts, plus a short "start here" course on the ideas the tools share.
 *
 * Every worked example uses small round numbers chosen so the arithmetic can be followed by hand. They are illustrations of how to read a tool,
 * never market data and never a forecast. A test (learn.test.tsx) fails if a tool is added without a lesson.
 */
export interface Lesson {
  /** the tool id (lib/tools.ts) or, for the course, a short id */
  id: string;
  /** what question the tool answers, and what it is */
  idea: string;
  /** how to read what is on the page, in the order the eye should go */
  read: string[];
  /** a worked example with round numbers: the situation, then what it means */
  example: { setup: string; reading: string };
  /** the usual ways to misread it */
  watch: string[];
}
export interface Foundation extends Lesson { title: string }

export const HOW_TO_USE =
  "Every page in this app describes what the market has done or is doing. None of them forecasts. A reading is evidence to weigh together with others, never a signal to act on alone. Each page says where its data comes from and how fresh it is: read that line before the numbers.";

export const FOUNDATIONS: Foundation[] = [
  {
    id: "f-option", title: "1. An option, a strike and a lot",
    idea: "A call option (CE) gives its buyer the right to buy NIFTY at a fixed price, the strike, on the expiry date. A put option (PE) gives the right to sell. The price paid for that right is the premium. The seller (writer) collects the premium and takes the obligation.",
    read: ["Each row of the option chain is one strike: the call and the put at that price.", "Premium is quoted in index points. One NIFTY lot is 65 units, so a premium of 100 points costs 100 × 65 = ₹6,500 per lot.", "A call gains when NIFTY rises above the strike plus the premium paid; a put gains when NIFTY falls below the strike minus the premium paid."],
    example: { setup: "NIFTY is 25,350. You buy one lot of the 25,400 call at a premium of 100.", reading: "You paid 100 × 65 = ₹6,500. At expiry the call is worth something only above 25,400, and you break even at 25,400 + 100 = 25,500. At 25,600 it is worth 200 points, a profit of 100 points = ₹6,500. Below 25,400 it expires worthless and you lose the ₹6,500." },
    watch: ["Buyers can lose only the premium; sellers' losses are not capped. That asymmetry is why the tools here spend so much time on sellers' risk.", "ATM means at the money (strike nearest spot), ITM in the money, OTM out of the money."],
  },
  {
    id: "f-oi", title: "2. Open interest and volume",
    idea: "Volume counts contracts traded during a period. Open interest (OI) counts contracts still open, not yet closed or expired. Volume is a flow; OI is a stock.",
    read: ["OI change in this app is today's OI minus the previous day's OI, computed locally (the broker's own change field is a price change, not an OI change).", "OI and volume are in units; divide by 65 for lots.", "A trade creates OI only when a new buyer meets a new seller. If an existing holder sells to a new buyer, volume rises and OI does not."],
    example: { setup: "The 25,500 call had OI of 15 lakh units yesterday and 20 lakh today.", reading: "OI change is +5 lakh units (about 7,700 lots): new calls were opened there. The data cannot say whether buyers or writers opened them; it only says the positions exist. Heavy OI at a strike is usually read as a level the market has strong opinions about." },
    watch: ["OI never tells you who is long and who is short. Every contract has both.", "A rising OI with rising price and a rising OI with falling price mean very different things: see OI Buildup."],
  },
  {
    id: "f-iv", title: "3. Implied volatility",
    idea: "Implied volatility (IV) is the volatility the option's price implies: the market's price for movement. It is quoted as an annual percentage. Higher IV means dearer options.",
    read: ["IV is solved from the option's price with a model (Black-76 here); it is not observed directly.", "One-day move implied by IV ≈ spot × IV ÷ √252 (252 trading days in a year).", "IV rank and IV percentile tell you whether today's IV is high or low compared with its own past year."],
    example: { setup: "NIFTY 25,000 and at-the-money IV 16%.", reading: "The one-day implied move is 25,000 × 0.16 ÷ √252 = 25,000 × 0.16 ÷ 15.87 ≈ 252 points. The options market is pricing a typical day of about ±250 points. If NIFTY routinely moves 120, options are rich; if it moves 400, they were cheap." },
    watch: ["IV is not a prediction of direction, only of the size of movement.", "Weekly expiry IV carries expiry-day effects; do not compare it blindly with monthly IV."],
  },
  {
    id: "f-greeks", title: "4. The Greeks: delta, gamma, theta, vega",
    idea: "The Greeks say how an option's price changes when one thing changes and the rest stay still.",
    read: ["Delta: price change per 1 point of NIFTY. A call is between 0 and 1, a put between −1 and 0. About 0.5 at the money.", "Gamma: how fast delta itself changes. Highest at the money, and biggest close to expiry.", "Theta: price lost per day from time passing. Sellers earn it, buyers pay it.", "Vega: price change per 1 point of IV."],
    example: { setup: "You sold one lot (65) of a call with delta 0.50, gamma 0.002, theta −6 per day, vega 9.", reading: "Position delta is −0.5 × 65 = −32.5: you lose ₹32.5 for each point NIFTY rises. If NIFTY rises 100 points, delta grows by about 0.002 × 100 = 0.2 (gamma hurting you), so the loss accelerates. You earn theta of 6 × 65 = ₹390 a day if nothing moves. If IV rises 2 points you lose 9 × 2 × 65 = ₹1,170." },
    watch: ["Greeks are local: they describe small moves. A big move changes them.", "A short option collects theta and pays for gamma and vega. That trade-off is the whole story of option selling."],
  },
  {
    id: "f-straddle", title: "5. The straddle and the implied move",
    idea: "A straddle is a call and a put at the same strike. Its price is the market's estimate of how far NIFTY will move by expiry in either direction.",
    read: ["Straddle price ≈ implied move in points (roughly 0.8 × the 1σ move).", "Break-evens are the strike plus and minus the premium.", "A seller of the straddle profits if NIFTY stays inside the break-evens and when premium decays."],
    example: { setup: "NIFTY 25,350. The 25,350 call costs 110 and the put 100.", reading: "The straddle costs 210 points (₹13,650 per lot). Break-evens are 25,350 ± 210 = 25,140 and 25,560. A buyer needs a move larger than 210 points either way; a seller wants less." },
    watch: ["Selling straddles is unlimited-risk; the Forward Test page paper-trades the idea so you can see the real distribution of outcomes."],
  },
  {
    id: "f-futures", title: "6. Futures, basis and buildup",
    idea: "A future is an obligation to buy or sell NIFTY at a date. Its price sits a little above spot: the gap is the basis (future − spot), mostly the cost of carrying money until expiry.",
    read: ["A basis that is larger than usual suggests eager buying; a shrinking or negative basis suggests selling or hedging.", "Price and OI together give four stories: price up + OI up = long buildup; price down + OI up = short buildup; price up + OI down = short covering; price down + OI down = long unwinding."],
    example: { setup: "Spot 25,350, current-month future 25,420, OI up 1 lakh units in the last 15 minutes and price up 20 points.", reading: "Basis is +70. Price up with OI up is a long buildup: new buyers are entering, not just shorts closing." },
    watch: ["Basis moves with interest rates and days to expiry too. Compare today with the page's own history rather than with a fixed number."],
  },
  {
    id: "f-stats", title: "7. Reading numbers honestly",
    idea: "Four habits keep the tools from fooling you.",
    read: ["Sample size: a pattern seen on three days is a story, not a result.", "Missing is not zero: when the app has no value, it shows a dash, not 0.", "Freshness: each page shows the time of its data. A stale value is flagged, not hidden.", "Descriptive versus validated: only labels that have passed a pre-set test are called validated. Most are descriptive."],
    example: { setup: "A signal fired 40 times; the market rose afterwards 24 times.", reading: "24 of 40 is 60%, but the 95% range for a true rate with 40 trials runs from about 44% to 74%. A fair coin sits inside that range. The honest statement is: not distinguishable from chance. The Signal Backtest page puts such ranges beside every result for this reason." },
    watch: ["Be most suspicious of the tool that agrees with what you already believe."],
  },
];

export const LESSONS: Lesson[] = [
  // ---------------- FNO Tools: Live chain and OI
  {
    id: "option-chain",
    idea: "The option chain is the price list of every NIFTY option for one expiry: for each strike the call and the put, with price, open interest, volume and IV. It is the source for almost every other tool.",
    read: ["Find the row nearest spot: that is the at-the-money strike.", "Calls with strikes above spot and puts with strikes below spot are out of the money; these carry most of the positioning.", "Read price, then OI and its change, then IV across a few rows to see the shape, not a single number.", "The live stream is overlaid on the stored snapshot; the status pill shows whether the stream is live or the page is showing a snapshot."],
    example: { setup: "Spot 25,350. The 25,500 call shows OI 20 lakh (+5 lakh today) and the 25,200 put shows OI 18 lakh (+2 lakh).", reading: "Many calls are open 150 points above spot and many puts 150 below. Participants have positioned for a range of roughly 25,200 to 25,500. Rising call OI at 25,500 means that level is becoming a stronger ceiling in the market's mind, if those calls were written." },
    watch: ["Large OI at a strike marks interest, not a guarantee that price stops there.", "Check the data-age line: a chain from the stored snapshot is not live."],
  },
  {
    id: "open-interest",
    idea: "Shows where open positions sit by strike, how they changed today, how concentrated they are, and the total call and put OI. It answers: where is the market positioned?",
    read: ["Tallest call bars above spot are the likeliest resistance; tallest put bars below spot the likeliest support.", "OI change shows what is new today: a level with falling OI is being abandoned.", "Concentration says whether OI is piled on a few strikes or spread out. Piled-up OI makes sharper levels.", "Total call and total put OI and their change show the overall tilt."],
    example: { setup: "Call OI is largest at 25,500 (40 lakh) and put OI largest at 25,200 (35 lakh). Spot 25,350.", reading: "Writers have most to defend at 25,500 above and 25,200 below. If NIFTY nears 25,500 and the call OI there starts falling, writers are covering and the ceiling is weakening." },
    watch: ["OI cannot show who is long. A big put OI can be buyers hedging or writers earning premium.", "After expiry the OI is reset, so compare within an expiry."],
  },
  {
    id: "multi-oi-volume",
    idea: "Plots total call OI, put OI, their changes and volume through the session, so you can see how positioning built over time instead of only the end-of-day picture.",
    read: ["Look at the slope: which line is rising faster, calls or puts?", "Volume spikes with little OI change mean existing positions changing hands.", "Use the replay bar to scrub the session on one shared clock."],
    example: { setup: "Between 10:00 and 12:00 total put OI rises 8 lakh while total call OI is flat.", reading: "More puts were opened than calls. If the price held steady, that is consistent with put writing under the market, a supportive reading. If price fell while put OI rose, the puts may be buyers hedging a fall." },
    watch: ["Totals mix every strike. Check Open Interest by strike to see where the change happened."],
  },
  {
    id: "put-call-ratio",
    idea: "The put-call ratio (PCR) is put OI divided by call OI. It is a one-number summary of whether the book leans to puts or calls.",
    read: ["PCR above 1: more put OI than call OI. Below 1: more calls.", "ATM PCR looks only at the strikes near spot, where the action is. Overall PCR includes far strikes.", "The trend chart shows how the ratio moved during the session; direction of change matters more than the level."],
    example: { setup: "Call OI 100 lakh, put OI 120 lakh.", reading: "PCR = 120 ÷ 100 = 1.2. If an hour later put OI is 130 and call OI 100, PCR is 1.3: the tilt toward puts is growing." },
    watch: ["A high PCR is often read as supportive (puts written as a floor), but it can also be fear. Treat it as context.", "PCR levels differ by expiry and index: compare the same chain over time, not to a textbook figure."],
  },
  {
    id: "max-pain",
    idea: "Max pain is the expiry price at which option buyers, taken together, would collect the least. The page also lists the highest call and put OI strikes and other key levels.",
    read: ["Max pain is computed from OI at every strike, using intrinsic value at a hypothetical settlement.", "Highest call OI and highest put OI strikes bracket the range the market has bet on."],
    example: { setup: "Three strikes with OI in lakh. Calls: 25,400 = 10, 25,500 = 20, 25,600 = 30. Puts: 25,400 = 30, 25,500 = 20, 25,600 = 10.", reading: "If NIFTY settled at 25,400, total payout to buyers is puts only: 20 × 100 + 10 × 200 = 4,000. At 25,500: calls 10 × 100 + puts 10 × 100 = 2,000. At 25,600: calls 10 × 200 + 20 × 100 = 4,000. The minimum is 2,000 at 25,500, so max pain is 25,500." },
    watch: ["Max pain is a description of OI, not a force that pulls price. Do not treat it as a target.", "It changes every time OI changes."],
  },
  {
    id: "gamma-exposure",
    idea: "Gamma exposure (GEX) estimates how much hedging pressure option positions create. Where net gamma is positive, hedging tends to calm price; where it is negative, hedging tends to amplify moves. The sign uses a convention (calls positive, puts negative), so this is a model reading, not an observed position.",
    read: ["Regime: positive or negative net gamma overall.", "Gamma flip: the price where net gamma changes sign. Above it hedging dampens; below it hedging can amplify.", "Call wall and put wall: strikes with the largest gamma on each side, likely pinning or friction levels.", "The strike table and the session structure chart show how this changed through the day."],
    example: { setup: "Gamma flip 25,200, call wall 26,000, put wall 25,000, spot 25,350.", reading: "Spot is above the flip, so the model leans toward muted, range-like trade between the walls. If NIFTY fell below 25,200, hedging could start to add to the fall, so moves may be faster." },
    watch: ["The sign convention is an assumption. Real dealer positions are not observed.", "Gamma is largest near expiry; its levels shift quickly as spot and time change."],
  },
  {
    id: "pe-ce-difference",
    idea: "Put minus call open interest, OI change and volume, strike by strike. It condenses the two sides of the chain into one bar per strike.",
    read: ["Positive bar: more put than call at that strike. Negative: more call.", "Use the OI-change version to see what is new today.", "Bars on one side of spot stacking in one direction show a tilt."],
    example: { setup: "Strike 25,400: put OI change +3 lakh, call OI change −1 lakh.", reading: "Put minus call change is +3 − (−1) = +4 lakh: puts were added and calls were unwound there. Several such strikes below spot suggest support is being built." },
    watch: ["A bar is a net: a big positive can hide large positions on both sides.", "Same caveat as all OI: it does not show who is long or short."],
  },
  {
    id: "smart-oi",
    idea: "Inside every 1, 3, 5 or 15 minute candle, Smart OI shows put OI change minus call OI change, beside the NIFTY candle. It shows which side positions were added on, minute by minute.",
    read: ["Positive columns: puts were added faster than calls in that candle. Negative: calls faster.", "Compare the column with the candle: positioning that goes against the price is the interesting case.", "Day change and PCR sit beside the chart for context."],
    example: { setup: "In a 5-minute candle put OI change is +2 lakh and call OI change +0.5 lakh, while NIFTY rises 15 points.", reading: "Net +1.5 lakh toward puts while price rises: put writers are adding below a rising market, which fits an orderly advance. If price fell during that candle, the same number could instead be protective put buying." },
    watch: ["The number alone is ambiguous; always read it with the price direction.", "One candle is noise. Look for several candles in the same direction."],
  },
  {
    id: "oi-buildup",
    idea: "Classifies every strike into long buildup, short buildup, short covering or long unwinding from how that contract's price and OI moved.",
    read: ["Price up and OI up: long buildup. Price down and OI up: short buildup.", "Price up and OI down: short covering. Price down and OI down: long unwinding.", "Sort by the size of the OI change to find where the real activity is."],
    example: { setup: "The 25,500 call premium rises from 80 to 95 while its OI rises 3 lakh.", reading: "Price up with OI up: a long buildup in that call; buyers are adding. If the premium had risen while OI fell, it would be short covering: writers closing their position and pushing price up." },
    watch: ["It labels the contract, not the market. A call long buildup is bullish for the call, but the call's price also moves with IV and time.", "Labels flip in minutes in volatile spells; use them together with the trend of several readings."],
  },
  {
    id: "vega-analysis",
    idea: "Vega is how much an option's price changes for each 1 point change in IV. The page shows call and put vega across a window of strikes, how it moved since a baseline, statistics and a plain-language reading.",
    read: ["Highest vega is at the money; far strikes have little.", "The anchored band shows the vega change since a baseline time you pick.", "Replay lets you watch it through the session."],
    example: { setup: "ATM call vega 10 points per IV point, one lot 65 units. IV rises from 14 to 15.", reading: "Premium rises by about 10 points, ₹650 per lot, with no change in NIFTY. A seller of 10 lots of such options loses ₹6,500 from that IV rise alone." },
    watch: ["Vega falls as expiry nears, so a short-dated option reacts less to IV.", "IV moves are not independent of price moves: IV usually rises when the market falls."],
  },
  // ---------------- Price tools
  {
    id: "straddle",
    idea: "Plots the at-the-money call plus put premium over the session. It is the clearest way to see how the options market's expected move is changing, and how fast time value is leaking.",
    read: ["A rising line means options are getting dearer (IV up or a big move); a falling line means decay.", "On a quiet day the line drifts down steadily. A sudden rise is news or a sharp move.", "The ATM strike changes as spot moves; read the strike shown beside the chart."],
    example: { setup: "At 09:30 the ATM straddle is 210. At 12:30 it is 195 with NIFTY unchanged.", reading: "It lost 15 points in three hours, about 5 an hour: that is time decay (and a small IV fall). A seller who sold at 210 is up 15 points = ₹975 per lot, before costs." },
    watch: ["When spot moves, the ATM strike jumps and the line jumps with it. The Rolling Straddle page removes those jumps.", "Day-of-expiry decay is much faster than mid-week decay."],
  },
  {
    id: "premium-decay",
    idea: "Shows how option premiums decay through the day, strike by strike. It answers: how much of the premium is time value being worn away?",
    read: ["Compare the decay of ATM with OTM strikes: ATM loses more points, OTM loses a larger share.", "A straight downward slope means normal decay; a bump means IV or price rose."],
    example: { setup: "ATM call 100 at 09:30 and 88 at 13:30; the 25,600 call 30 and 22 over the same hours.", reading: "ATM lost 12 points (12%), the OTM lost 8 points (27%). Percentage decay is usually bigger for far strikes, because they are nearly all time value." },
    watch: ["Premium change also contains the effect of price moving. Decay is clean only when spot is flat."],
  },
  {
    id: "price-vs-oi",
    idea: "Pick one strike and see its call and put price against its OI and OI change through the session, to read whether participants were adding or leaving that strike as price moved.",
    read: ["Price rising with OI rising shows fresh buying or fresh writing in that contract.", "Price rising with OI falling shows covering.", "Use calls and puts of the same strike to compare."],
    example: { setup: "The 25,300 put premium falls from 90 to 60 over the morning while its OI grows by 4 lakh.", reading: "Price down and OI up in the put: a short buildup. Writers are adding puts as the market rises, a supportive floor." },
    watch: ["Choose a strike near spot; deep OTM strikes trade rarely and tell little."],
  },
  {
    id: "multistrike-chart",
    idea: "Put the price, OI or OI change of several strikes on one chart, calls and puts side by side, to compare how neighbouring strikes behaved.",
    read: ["Select the strikes and the measure first; the legend names each line.", "Lines that diverge show where the action was.", "OI change lines are best to find which strike the market chose."],
    example: { setup: "You plot OI change for the 25,300, 25,400 and 25,500 calls. The 25,400 line climbs +6 lakh; the others are near 0.", reading: "New call positions were concentrated at 25,400. That is the strike participants have chosen as a boundary today." },
    watch: ["Too many lines make a chart unreadable; use three to five strikes."],
  },
  {
    id: "rolling-straddle",
    idea: "The straddle of the strike you would hold as spot moves. Rolling follows ATM; Fixed holds the opening strike. The roll-adjusted premium removes the jumps caused by changing strikes, so you see real decay.",
    read: ["Rolling versus fixed: when spot has moved far from the opening strike, the fixed straddle is mostly delta (direction), not decay.", "Roll-adjusted premium: a line without jumps that shows how the premium changed excluding rolls.", "Implied move and break-even band: the range the straddle prices.", "The roll list shows every roll and its credit or debit."],
    example: { setup: "You sell the 25,150 straddle at 200 at the open. By afternoon spot is 25,385. The fixed straddle is worth 243; the ATM rolling straddle (25,400) is 197.", reading: "The fixed position is down 43 points, but that is mostly the market moving away (direction), not a pricing error or poor decay. The rolling ATM line shows premium roughly unchanged at 197 versus 200. Mixing the two would mislead you: that is why the page keeps them apart." },
    watch: ["A position that is far from spot is a directional bet, not a decay trade.", "Rolling has costs not shown here (spread, slippage, charges)."],
  },
  {
    id: "multi-straddle",
    idea: "Overlays the straddle prices of several strikes on one chart.",
    read: ["Each line is one strike's call + put.", "Lines normally keep a gap that equals the difference in distance from spot.", "A line that crosses another shows IV changing unevenly by strike."],
    example: { setup: "25,300 straddle 230, 25,400 straddle 215, 25,500 straddle 240 with NIFTY at 25,400.", reading: "The 25,400 (ATM) straddle is the cheapest because it has the least intrinsic value; the strikes on either side carry intrinsic value plus time value. Selling the straddle that is nearest spot brings in the least premium but the least directional risk." },
    watch: ["Comparing straddles of different strikes also compares different deltas: it is not a like-for-like decay comparison."],
  },
  // ---------------- Positioning
  {
    id: "signal-backtest",
    idea: "Tests signals (skew, IV momentum, OI, butterfly, gamma) against what NIFTY did next, in time order and out of sample, with the sample size and a confidence range beside every result. It tells you which signals have earned trust, and which are only stories.",
    read: ["Read the number of observations first. Small samples cannot support a claim.", "The range (confidence interval) beside the hit rate matters more than the hit rate: if it includes 50%, the signal is not distinguished from chance.", "The page also lists what it could not test with the data stored today."],
    example: { setup: "A signal fired 40 times and the market moved the signalled way 24 times (60%).", reading: "The 95% range is about 44% to 74%. It contains 50%, so the result is consistent with luck. Needing 100 or 200 observations before believing it is the right habit." },
    watch: ["A good backtest says how a rule would have behaved, not how it will. Costs and the regime can change.", "Backtests on short stored history are weak by construction."],
  },
  {
    id: "market-structure",
    idea: "One page that combines regime, volatility, positioning and gamma into sections, each with the evidence for and against its reading, and a data-quality check at the end.",
    read: ["A is the market snapshot; B volatility intelligence; C options positioning over the last 15 minutes; D gamma intelligence; E market interpretation and data quality.", "Within each section read the evidence list: it shows both supporting and contradicting items.", "Read section E first if numbers look odd: it flags stale or incomplete inputs."],
    example: { setup: "A says trending down; C shows puts being closed and calls being added; D shows negative gamma.", reading: "Three sections agree on a weak, volatile, falling market, so the combined picture is coherent. If C showed puts being added while A said trending down, you have a disagreement worth understanding before acting." },
    watch: ["The regime is rule-based and describes the last 15 minutes. It is not validated as a predictor."],
  },
  {
    id: "strike-positioning",
    idea: "Strike-by-strike changes in premium, OI, volume, IV and delta, an OTM demand reading, and premium baskets, with every label tied to its evidence.",
    read: ["Strike by strike table: scan for strikes where several measures moved together.", "OTM positioning and demand reading: which side's out-of-the-money options are being bought or written.", "Premium baskets add up the premium of fixed or dynamic groups of strikes, so you can see the total cost of exposure and its asymmetry between calls and puts."],
    example: { setup: "OTM put premiums fall 10% while OTM call premiums rise 15% and OTM call volume spikes.", reading: "Upside OTM calls are in demand while downside protection is being sold. That is a bullish tilt in positioning. The evidence column shows the numbers behind the label so you can check it." },
    watch: ["Premium moves with IV and time as well as demand: the page separates these where it can."],
  },
  // ---------------- IV tools
  {
    id: "iv-momentum",
    idea: "Compares how call IV and put IV changed over 1 minute to 1 hour and since the previous close, at the money and at 25 and 10 delta. It shows which side of the market is paying up for protection or for upside.",
    read: ["Rising put IV relative to call IV shows demand for downside protection.", "Rising call IV relative to put IV shows chasing upside.", "Check the span: a 1-minute change is noise, 15 minutes to 1 hour carries more weight."],
    example: { setup: "Over 30 minutes ATM call IV rises 0.2 points while the 25-delta put IV rises 1.0 point.", reading: "Downside puts are being bid more than calls: participants are paying for protection. If NIFTY is flat while this happens, the market is nervous without moving yet." },
    watch: ["IV changes are linked to price: a falling market raises put IV mechanically."],
  },
  {
    id: "volatility-skew",
    idea: "The volatility smile: IV across strikes. Skew measures how different put IV and call IV are at the same distance from the money.",
    read: ["Normal equity-index shape: put IV above call IV (a downward-sloping smile), because investors pay for protection.", "25-delta and 10-delta skew and butterfly each have their definition printed beside the number.", "Term structure shows IV across expiries: a steeply rising curve means calm now and more uncertainty later; an inverted one means stress now."],
    example: { setup: "ATM IV 14%, 25-delta put IV 16%, 25-delta call IV 13%.", reading: "Put minus call skew is 3 points: protection is richer than upside. If next week skew widens to 5 points while spot is unchanged, demand for downside protection is rising." },
    watch: ["Skew levels differ by expiry. Compare the same expiry through time."],
  },
  {
    id: "iv-hvp",
    idea: "India VIX against historical volatility, with IV rank and IV percentile, and NIFTY as the price line. It places today's volatility in its own history.",
    read: ["IV rank: (today − lowest) ÷ (highest − lowest) over the lookback. IV percentile: the share of days IV was below today's.", "VIX far above HV means options are rich compared with realised movement; below means cheap.", "Compare the price line: a volatility rise with a falling price is the usual fear pattern."],
    example: { setup: "VIX is 14. Over the past year it ranged from 10 to 20.", reading: "IV rank = (14 − 10) ÷ (20 − 10) = 40%. Mid-range: neither expensive nor cheap. If VIX were 19 the rank would be 90%: options historically dear, which favours sellers on average but with fatter risks." },
    watch: ["Rank and percentile can differ a lot if one spike set the year's high.", "VIX measures one-month expectation, not the weekly expiry."],
  },
  {
    id: "iv-hv",
    idea: "At-the-money implied volatility against historical (realised) volatility over 10, 20, 30 and 60 days from stored daily closes. The gap is the volatility risk premium.",
    read: ["IV above HV: options priced for more movement than recently happened; sellers have collected a premium on average.", "IV below HV: options are cheap relative to recent movement.", "Check which HV window you compare with: the 10-day is jumpier."],
    example: { setup: "ATM IV 14%, HV20 11%.", reading: "The gap is +3 points: the market pays 3 volatility points above what NIFTY has actually delivered over 20 days. That rich premium is what option sellers try to earn." },
    watch: ["Realised volatility looks backwards; a calm month can end suddenly."],
  },
  {
    id: "iv-intraday",
    idea: "At-the-money IV through the session, one value per stored snapshot.",
    read: ["A smooth drift is normal. Sharp jumps follow news or a big move.", "IV usually falls into the afternoon on quiet days.", "Compare with the straddle chart: the straddle falls from decay and IV together."],
    example: { setup: "ATM IV is 15.0% at 09:30, 14.2% at 12:00 and 14.1% at 14:30 with NIFTY in a tight range.", reading: "Most of the IV compression happened in the morning, then it flattened. A seller's gain from falling IV mostly arrived early." },
    watch: ["One value per snapshot: gaps in storage show as gaps in the line."],
  },
  // ---------------- Futures
  {
    id: "future-dashboard",
    idea: "NIFTY futures at a glance: the spot-futures gap (basis), open interest, OI change and volume.",
    read: ["Basis: future minus spot. It normally narrows toward expiry.", "OI and OI change show whether positions are being built or closed.", "Volume shows participation."],
    example: { setup: "Spot 25,350, future 25,420, OI +1.2 lakh units today, volume rising.", reading: "Basis +70 with rising OI and volume is consistent with active buying. A basis dropping to +30 while OI rises would point to selling pressure in futures." },
    watch: ["The basis has a normal level that depends on interest and days to expiry."],
  },
  {
    id: "future-intraday",
    idea: "The future against spot through the session, with its volume.",
    read: ["The gap line moving up shows futures buying ahead of spot; moving down shows selling.", "Volume bars show when participation arrived."],
    example: { setup: "At 10:00 the gap is +60; by 11:00 it is +85 on heavy volume.", reading: "Futures are bid more strongly than spot in that hour: leveraged participants are buying. If price then fails to follow, the buying may have been short covering." },
    watch: ["Basis drifts lower into expiry on its own."],
  },
  {
    id: "future-flow",
    idea: "Estimates net buying in the current-month future from its own trades and order book (estimated net buying, book imbalance), and shows how the top-5 heavyweights are doing.",
    read: ["Estimated net buying: whether trades were mostly at the ask (buyers) or at the bid (sellers).", "Book imbalance: more depth on the bid than on the ask suggests support.", "Heavyweights: the five biggest NIFTY stocks often decide the index in a day."],
    example: { setup: "Net buying positive for 30 minutes, book imbalance leaning to bids, and four of the top five stocks up.", reading: "Flow, depth and the heavyweights agree on buying. If NIFTY is flat while the heavyweights are up, other stocks must be falling." },
    watch: ["The flow is estimated, not reported by the exchange; treat it as an approximation."],
  },
  {
    id: "future-sectors",
    idea: "Equal-weighted NIFTY 500 sector strength against the index, with rotation. It shows which sectors lead and which lag.",
    read: ["Bars above the index line outperform it.", "Rotation shows the rank change since earlier.", "Equal weights avoid the largest company dominating a sector."],
    example: { setup: "Banks +1.2%, IT −0.5%, NIFTY +0.3%.", reading: "Banks lead and IT drags. The index rises only slightly even though banks are strong, because the rest is weak." },
    watch: ["Sector moves are not forecasts. Use them to understand why the index did what it did."],
  },
  {
    id: "market-movers",
    idea: "NIFTY 50 stocks ranked by move and by contribution to the index.",
    read: ["Rank by percentage move to see the leaders; rank by contribution to see what moved the index.", "A small stock with a big move contributes little."],
    example: { setup: "A stock with weight 13% rises 1% while the index is at 25,000.", reading: "Contribution = 0.13 × 0.01 × 25,000 = 32.5 index points. A stock with weight 1% that rises 5% adds only 0.01 × 0.05 × 25,000 = 12.5 points." },
    watch: ["Only NIFTY 50 stocks appear here, by design."],
  },
  {
    id: "future-oi",
    idea: "NIFTY futures open interest and its change over time.",
    read: ["Rising OI shows new positions entering; falling OI shows closing.", "Month-end rollover moves OI from the current to the next month: do not read that as a view."],
    example: { setup: "Futures OI grows 2 lakh units during a rising session.", reading: "New positions are being added in a rising market. Combined with the price direction it is a long buildup." },
    watch: ["OI near expiry reflects rollover as well as positioning."],
  },
  {
    id: "future-price-oi",
    idea: "NIFTY future price against OI, classified every 15 minutes and for the session as long buildup, short buildup, short covering or long unwinding.",
    read: ["Each row of the table is a 15-minute window with its class.", "The session row sums the whole day.", "Long runs of the same class show a persistent theme."],
    example: { setup: "Three consecutive windows are short buildup, price falls 60 points in total, OI +1.5 lakh.", reading: "New shorts are being added into a fall: the move is being driven by fresh selling, not just buyers leaving. A switch to short covering would suggest the fall is losing momentum." },
    watch: ["Class labels depend on the sign of two small changes; a flat window can flip between classes."],
  },
  // ---------------- Analyse
  {
    id: "eagles-view",
    idea: "One board for everything you watch. Every tool of the app is a small box you can add, move, resize and remove, and the same tool can be on the board as many times as you like. It answers: what do all my tools say at the same time?",
    read: ["Press Add widgets, search or pick from the groups, and press the same one again for a second copy. The number next to a tool says how many are on the board.", "Drag a title bar to move a box, drag a corner to resize it. Chart widgets redraw to fit the box; a whole tool (its controls and charts) scrolls inside its box.", "Auto-fit packs the boxes with no gaps and lets them grow into free space; switch it off to place boxes exactly where you drop them.", "The expiry and strikes at the top apply to every box that reads the option chain. The board is remembered in this browser."],
    example: { setup: "You put the Market Intelligence day board, Trend & Regime, the ATM straddle and Smart OI side by side.", reading: "At a turn you can see the verdict, the regime label, the premium and the OI change on one screen, and judge whether two or three of them agree, instead of opening four pages." },
    watch: ["More boxes is not more evidence: tools that read the same prices and open interest move together.", "A box shows what its own page shows, with the same limits: the regime labels describe the last hour and do not predict.", "Every open box fetches its own data: a very large board is slower on a phone."],
  },
  {
    id: "advanced-greeks",
    idea: "The Greeks of your own option legs in rupees by leg, expiry and limit, the gamma map and the volatility surface. It answers: what is my position's real exposure right now?",
    read: ["Delta in rupees: gain or loss per index point. Gamma: how that changes. Theta: rupees per day. Vega: rupees per IV point.", "Check the limits: the page compares exposure with the limits you set.", "The gamma map shows how total gamma changes if NIFTY moves; the surface shows IV by strike and expiry."],
    example: { setup: "You are short one lot (65) of 25,400 call (delta 0.45, theta −5, vega 9) and one lot of 25,300 put (delta −0.35, theta −5, vega 9).", reading: "Net delta = (−0.45 + 0.35) × 65 ≈ −6.5 (nearly neutral). Theta income = 5 × 65 × 2 = ₹650 a day. Vega = −9 × 65 × 2 = −₹1,170 per IV point: if IV rises 2 points you lose about ₹2,340 even if NIFTY does not move." },
    watch: ["Greeks are local: a large move changes them, especially gamma.", "Scenario testing (changes in index, volatility, time, rates) lives in the Strategy Builder."],
  },
  {
    id: "market-regime",
    idea: "Is the session trending or range-bound? Four readings (efficiency ratio, ADX, R² of a straight line and the choppiness index) are scored and averaged into a trend score. The label, the agreement count and the reasons are shown with the regime shaded behind the NIFTY candles.",
    read: ["The top card: the regime now, the 0 to 100 trend score, and how many of the four readings agree.", "The chart: candles, the session mean, the opening range, the score and ADX with +DI and −DI, with the regime shaded behind. The colour key under the chart explains every colour.", "Time in each regime and what followed each label complete the page."],
    example: { setup: "Trend score 88, 4 of 4 readings agree, label Trending down, ADX 48, −DI above +DI.", reading: "All four independent readings say a clean, strong move, and the DI lines say it is down. The shaded red band behind the candles shows when. Short blue or grey gaps mean pauses where the score fell below 45." },
    watch: ["The score has no direction: a clean rise and a clean fall both score high. Direction comes from slope and DI.", "Descriptive, not validated: it describes the last hour, it does not predict the next."],
  },
  {
    id: "trend-strength",
    idea: "The four ingredients of the score, one chart each: efficiency ratio, ADX with +DI and −DI, R² of a straight-line fit, and the slope.",
    read: ["Each panel has two dashed lines on the right: no trend and full trend. The score is 0 at the first and 1 at the second.", "Beige band: the trending side. Blue band: the no-trend side.", "ADX is smooth and lags; efficiency ratio and R² react faster."],
    example: { setup: "Closes 100, 101, 102, 103 versus 100, 103, 99, 102.", reading: "Efficiency ratio (net move ÷ distance walked): the first is 3 ÷ 3 = 1; the second is 2 ÷ (3 + 4 + 3) = 0.2. R² of a straight line through the bar numbers: the first is exactly 1, the second only 0.02. Both say the first path is clean and the second is noise." },
    watch: ["Efficiency ratio and R² ignore direction by construction. Slope and DI supply it.", "ADX can stay high after a trend pauses, because it is smoothed."],
  },
  {
    id: "chop-variance",
    idea: "Two tests of whether moves continue or reverse. The choppiness index measures how much a path wanders compared with the ground it covers. The variance ratio (Lo–MacKinlay) compares the variance of multi-bar moves with that of single-bar moves.",
    read: ["Choppiness: below 38.2 is trending, above 61.8 is choppy.", "Variance ratio: 1 is a random walk. Above 1 moves tend to continue; below 1 they tend to reverse. Only the robust z* with |z*| of at least 1.96 (5% level) is colour-coded.", "Read the table: each horizon has VR, z, the robust z* and a plain label."],
    example: { setup: "Over the session, the 2-bar variance ratio is 1.13 (z* 3.7) and the 4-bar ratio is 0.54 (z* −7.5).", reading: "Two-bar moves continued (a push tends to carry on briefly) but four-bar moves reversed (a bounce followed each leg). A trending-down day made of steps and retracements looks exactly like this." },
    watch: ["A single short session gives wide uncertainty. The table says which readings are statistically distinguishable from chance.", "Intraday returns do not have constant variance, so the robust z* is the one to read."],
  },
  {
    id: "session-structure",
    idea: "NIFTY against its session mean and the future's volume-weighted price (VWAP), with how much time was spent above, crossings, the longest stay and the distance in ATRs.",
    read: ["The session mean is the running average of the closes so far; the dotted lines are ±1 standard deviation.", "The future's VWAP is volume-weighted and shifted to index level using the latest basis.", "Bars show the distance from the mean in ATRs (typical bar ranges). Beyond about 2 means stretched."],
    example: { setup: "0% of bars closed above the mean, 0 crossings, 71 bars below, distance −6.4 ATRs.", reading: "Price never recovered the average all day: a one-sided session. Many crossings, instead, would mean rotation around fair value." },
    watch: ["The mean moves slowly late in the day, so a large distance can persist without meaning a snap-back is due."],
  },
  {
    id: "opening-range",
    idea: "The high and low of the first 5, 15 or 30 minutes, and what price did with them: breakouts, failed breakouts and where price sits now.",
    read: ["The beige box is the opening range. Dashed lines are OR high and OR low.", "Bars show how far each close is beyond the range; zero means inside.", "Stats: first break time, furthest excursion, closes outside, breakouts and failed breakouts."],
    example: { setup: "15-minute range 25,670 to 25,990 (320 points). The first close below the range was at 09:32 and price stayed below, reaching 305 points under the low.", reading: "A decisive break with no return. Four 'failed breakouts' show attempts that closed back inside; none succeeded." },
    watch: ["Judge whether the range is wide or narrow by comparing it with the day's expected range (see Range Used vs Implied Move), not by eye."],
  },
  {
    id: "range-used",
    idea: "How much of a normal day's range, as the options price it, has already been used. The implied range comes from the at-the-money IV: 1.5958 × spot × IV ÷ √252 (the expected high-low of a driftless random walk).",
    read: ["The black line is today's range so far; the dashed line is what the options expected by this time of day.", "Pace is the ratio of the two: 1 means on the implied path; above 1.25 means running hot; below 0.75, quiet.", "Range used is the percentage of the whole-day expectation already spent."],
    example: { setup: "Spot 25,350, IV 16.9%, range so far 644 points, one-day sigma 270 points.", reading: "Expected full-day range is 1.5958 × 270 ≈ 431 points. Range used = 644 ÷ 431 = 149%. The day has already beaten what options priced. After such a day, a further large move is less likely than at the start, though not impossible." },
    watch: ["Uses the live chain, so it works for the newest session only.", "The IV used is the nearest weekly's at the time of the reading, a stated approximation."],
  },
  {
    id: "gamma-regime",
    idea: "The gamma exposure summary on the Trend & Regime tab: positive or negative net gamma from the live chain, the flip level and the walls.",
    read: ["Regime name and volatility tendency: Positive Gamma suggests dampened, range-like trade; Negative Gamma suggests larger moves.", "Net GEX in rupees crore per 1% move; flip level and its distance from spot.", "The bar chart shows net GEX by strike within 750 points of spot, with spot and flip marked."],
    example: { setup: "Net GEX +2,266 ₹ crore per 1%, flip 25,221, spot 25,349, call wall 26,000, put wall 25,000.", reading: "Spot sits 128 points above the flip in positive gamma. The model's tendency is range-bound movement toward the inner levels. A fall through 25,221 would change the regime to negative." },
    watch: ["The sign convention (calls positive, puts negative) is an assumption, so this is a model reading.", "Works for the newest session only."],
  },
  {
    id: "daily-regime",
    idea: "The same trending-versus-range label on 18 years of daily closes, with a pre-registered study of whether it predicts the next 10 days. The verdict is shown as it came out.",
    read: ["Today's daily label and its four readings.", "The study: after each label, the next 10-day efficiency ratio. If 'Trending' did not produce straighter paths than 'Range-bound', the page says Not validated.", "The long chart shows the last 250 days with the regime shaded."],
    example: { setup: "Trending-minus-Range difference in next-10-day efficiency ratio: −0.074, one-sided permutation p = 0.979.", reading: "The 'trending' label was followed by slightly less clean paths than 'range'. The label failed its own test. The page therefore calls it a description of the last 20 days only." },
    watch: ["A failed test is reported as failed; nothing was tuned to pass. That is the point of fixing the criterion first."],
  },
  {
    id: "fii-dii-summary",
    idea: "Institutional derivatives positioning from the exchange's published data: how FIIs, DIIs, proprietary traders and clients are positioned in index futures and options.",
    read: ["Look at net long or short per participant and its change.", "FII positions in index futures are the most closely watched single series.", "The data is published after the close; the page shows the date it covers."],
    example: { setup: "FII index futures net position moves from −50,000 to −70,000 contracts over a week.", reading: "FIIs added 20,000 contracts of net short: a more bearish stance or more hedging against a long cash portfolio. The page cannot tell which." },
    watch: ["Published once a day; it is not a live feed.", "Positions mix hedges and views."],
  },
  {
    id: "fii-dii-cash",
    idea: "Cash-market buying and selling by FIIs and DIIs, in rupees crore, from the data you import.",
    read: ["Net = buying minus selling. Negative means net selling.", "The 7-session view shows persistence.", "If the day's figures were not collected the page says so rather than showing zero."],
    example: { setup: "FII net −2,500 crore and DII net +2,200 crore.", reading: "Foreign selling was largely absorbed by domestic institutions; the net is only −300 crore across both. Persistent FII selling absorbed by DIIs is a typical pattern." },
    watch: ["Data depends on what you import; check the date shown."],
  },
  {
    id: "index-contributors",
    idea: "Which NIFTY 50 stocks are moving the index, in index points.",
    read: ["Contribution = weight × stock % change × index level.", "The bars add up to roughly the index move.", "A few heavyweights often explain most of the move."],
    example: { setup: "Index 25,000. A stock with weight 13% is up 1%; another with weight 8% is down 0.5%.", reading: "First: 0.13 × 0.01 × 25,000 = +32.5 points. Second: 0.08 × −0.005 × 25,000 = −10 points. Net +22.5 points from these two." },
    watch: ["Weights come from a stated source and date; stale weights give wrong contributions."],
  },
  {
    id: "advance-decline",
    idea: "How many NIFTY 50 stocks are up and how many down: the breadth of the move.",
    read: ["More advances than declines on an up day shows broad strength.", "An index up with more decliners than advancers shows a narrow rally led by a few heavyweights."],
    example: { setup: "NIFTY up 0.5%, 18 stocks up and 32 down.", reading: "Only 18 of 50 rose, yet the index rose: heavyweights carried it. The rally is narrow and more fragile than a broad one." },
    watch: ["Breadth within only 50 stocks is a coarse measure."],
  },
  {
    id: "index-weightage",
    idea: "The NIFTY 50 weights with their source and date.",
    read: ["Weights show how much each stock moves the index.", "Check the date shown: weights drift with prices between rebalances."],
    example: { setup: "A stock has weight 13%.", reading: "A 1% rise in that stock alone moves the index by about 0.13%." },
    watch: ["Weights from an old date can differ from today's."],
  },
  {
    id: "sector-rotation",
    idea: "Sector strength inside NIFTY 50 and how its rank changed.",
    read: ["Bars show each sector's move; the rank change shows rotation.", "Rotation into defensives with the index flat can mean caution."],
    example: { setup: "Banks rank 5th in the morning and 1st by afternoon; IT falls from 2nd to 6th.", reading: "Money is rotating from IT into banks during the day. The index may hold up while leadership changes underneath." },
    watch: ["Inside NIFTY 50 only: sectors with a few members can swing on one stock."],
  },
  {
    id: "forward-test",
    idea: "A paper test: short straddles and strangles are opened whenever the seller score reaches 60, with plain stop losses of 30 to 80%, and combined stops tracked side by side and broken down by market regime. No real orders are placed.",
    read: ["Today and Open now: the current paper positions.", "Portfolio statistics, equity and drawdown: the cumulative result and its worst fall.", "Stop-loss rules compared: the same trades under different stops.", "By market regime: how the rule behaved in each regime."],
    example: { setup: "A short straddle is sold at 200. A 50% stop means it is closed if the straddle reaches 300.", reading: "Maximum planned loss is 100 points = ₹6,500 per lot. Win rate and average win and loss across many trades decide whether the stop helps; the comparison table shows which stop level did best on the sample so far." },
    watch: ["Paper results have no slippage or charges.", "Few trades means wide uncertainty."],
  },
  {
    id: "forward-test-cost",
    idea: "The same paper positions with 'Move SL to cost': when one leg's stop fires, the other leg's stop moves to its entry price. A separate test, with each rule beside the plain stop of the same percentage.",
    read: ["Compare each rule with the plain stop at the same percentage.", "Look at the drawdown as well as the total."],
    example: { setup: "A short strangle with call and put sold at 100 each, stops at 150. The call hits 150 and stops out for −50. The put, now trading 70, has its stop moved to 100.", reading: "The put can now lose nothing worse than breakeven from here (its entry): it turns a possible second loss into at most zero. The cost is that a modest bounce stops it out of a trade that would have kept decaying." },
    watch: ["It is a rule test, not a recommendation. Read the sample size before any conclusion."],
  },
  {
    id: "global-markets",
    idea: "US index futures and cash indices, VIX, the 10-year yield, the dollar, gold, silver, Brent and the Asian indices, each with its age and status. It shows the overnight and global backdrop before the Indian open.",
    read: ["Check each row's age and status first: a stale row is flagged.", "Look for the common direction of US futures and Asian indices.", "VIX up with equities down shows risk-off; a rising dollar and yield tend to press emerging markets."],
    example: { setup: "S&P futures −1%, VIX +10%, Asian indices −1.2%.", reading: "A global risk-off morning. Indian markets often open lower in such conditions, but the size of the reaction varies." },
    watch: ["Futures rows roll to the next contract near expiry (GIFT Nifty included); read the contract and the age shown for each row."],
  },
  {
    id: "economic-calendar",
    idea: "The high-impact events ahead, in IST: today, tomorrow, the rest of the week, next week and later this month.",
    read: ["Note the time in IST and the previous and forecast values.", "Events that can move global markets (inflation, rate decisions, jobs data) matter most.", "Plan around the event: spreads widen and volatility rises around the release."],
    example: { setup: "US core PCE is due at 19:00 IST on Wednesday, forecast 0.3%, previous 0.3%.", reading: "If the actual comes in at 0.5% the surprise is 0.2 points, which can move US markets and so the Asian open the next morning. In line with the forecast, little changes." },
    watch: ["The surprise (actual minus forecast) moves markets, not the number itself."],
  },
  {
    id: "market-news",
    idea: "Latest Indian and global market headlines from Economic Times, BBC and CNBC, linked to the publisher.",
    read: ["Use headlines to understand why a move happened, not to predict one.", "Open the link for the full article; the app shows the headline only."],
    example: { setup: "A sharp 10-minute fall coincides with a rate-decision headline.", reading: "The headline explains the move; check the Trend and Regime page to see whether the move was a clean trend or a spike that reversed." },
    watch: ["Headlines are read after the market has often already moved."],
  },
];

const BY_ID = new Map<string, Lesson>(LESSONS.map((l) => [l.id, l]));

export interface Entry { id: string; title: string; lesson: Lesson; tool?: Tool }
export interface Section { key: string; title: string; groups: { name: string; entries: Entry[] }[] }

/** The course in reading order: the shared ideas first, then every tool by menu and group, in the same order as the menus. */
export function learnSections(): Section[] {
  const sections: Section[] = [{ key: "start", title: "Start here", groups: [{ name: "The ideas every tool uses", entries: FOUNDATIONS.map((f) => ({ id: f.id, title: f.title, lesson: f })) }] }];
  for (const m of MENU_ORDER as MenuId[]) {
    const groups: Section["groups"] = [];
    for (const t of TOOLS.filter((x) => x.menu === m)) {
      const lesson = BY_ID.get(t.id);
      if (!lesson) continue;
      let g = groups.find((x) => x.name === t.group);
      if (!g) groups.push((g = { name: t.group, entries: [] }));
      g.entries.push({ id: t.id, title: t.label, lesson, tool: t });
    }
    sections.push({ key: m, title: MENU_TITLES[m], groups });
  }
  return sections;
}
