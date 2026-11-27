import facts from "./learnFacts.json";

/**
 * The "How it works" guides of the Learn page: for the three engines that produce the app's verdicts (Market Intelligence, the Straddle engine, Trend & Regime) they say what goes in, the
 * exact arithmetic, and how the pieces are put together, step by step, with a worked example whose every number can be checked by hand.
 *
 * Every constant quoted here is read from learnFacts.json, and a backend test (tests/unit/test_learn_facts.py) compares that file with the engine's own constants and recomputes the
 * worked examples with the engine's own functions: a guide that disagrees with the code fails the build. The examples use round numbers chosen for the arithmetic (not market data).
 */
export type Block =
  | { k: "p"; t: string }
  | { k: "h"; t: string }
  | { k: "steps"; items: string[] }
  | { k: "list"; items: string[] }
  | { k: "formula"; lines: string[] }
  | { k: "table"; head: string[]; rows: string[][]; cap?: string }
  | { k: "worked"; title: string; lines: string[] }
  | { k: "note"; t: string };
export interface GuideSection { id: string; title: string; blocks: Block[] }
export interface Guide { id: string; title: string; summary: string; tool?: string; sections: GuideSection[] }

export const F = facts;
const W = F.mi.weights;
const T = F.trend;
const S = F.straddle;
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const wt = (o: Record<string, number>, id: string) => String(o[id]);

// ================================================================================================================ Market Intelligence
const MARKET: Guide = {
  id: "guide-market-intelligence",
  title: "Market Intelligence: how the verdict is built",
  summary: "Six groups of evidence are each scored from -100 to +100, combined by fixed weights into one verdict, and given a separate evidence-quality figure. Here is every step.",
  tool: "/intelligence",
  sections: [
    {
      id: "mi-big-picture",
      title: "1. The big picture",
      blocks: [
        { k: "p", t: "The verdict answers one question: across everything the app measures right now, which way does the evidence lean, and how good is that evidence? It never predicts. It is rebuilt every minute from numbers the app already computes, and it is stored every minute so that the past can be replayed and checked." },
        { k: "steps", items: [
          "Collect: each group reads its own inputs (option-chain OI, the futures flow, the volatility surface, index price, the 50 stocks, the trend engine). Each input says how old it is.",
          "Score each term: every piece of evidence (a term) becomes a number from -100 (bearish) to +100 (bullish). A missing input is left out; it is never scored as neutral.",
          "Combine terms into a group score: terms built from the same underlying data are averaged first, so one fact is not counted twice.",
          "Combine the six groups into one verdict with fixed weights, shrinking a group's weight when part of its evidence is missing.",
          "Label the verdict (Strong Bullish ... Strong Bearish) and compute a separate evidence quality from coverage, agreement among groups and freshness.",
          "Day board and turn watch: the stored per-minute verdicts are replayed to show the path of the day, how often calls were right, and early warnings that the picture is changing.",
        ] },
        { k: "note", t: "Weights and thresholds are provisional working values. They have not been statistically calibrated, and the page says so. Evidence quality is not a probability that the direction is right." },
      ],
    },
    {
      id: "mi-terms",
      title: "2. From a raw reading to a score",
      blocks: [
        { k: "p", t: "Raw readings come in different units (rupees of OI, percent, points of vol). Each is turned into a score in [-100, +100] by one of three rules, chosen per term:" },
        { k: "formula", lines: [
          "squash(x, scale) = 100 x tanh(x / scale)      a reading of one 'scale' counts as strong evidence (about +/-76)",
          "linear           = (reading - midpoint) x factor, clipped to +/-100",
          "label            = a fixed number for a named state (for example long buildup = +60)",
        ] },
        { k: "worked", title: "Worked example: OI added, puts minus calls", lines: [
          "Puts added 4,000 units of OI and calls 1,000 over the day; total OI in the strikes read is 100,000.",
          "reading = (4,000 - 1,000) / 100,000 = 0.03; the term's scale is 0.05.",
          "score = 100 x tanh(0.03 / 0.05) = 100 x tanh(0.6) = +53.7.",
          "Twice the reading (0.06) gives tanh(1.2) = +83.4; ten times gives about +100. The curve flattens, so one extreme input cannot dominate.",
        ] },
        { k: "p", t: "A term whose input is missing (no snapshot 15 minutes earlier, no futures sample, no GEX history) is marked unavailable and its reason is shown. It is dropped from the average and lowers the group's coverage. Zero-filling would pretend the market was neutral." },
      ],
    },
    {
      id: "mi-groups",
      title: "3. The six groups and their terms",
      blocks: [
        { k: "p", t: "Each group owns its inputs so that no input is counted twice. Where two terms are built from the same underlying data they share a family and are averaged into a single reading. A term that reads index price (which group D also reads) carries a stated weight of 0.5." },
        { k: "table", head: ["Group (weight)", "Terms and how each becomes a score", "What it owns"], cap: "Weights are percent of the whole; they are the defaults and can be overridden in the server settings.", rows: [
          [`A. Positioning (${W.positioning})`, "OI added: squash((put OI added - call OI added) / total OI, 0.05). Smart OI strike labels over 15 min: +35 for each of upside speculation (OTM calls) or put writing (OTM puts), -35 for each of call writing or downside speculation. Futures price and OI over 15 min: long buildup +60, short buildup -60, short covering +30, long unwinding -30 (weight 0.5). GEX: spot against the modelled flip, squash(distance %, 1.0), and room to the call and put walls, 60 x (room above - room below) / (sum of the two); both weight 0.5, the flip a quarter of that if unstable.", "Options OI, futures OI, modelled dealer gamma. The two OI terms use the same OI changes, so they are one family."],
          [`B. Order flow (${W.orderflow})`, "Futures CVD: session, rolling 15 min, and the change of the last 5 min against the 5 before, each squash(CVD % of classified volume, 25). Depth imbalance: squash(bid minus ask depth share, 0.3). Heavyweight CVD: rolling 15 min and session scores, their 5-minute change, and the weight share of stocks buying minus selling, times 100.", "Everything here is a proxy: buyer or seller volume is estimated by the quote rule then the tick rule; the feed has no aggressor-side tape. Session and rolling CVD are one family; the heavyweights another."],
          [`C. Volatility (${W.volatility})`, "ATM implied-vol change against the price change over 15 min, and the 25-delta call-versus-put IV momentum, both scored by the configurable volatility rules.", "Live ATM IV and skew. India VIX, IV rank and IV minus realised vol are shown as context and never scored."],
          [`D. Structure (${W.structure})`, "Futures price against the future's own VWAP, squash(distance in ATRs, 1.0). Position in the day's range, (position - 0.5) x 120. Position against the previous day's range, (position - 0.5) x 120 clipped; above 100% is a break higher.", "Index price only. Breadth is group E's; the command-centre score is never used because it is built from these same inputs."],
          [`E. Participation (${W.participation})`, "Advance/decline balance x 100. Share of stocks above their VWAP, (percent - 50) x 2. Stocks above the opening-range high minus below the low. Heavyweights advancing versus declining by weight (weight 0.5), index points from the heavyweights, squash(points, 0.15) (0.5), heavyweight strength against the index, squash(points, 0.3) (0.5).", "Prices only, no CVD, so it is independent of group B. The three breadth readings are one family (the same 50 stocks)."],
          [`F. Trend and regime (${W.trend})`, "Regime: direction x strength x 100. Close against the session mean, squash(ATRs, 2) (0.5). Close against the 15-minute opening range, squash(ATRs beyond it, 2) (0.5).", "The Trend & Regime engine (its own guide below). The last two read price, hence the 0.5."],
        ] },
      ],
    },
    {
      id: "mi-group-score",
      title: "4. From terms to a group score",
      blocks: [
        { k: "formula", lines: [
          "family score  = sum(term score x term weight) / sum(term weight)         over the family's available terms",
          "family weight = (sum of its available terms' weights) / (number of available terms)",
          "group score   = sum(family score x family weight) / sum(family weight)",
          "group fraction = (family weight of the available families) / (family weight of all listed families)",
        ] },
        { k: "worked", title: "Worked example: part of group A", lines: [
          "Family 'options OI' holds two terms, +40 and +20, both weight 1: family score +30, family weight 1.",
          "Family 'futures OI' holds one term, long buildup +60, weight 0.5: family score +60, family weight 0.5.",
          "Group score = (30 x 1 + 60 x 0.5) / (1 + 0.5) = 60 / 1.5 = +40.0.",
          "The two OI terms were averaged first, so the OI picture counts as one voice, not two.",
        ] },
        { k: "p", t: "The group also reports its freshness: a live input (order flow, structure, participation, trend) older than 120 s counts as stale, a stored-chain input older than 420 s counts as stale, and any input that failed marks the group not fresh. Status is AVAILABLE (all terms present), PARTIAL (some missing) or UNAVAILABLE." },
      ],
    },
    {
      id: "mi-fusion",
      title: "5. From six groups to the verdict",
      blocks: [
        { k: "formula", lines: [
          "effective weight_g = weight_g x fraction_g          (fraction = share of the group's evidence that exists)",
          "verdict            = sum(score_g x effective weight_g) / sum(effective weight_g)",
          "coverage           = sum(effective weight) / sum(all weights)",
          `no verdict (INSUFFICIENT DATA) unless coverage >= ${F.mi.min_coverage} and at least ${F.mi.min_engines} groups are available`,
        ] },
        { k: "worked", title: "Worked example A: all six groups present", lines: [
          `Scores: positioning +40 (weight ${W.positioning}), order flow +20 (${W.orderflow}), volatility -10 (${W.volatility}), structure +50 (${W.structure}), participation +30 (${W.participation}), trend +10 (${W.trend}).`,
          `Weighted sum = ${W.positioning}x40 + ${W.orderflow}x20 + ${W.volatility}x(-10) + ${W.structure}x50 + ${W.participation}x30 + ${W.trend}x10 = 1000 + 340 - 80 + 850 + 510 + 160 = 2,780; weights sum to ${sum(W)}.`,
          "Verdict = 2,780 / 100 = +27.8, which is Mild Bullish. Coverage 100%.",
        ] },
        { k: "worked", title: "Worked example B: two groups missing, one half missing", lines: [
          "Order flow and volatility have no data. Participation has half its evidence (fraction 0.5), so its effective weight is 17 x 0.5 = 8.5.",
          "Available: positioning 25, structure 17, participation 8.5, trend 16 = 66.5 of 100, so coverage = 0.665 (above 0.55: a verdict is allowed).",
          "Scores 40, 50, 30, 10 give (1000 + 850 + 255 + 160) / 66.5 = +34.1, Mild Bullish. Note it sits 0.9 under the Bullish line; the missing groups did not drag it toward zero.",
        ] },
        { k: "table", head: ["Score at least", "Label"], rows: F.mi.classes.map(([lo, name]) => [String(lo), String(name)]).concat([["below -69.999", "Strong Bearish"]]), cap: "The lines are 70, 35 and 15 on the bullish side, and the mirror image on the bearish side." },
      ],
    },
    {
      id: "mi-confidence",
      title: "6. Evidence quality (confidence) is a separate number",
      blocks: [
        { k: "p", t: "The score says which way; evidence quality says how much the evidence deserves attention. It is the product of three shown parts, never derived from the size of the score." },
        { k: "formula", lines: [
          "coverage factor = min(1, coverage / 0.8)",
          "conflict        = (smaller of: weight of groups at +15 or above, weight of groups at -15 or below) / total effective weight",
          "agreement       = max(0, 1 - 2 x conflict)       1 = no group opposes another, 0 = an even split",
          "freshness       = effective weight of fresh groups / total effective weight",
          "evidence quality = 100 x coverage factor x agreement x freshness      (capped at 40 when conflict is 0.25 or more)",
        ] },
        { k: "worked", title: "Worked example: strong groups that disagree", lines: [
          "Scores: positioning +60, order flow -40, volatility 0, structure +30, participation -30, trend 0 (full weights).",
          "Verdict = (1500 - 680 + 510 - 510) / 100 = +8.2: Neutral.",
          "Groups at +15 or above: positioning 25 + structure 17 = 42. At -15 or below: order flow 17 + participation 17 = 34. Conflict = 34 / 100 = 0.34, so agreement = 1 - 0.68 = 0.32.",
          "Evidence quality = 100 x 1 x 0.32 x 1 = 32, and because conflict is at least 0.25 it is also capped at 40. A split market never reads as high confidence.",
        ] },
      ],
    },
    {
      id: "mi-regime",
      title: "7. The regime name, scenarios and divergences",
      blocks: [
        { k: "p", t: "Alongside the verdict the page names a regime from fixed rules, checked in order, and the first that matches wins:" },
        { k: "table", head: ["Order", "Regime", "Rule"], rows: [
          ["1", "Short squeeze", "price up 0.15% or more over 15 min with futures OI falling (short covering), IV not rising, and futures CVD positive or not measured"],
          ["2", "Long liquidation", "price down 0.15% or more over 15 min with futures OI falling (long unwinding), and futures CVD negative or not measured"],
          ["3", "Uncertain / conflicting", "agreement under 0.45"],
          ["4", "Strong bullish or bearish trend", "score magnitude 70 or more with agreement 0.7 or more"],
          ["5", "Bullish or bearish trend", "magnitude 35 or more with agreement 0.55 or more"],
          ["6", "Weak bullish or bearish", "magnitude 15 or more"],
          ["7", "High volatility, Breakout candidate, Compression, Sideways", "inside +/-15: negative gamma or high realised vol; else IV contracting with price testing the opening range; else IV contracting; else sideways"],
        ] },
        { k: "p", t: "Scenarios are three competing heuristic scores that add to 100: bullish = max(0, score)/100 x (0.5 + 0.5 x confidence), bearish the mirror, sideways = (1 - |score|/100) x 1 (or 0.6 when modelled gamma is negative), each divided by their sum. They are labelled as scores and not probabilities. The one-standard-deviation move of each horizon is spot x IV x sqrt(minutes / (252 x 375)): an estimate from implied vol, not a forecast." },
      ],
    },
    {
      id: "mi-dayboard",
      title: "8. The Day board: lean, history and the scorecard",
      blocks: [
        { k: "steps", items: [
          `Every minute's engine scores are stored. The Day board re-scores them with today's weights to draw the path of the verdict through the session.`,
          `A lean (leans up / leans down) is stated only when the score is outside +/-${F.mi.lean_min_score} and the evidence quality is at least ${F.mi.lean_min_quality}. Otherwise it says "no lean" and why.`,
          "The scorecard checks each stored call: a call is a score outside the neutral band (15); it is a hit when NIFTY moved the same way over the next 15, 30 or 60 minutes; outcomes too small to call are left out. A hit rate is shown only from 30 decided calls and carries a Wilson 95% interval.",
          "The record is measured on the few stored sessions only and is not evidence of future accuracy: weigh the verdict with other evidence, never alone.",
        ] },
      ],
    },
    {
      id: "mi-turn",
      title: "9. Turn watch and the pullback cap",
      blocks: [
        { k: "p", t: `The verdict describes where evidence stands, so it reacts late to a turn. Two extra checks look for change. The turn watch compares the last ${F.mi.turn.smooth} minutes (averaged) with the same average ${F.mi.turn.lookback} minutes earlier, and a signal shows only if it was present in ${F.mi.turn.persist_min} of the last ${F.mi.turn.persist_window} minutes (no flicker).` },
        { k: "table", head: ["Signal", "Fires when"], rows: [
          ["Traded flow turning down / up", `structure and participation both fell (rose) by ${F.mi.turn.flow_drop} points or more in ${F.mi.turn.lookback} min`],
          ["Score sliding", `the fused score moved ${F.mi.turn.score_drop} points or more in ${F.mi.turn.lookback} min`],
          ["Breadth", `${F.mi.turn.breadth_min} of 5 groups each moved ${F.mi.turn.breadth_drop} points or more the same way (shown, never sets the lean)`],
          ["OI gap", "the put-minus-call OI change moved at least twice its typical 20-minute move (uncalibrated, context only)"],
        ] },
        { k: "p", t: `The pullback flag is price only: spot is at least ${F.mi.pullback.pull_atr} ATR under a session high (mild) or ${F.mi.pullback.strong_atr} ATR (strong), the high is at most ${F.mi.pullback.pull_window} minutes old, and the run into it was at least ${F.mi.pullback.run_atr} ATR over the previous ${F.mi.pullback.run_lookback} minutes, present in ${F.mi.pullback.persist_min} of the last ${F.mi.pullback.persist_window} minutes. A STRONG flag against the verdict caps the displayed score to Neutral (just inside +/-${F.mi.pullback.neutral_cap}); the raw score and the reason are shown beside it. A score is never raised or flipped by the cap.` },
        { k: "note", t: "Flags and caps were tuned on ten stored sessions and are provisional. A fast flag cannot be earlier than the move itself." },
      ],
    },
  ],
};

// ================================================================================================================ Straddle engine
const STRADDLE: Guide = {
  id: "guide-straddle-engine",
  title: "Straddle engine: how premium decay, risk and the seller/buyer scores are built",
  summary: "Why does an at-the-money straddle's price fall (or not), what would a seller who adjusts have made, and which environment do the numbers describe? Here is every step.",
  tool: "/tools/straddle-decay",
  sections: [
    {
      id: "st-inputs",
      title: "1. What goes in: stored chains, a model, an assumed rate",
      blocks: [
        { k: "p", t: "Every minute the app stores the option chain (last traded prices, OI, volume). The engine replays these stored minutes; nothing is collected twice. Prices are last traded prices, not bid/ask. Implied vols and Greeks are model values (Black-76), so they depend on an assumed interest rate and on a forward price, both stated on the page." },
        { k: "formula", lines: [
          "forward F      = K + e^(rT) x (Call - Put)       from put-call parity; median over the five strikes nearest spot that have both prices",
          "T              = calendar time to the expiry session close, in years of 365 days",
          `rate r         = ${S.rate * 100}% (assumed, used everywhere)`,
          "call price     = e^(-rT) x [F x N(d1) - K x N(d2)]       Black-76",
          "put price      = e^(-rT) x [K x N(-d2) - F x N(-d1)]",
          "d1             = [ln(F/K) + 0.5 x vol^2 x T] / (vol x sqrt(T)),   d2 = d1 - vol x sqrt(T)",
          "implied vol    = the vol that makes the model price equal the traded price (solved separately at every minute for each leg)",
        ] },
        { k: "worked", title: "Worked example: the forward from parity", lines: [
          "Strike 25,000: call 300, put 280, T = 0.01 years, r = 7%.",
          "F = 25,000 + e^(0.07 x 0.01) x (300 - 280) = 25,000 + 1.0007 x 20 = 25,020.01.",
          "The options market itself says the forward is about 25,020. Using the options' own forward (not the index level) keeps the model consistent with the prices it is solving.",
        ] },
        { k: "note", t: "A sample with no usable spot, no forward, or fewer than 15 minutes to expiry is skipped and counted, never filled." },
      ],
    },
    {
      id: "st-attribution",
      title: "2. Why did the premium change? Shapley attribution",
      blocks: [
        { k: "p", t: "Between two stored minutes a leg's price changes because time passed (theta), the forward moved, and implied vol changed. Splitting that change fairly is the heart of the engine. A leg is repriced with every one of the 3! = 6 orderings of the three factors, and each factor's marginal effect is averaged across the orderings (the Shapley value), so no factor is favoured by the order. The three effects add up exactly to the market change, because the vol at each end is solved from that end's own price." },
        { k: "formula", lines: [
          "theta = Shapley effect of time        (includes carry)",
          "vega  = Shapley effect of implied vol minus the volga and half the vanna cross term",
          "delta = delta(start) x (forward change)",
          "gamma = Shapley effect of the forward - delta - half the vanna term     (convexity, realised along the path)",
          "vanna = vanna x dF x dVol;  volga = 0.5 x volga x dVol^2      (shown apart; the totals do not change)",
          "residual = actual price change - (theta + vega + delta + gamma + vanna + volga)      (solver and rounding error, never an 'IV impact')",
        ] },
        { k: "worked", title: "Worked example: one call, one minute-step", lines: [
          "Call, strike 25,000. Start: forward 25,000, T = 0.01, vol 14.0% gives a price of 139.53. End: forward 25,040, T = 0.0095, vol 14.5% gives 161.86. Change +22.33.",
          "Repricing the six orderings and averaging: time -3.58, forward +21.00, vol +4.91.",
          "-3.58 + 21.00 + 4.91 = +22.33. The parts add up to the change, with nothing unexplained.",
          "The forward's +21.00 is then split into delta (delta at the start x 40 points) and gamma (what is left: the convexity gained from moving).",
        ] },
        { k: "p", t: "A window (15 minutes, an hour, the whole session) is the sum of its steps, about one minute each, so gamma is the convexity realised along the actual path rather than a two-point approximation." },
      ],
    },
    {
      id: "st-efficiency",
      title: "3. Decay efficiency: did time do its job?",
      blocks: [
        { k: "formula", lines: [
          "expected decay = -theta                      what time alone should take off the straddle in the window",
          "actual decay   = -(actual change)",
          "efficiency %   = actual decay / expected decay x 100",
          "shortfall      = expected - actual           in points; x 65 for rupees per lot",
        ] },
        { k: "table", head: ["Efficiency", "Class", "Meaning"], rows: [
          [`${S.efficient_pct}% or more`, "efficient", "the premium decayed about as theta says"],
          [`${S.meaningful_pct}% to ${S.efficient_pct}%`, "slower", "decay happened but something offset it"],
          [`${S.expansion_pct}% to ${S.meaningful_pct}%`, "none", "no meaningful decay"],
          [`below ${S.expansion_pct}%`, "expansion", "the premium rose by more than a tenth of the theta decay"],
        ] },
        { k: "worked", title: "Worked example", lines: [
          "Over a window: theta -12, vega +1, delta +2, gamma +0.5, others 0. The actual change is -12 + 1 + 2 + 0.5 = -8.5.",
          "Efficiency = 8.5 / 12 = 70.8%: class 'slower'. Shortfall 3.5 points = Rs 228 per lot (x 65).",
          "The cause named is the largest offset: NIFTY moving (delta +2), then vega +1, then gamma +0.5.",
        ] },
        { k: "p", t: `Confidence: when the expected decay is under ${S.min_expected_pts} points no efficiency is stated (a tick of last-traded price is larger than the signal); between ${S.min_expected_pts} and ${S.full_confidence_pts} points it is weighed down in proportion, and at ${S.full_confidence_pts} points or more it counts fully.` },
      ],
    },
    {
      id: "st-views",
      title: "4. Fixed, rolling and managed: three ways to hold a straddle",
      blocks: [
        { k: "list", items: [
          "Fixed: the strike nearest spot at the first usable sample, held all session. After spot moves away it is mostly a directional bet (delta), not decay, so the page marks it a reference once spot is 100 points or more from it.",
          "Rolling: the strike nearest spot at the start of each step; every step is one same-contract change, so a roll adds no jump. It answers 'what would decay look like for a straddle that is always at the money?'.",
          `Managed: a seller who opens at the nearest strike, holds until spot is ${S.restrike_points} points from the held strike, then closes it and re-opens at the nearest strike, and so on. Profit of each segment is entry minus exit at stored last prices, before costs; the total per lot is multiplied by ${S.lot_size}.`,
        ] },
        { k: "p", t: "Why the managed view exists: an unhedged short straddle loses what NIFTY has moved from the strike, minus the premium collected. On stored sessions a seller who re-strikes did better than one who simply held, but the re-strike distance is a provisional working value, and re-striking pays costs the page cannot see." },
      ],
    },
    {
      id: "st-seller",
      title: "5. The seller environment score (0 to 100)",
      blocks: [
        { k: "p", t: "Twelve components, each a value from -1 (unfavourable to a premium seller) to +1 (favourable) with a weight and a plain-language reason. The score is 50 plus 50 times the weighted average of the available components. A missing input removes its component and lowers coverage; it is never counted as neutral." },
        { k: "formula", lines: [
          "score    = 50 + 50 x sum(weight x value) / sum(weight of the available components)",
          "coverage = sum(weight of the available components) / sum(all weights)",
          `no score is stated when coverage is under ${S.min_coverage}`,
          "contribution of a component = 50 x weight x value / available weight       (points away from 50, shown on the page)",
        ] },
        { k: "table", head: ["Component", "Weight", "Value (+1 = favourable to a seller)"], rows: [
          ["Theta decay efficiency", wt(S.seller_weights, "decay"), "(efficiency % - 50) / 50, weighed by the decay confidence above"],
          ["ATM straddle premium path", wt(S.seller_weights, "prem_rolling"), `minus (0.6 x change since open + 0.4 x change over the last hour, as % of the opening premium, roll-adjusted) / ${S.prem_scale_pct}`],
          ["ATM IV trend", wt(S.seller_weights, "iv_trend"), "minus the ATM IV change over 30 min in vol points (falling helps)"],
          ["Call/put IV behaviour", wt(S.seller_weights, "iv_sides"), "both expanding -1, one side expanding faster -0.5, both contracting +0.7, else 0"],
          ["Realised versus implied vol", wt(S.seller_weights, "rv_gap"), "(implied minus realised, in vol points) / 6"],
          ["Movement versus break-even", wt(S.seller_weights, "movement"), "(1 - realised daily move / straddle break-even move) / 0.5"],
          ["Gamma regime (modelled)", wt(S.seller_weights, "gamma"), "average of: suppressed movement +0.6, stabilisation around gamma +0.6, increasing movement -0.6, potential gamma acceleration -1.0"],
          ["GEX stability", wt(S.seller_weights, "gex_stable"), "stabilising +0.6, amplifying -0.6, else 0; a further -0.4 if the flip was crossed 3+ times today"],
          ["Skew changes", wt(S.seller_weights, "skew"), "0.4 - min(|25-delta skew change|, 2) / 2"],
          ["Options positioning", wt(S.seller_weights, "positioning"), "+0.5 if spot sits between the largest put OI and call OI strikes, else -0.5; PCR between 0.7 and 1.3 adds 0.2, otherwise subtracts 0.2"],
          ["Futures order-flow evidence", wt(S.seller_weights, "flow"), "0.5 - |order-flow group score| / 100 (one-sided flow is a risk to sellers)"],
          ["Heavyweight participation", wt(S.seller_weights, "heavy"), "0.4 - 0.9 x |heavyweight CVD score| / 100"],
        ], cap: `The weights add to ${sum(S.seller_weights)}. The seller's trend and structure weights were removed after a study found no predictive value for the displacement a short straddle loses.` },
        { k: "worked", title: "Worked example: six components available", lines: [
          "Decay (weight 8) +0.4; premium path (14) -0.2; IV trend (12) +0.5; realised vs implied (12) +0.5; movement (10) +0.2; order flow (8) +0.3. The other six have no data.",
          "Available weight = 8 + 14 + 12 + 12 + 10 + 8 = 64 of 102, so coverage = 0.627 (above 0.5: a score is stated).",
          "Weighted sum = 3.2 - 2.8 + 6.0 + 6.0 + 2.0 + 2.4 = 16.8. Score = 50 + 50 x 16.8 / 64 = 63.1.",
          "63.1 is at least 60, so the class is Favourable, unless the flags below cap it.",
        ] },
        { k: "table", head: ["Score at least", "Seller class"], rows: S.seller_classes.map(([lo, name]) => [String(lo), String(name)]) },
        { k: "p", t: "Smoothing: the class label is read from the median of this minute and the two recorded minutes before it, so a label changes only when two of the three agree. The number shown stays raw." },
      ],
    },
    {
      id: "st-flags",
      title: "6. Risk flags cap the class",
      blocks: [
        { k: "table", head: ["Flag", "Fires when", "Cap"], rows: [
          ["IV spike", "ATM IV up 1.0 vol point or more in 15 min", "counts toward the cap rule"],
          ["Realised vol rising", "last 15 min of realised vol at least 1.3 times the 15 before", "counts"],
          ["Directional acceleration", "the regime reads directional acceleration", "counts; also holds the short-straddle score at 40 at most"],
          ["Premium up", `roll-adjusted ATM straddle premium ${S.prem_stop_pct}% or more over its open (hard from ${S.prem_stop_hard_pct}%)`, "counts; the hard level caps at Unfavourable"],
          ["Convexity blow-out", `realised gamma cost above ${S.convexity_ratio} times the expected theta decay`, "High risk; also holds the short-straddle score at 40 at most"],
          ["Premium expansion", "decay efficiency below 0", "Unfavourable"],
          ["Tail", "call and put vols moving a point or more apart, or a wide 25-delta skew", "counts"],
        ] },
        { k: "p", t: "Cap rule: any flag lowers the class to at most Neutral; two or more flags (or a flag that carries its own cap of Unfavourable) lower it to at most Unfavourable; a convexity blow-out lowers it to High risk. A cap never raises a class, and the page shows 'capped by flags' beside the raw score." },
      ],
    },
    {
      id: "st-buyer",
      title: "7. The buyer environment score",
      blocks: [
        { k: "p", t: "Built the same way (the same 50 + 50 x weighted average and coverage rule), from 14 components oriented the other way: what a premium buyer needs is movement that is larger than what the premium already prices." },
        { k: "table", head: ["Component", "Weight", "Value (+1 = favourable to a buyer)"], rows: [
          ["ATM IV expansion", wt(S.buyer_weights, "iv_up"), "ATM IV change over 30 min in vol points"],
          ["Call/put IV momentum", wt(S.buyer_weights, "iv_mom"), "both expanding +1, one faster +0.4, both contracting -1"],
          ["Realised-vol acceleration", wt(S.buyer_weights, "rv_accel"), "(last 15 min / previous 15 - 1) / 0.6"],
          ["Directional movement", wt(S.buyer_weights, "directional"), "(30-minute path efficiency - 0.3) / 0.4"],
          ["Gamma configuration (modelled)", wt(S.buyer_weights, "gamma"), "average of acceleration +1.0, increasing movement +0.6, suppressed -0.8, stabilisation -0.6"],
          ["GEX migration", wt(S.buyer_weights, "gex_mig"), "amplifying +0.6, stabilising -0.4"],
          ["Futures CVD (proxy)", wt(S.buyer_weights, "cvd"), "|order-flow score| / 60 - 0.2 (conviction either way)"],
          ["Futures VWAP", wt(S.buyer_weights, "vwap"), "+0.6 if the future is 0.3% or more from its VWAP, else -0.3"],
          ["Heavyweight CVD (proxy)", wt(S.buyer_weights, "heavy"), "|score| / 70 - 0.2"],
          ["Smart OI / positioning", wt(S.buyer_weights, "smart_oi"), "|positioning score| / 60 - 0.2"],
          ["Skew movement", wt(S.buyer_weights, "skew"), "|25-delta skew change| / 2 - 0.2"],
          ["ATM straddle premium path", wt(S.buyer_weights, "prem_path"), "the same premium path as the seller's, with the sign as it is (rising helps a buyer)"],
          ["Premium expansion", wt(S.buyer_weights, "prem_exp"), "(50 - efficiency %) / 50, weighed by the decay confidence"],
          ["Movement justifies the premium", wt(S.buyer_weights, "justified"), "(realised minus implied vol, in vol points) / 6"],
        ], cap: `The weights add to ${sum(S.buyer_weights)}.` },
        { k: "table", head: ["Score at least", "Buyer class"], rows: S.buyer_classes.map(([lo, name]) => [String(lo), String(name)]) },
        { k: "p", t: "The comparison box then reads the two scores together: both high is 'conflicting', both low is 'uncertain or unattractive', a seller score of 55 or more and 20 above the buyer's 'favours sellers', and the mirror 'favours selective buying'; otherwise 'mixed'. A rising IV that realised movement does not justify is called out explicitly: rising IV alone is not a buy signal." },
      ],
    },
    {
      id: "st-extras",
      title: "8. Premium Change by strike and the live Position Monitor",
      blocks: [
        { k: "p", t: "Premium Change by strike holds one contract fixed (a strike, a call, put or straddle) and, between every two stored samples, reprices its price change with the same Shapley split, then sums. Over any stretch the parts (time, volatility, NIFTY moving, convexity, vanna and volga, other) add up to the contract's real price change. 'Follow ATM' measures each step on one contract so a change of strike adds no jump." },
        { k: "p", t: "The Position Monitor does the same for a running paper strategy: it splits the position's profit or loss among its legs with the Shapley attribution, compares NIFTY's distance from the strike with the expected move (spot x IV x sqrt(minutes left / (375 x 252))), and raises WATCH from a loss of 15% and STOP from 30% against the entry premium. It describes the position; it never places an order." },
        { k: "note", t: "Everything on the Straddle page describes what happened in stored last-traded prices, before costs and slippage. It does not forecast what the straddle will do next." },
      ],
    },
  ],
};

// ================================================================================================================ Trend & Regime
const TREND: Guide = {
  id: "guide-trend-regime",
  title: "Trend & Regime: how the trend score and label are built",
  summary: "Four readings of the same price path are scaled between 'no trend' and 'full trend', averaged into one score, turned into a label, and protected against flicker. Here is every step.",
  tool: "/trend/market-regime",
  sections: [
    {
      id: "tr-bars",
      title: "1. The bars",
      blocks: [
        { k: "p", t: `The stored one-minute index bars are grouped into ${T.tf}-minute bars anchored at 09:15 IST. Every figure at bar i uses bars 0 to i only, so nothing looks into the future and a replay shows what the page would have said at that time. The first readings are blank (warming up) until ${T.min_window} bars of window exist.` },
      ],
    },
    {
      id: "tr-readings",
      title: "2. Four readings of the recent bars",
      blocks: [
        { k: "table", head: ["Reading", "Formula", "Meaning"], rows: [
          ["Efficiency ratio (ER)", "|last close - first close| / sum of |bar-to-bar changes|", "1 = a straight line; near 0 = lots of travel, no net progress"],
          ["ADX (14 bars)", "Wilder's smoothed |+DI - -DI| / (+DI + -DI) x 100", "strength of the directional movement, whichever way it points"],
          ["R-squared", "squared correlation of the closes with a straight line through the window", "how well one line explains the path"],
          ["Choppiness", "100 x log10(sum of true ranges / (highest high - lowest low)) / log10(n)", "high = overlapping noisy bars (a range), low = bars that make progress"],
        ], cap: `ER, R-squared and choppiness use the last ${T.window} bars (60 minutes). ADX is Wilder's ${T.adx_n}-bar smoothing carried from the start of the session. The slope of the fitted line gives the direction.` },
      ],
    },
    {
      id: "tr-score",
      title: "3. The trend score",
      blocks: [
        { k: "p", t: "Each reading is mapped onto 0 to 1 between a 'no trend' level and a 'full trend' level (values beyond are clipped), and the four are averaged. A score needs at least three readings." },
        { k: "formula", lines: [
          "ramp(x) = clip( (x - no_trend) / (full_trend - no_trend), 0, 1 )",
          `ER   ramps from ${T.scales.er[0]} to ${T.scales.er[1]}       ADX  from ${T.scales.adx[0]} to ${T.scales.adx[1]}       R-squared from ${T.scales.r2[0]} to ${T.scales.r2[1]}       Choppiness from ${T.scales.chop[0]} down to ${T.scales.chop[1]}`,
          "trend score = mean of the available ramps",
        ] },
        { k: "worked", title: "Worked example", lines: [
          "ER 0.36 -> (0.36 - 0.15) / 0.30 = 0.70.  ADX 20 -> (20 - 15) / 20 = 0.25.  R-squared 0.62 -> (0.62 - 0.2) / 0.6 = 0.70.  Choppiness 55 -> (55 - 61.8) / (38.2 - 61.8) = 0.288.",
          "Trend score = (0.70 + 0.25 + 0.70 + 0.288) / 4 = 0.485.",
          "0.485 is at least 0.45 and under 0.65, so the class is Weak trend.",
        ] },
      ],
    },
    {
      id: "tr-class",
      title: "4. Classes, the margin and the label",
      blocks: [
        { k: "table", head: ["Score", "Class"], rows: [
          [`under ${T.mixed}`, "Range-bound"],
          [`${T.mixed} to ${T.weak}`, "Mixed"],
          [`${T.weak} to ${T.trend}`, "Weak trend"],
          [`${T.trend} or more`, "Trend"],
        ] },
        { k: "p", t: `A class changes upward only when the score is ${T.margin} past the new class's lower bound, and downward only when it is ${T.margin} under its own lower bound. This margin (hysteresis) stops a score hovering on a line from flipping the label.` },
        { k: "worked", title: "Worked example: the margin", lines: [
          "Currently Weak trend (lower bound 0.45). A score of 0.43 stays Weak: it must fall under 0.45 - 0.05 = 0.40 to drop. A score of 0.39 drops to Mixed.",
          "Currently Mixed. A score of 0.48 stays Mixed: it must reach 0.45 + 0.05 = 0.50 to rise. A score of 0.50 rises to Weak trend.",
        ] },
        { k: "p", t: "The direction is the sign of the fitted slope. If +DI and -DI contradict that sign (the directional-movement lines point the other way), the label becomes Mixed rather than a trend. So the labels are Range-bound, Mixed, Weak uptrend / downtrend, and Trending up / down." },
      ],
    },
    {
      id: "tr-dwell",
      title: "5. Dwell: a label must hold",
      blocks: [
        { k: "p", t: `The shown label switches to a new label only after that label has been the raw label ${T.min_dwell} bars in a row (15 minutes). One odd bar changes nothing.` },
        { k: "worked", title: "Worked example", lines: [
          "Raw labels by bar: Mixed, Mixed, Weak uptrend, Mixed, Weak uptrend, Weak uptrend, Weak uptrend, Weak uptrend.",
          "Shown: Mixed, Mixed, Mixed, Mixed, Mixed, Mixed, Weak uptrend, Weak uptrend. The first Weak uptrend (bar 3) was interrupted by a Mixed; the run starting at bar 5 reached three in a row at bar 7, so the shown label switches there.",
          "The price of this stability is lateness: a label is confirmed about 15 minutes after the raw reading changed, on top of the 60-minute window.",
        ] },
      ],
    },
    {
      id: "tr-fading",
      title: "6. Fading: saying the trend label is late",
      blocks: [
        { k: "p", t: `A trend label reads the last 60 minutes, so after price has already turned it keeps saying 'Trending up'. The fading rule looks at the last ${T.fade_bars} five-minute closes: if all of them are at least ${T.fade_atr} ATR under the window's high (for an up label) or over its low (for a down label), the label becomes 'Trending up (fading)'. ATR is the 14-bar average true range of the 5-minute bars. The rule uses bars 0 to i only. A fading label no longer pushes the verdict's trend group (its direction counts as none).` },
      ],
    },
    {
      id: "tr-structure",
      title: "7. Session structure and opening range",
      blocks: [
        { k: "list", items: [
          "Session mean: the running average of all 5-minute closes today (a TWAP). The structure view reports the share of closes above it, how often price crossed it, the longest run on one side and the last distance. A trend day stays on one side; a range day crosses it often.",
          `Opening range: the high and low of the first ${T.or_minutes} minutes. Once complete, the page says whether price is above, below or inside it, and by how many ATRs beyond.`,
        ] },
      ],
    },
    {
      id: "tr-fusion",
      title: "8. How the trend feeds the Market Intelligence verdict",
      blocks: [
        { k: "formula", lines: [
          "strength        = max(0, (trend score - 0.30) / 0.70)       0 at the Mixed floor, 1 at a perfect trend",
          "regime term     = direction x strength x 100                direction is +1, -1 or 0 (Range-bound, Mixed, fading)",
          "close vs mean   = 100 x tanh((close - session mean) / ATR / 2)         weight 0.5",
          "close vs range  = 100 x tanh((ATRs beyond the opening range) / 2)       weight 0.5",
        ] },
        { k: "worked", title: "Worked example", lines: [
          "Label Trending up with score 0.65: strength = (0.65 - 0.30) / 0.70 = 0.5, regime term = +1 x 0.5 x 100 = +50.",
          "NIFTY one ATR above its session mean: 100 x tanh(1 / 2) = +46.2.",
          `These feed group F (weight ${W.trend}) of the verdict.`,
        ] },
        { k: "note", t: "The trend engine describes the session so far. It is not a forecast and, apart from its daily version, has not been validated as predictive." },
      ],
    },
  ],
};

export const GUIDES: Guide[] = [MARKET, STRADDLE, TREND];
const blockText = (b: Block): string[] => {
  switch (b.k) {
    case "p": case "h": case "note": return [b.t];
    case "steps": case "list": return b.items;
    case "formula": return b.lines;
    case "worked": return [b.title, ...b.lines];
    case "table": return [...b.head, ...b.rows.flat(), b.cap ?? ""];
  }
};
export const guideText = (g: Guide): string => [g.title, g.summary, ...g.sections.flatMap((s) => [s.title, ...s.blocks.flatMap(blockText)])].join(" ").toLowerCase();
