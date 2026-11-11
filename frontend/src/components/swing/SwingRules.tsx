import type { ReactNode } from "react";
import { Panel } from "../ui";
import { fmtDateTimeIST } from "../../lib/format";
import type { SwingLiveParams, SwingParams, SwingReport } from "../../lib/types";

const li = "leading-relaxed";
const ul = "list-disc space-y-1 pl-5 text-muted";
const h3 = "mb-1 font-medium text-paper";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const inr = (v: number) => `₹${v.toLocaleString("en-IN")}`;
/** A fraction held by the engine (0.02) as a percentage (2%). */
const pct = (f: number) => `${+(f * 100).toFixed(3)}%`;
const signed = (v: number) => `${v > 0 ? "+" : ""}${v}%`;

function Block({ title, label, children }: { title: string; label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className={h3}>{title}</h3>
      <ul className={ul}>{children}</ul>
    </section>
  );
}

function Parameters({ p, l, version }: { p: SwingParams; l?: SwingLiveParams; version: string }) {
  const rows: [string, string, string][] = [
    ["Capital (paper)", inr(p.capital), "Starting equity of the paper book."],
    ["Position slots", String(p.slots), "Maximum open positions; each gets at most equity ÷ slots."],
    ["Risk per trade", pct(p.risk_pct), "Share of equity lost if the initial stop is hit."],
    ["Minimum score", String(p.min_score), "A candidate must score at least this (0-100)."],
    ["Signal window", `${p.dist_min}% to ${signed(p.dist_max)}`, "Close relative to the pivot."],
    ["Trigger buffer", `pivot × ${p.trigger_buf}`, "The price that must trade to enter."],
    ["Volume requirement", `${p.vol_mult} × 20-day average`, "Entry-day volume, from rule version swing-v2 (the spec said 1.25)."],
    ["No-chase gap limit", `pivot × ${p.max_open_gap}`, "Skip the entry if the day opens above this."],
    ["Initial stop", `pivot − ${p.atr_sl_mult} × ATR14, floor ${pct(p.max_risk_frac)} of signal close`, "The higher of the two."],
    ["Breakeven", `at ${p.be_r}R → fill × ${p.be_buf}`, "R = fill − initial stop."],
    ["Trail", `at ${p.trail_r}R → high − ${p.chand_mult} × ATR14 (or 10 EMA)`, "Never moves down."],
    ["Cooldown", `${p.cooldown} sessions`, "After exiting a stock, no re-entry for this long."],
    ["Cost per side", pct(p.cost_per_side), "Charged on entry and on exit."],
    ["Minimum data coverage", pct(p.min_fetch_ratio), "Share of the Chartink list that must have price data before a scan is trusted."],
  ];
  if (l) {
    rows.push(
      ["Live entry window", `${hhmm(l.entry_from_min)}-${hhmm(l.entry_until_min)}`, "1-minute shadow book: candle-close decision times."],
      ["Live chase cap", `trigger × ${l.chase_cap}`, "Entry cancelled if the next open is above this."],
      ["Live day-1 check", hhmm(l.day1_check_min), "Candle closing at this time is tested against the pivot and the day's range."],
      ["Live wick fraction", pct(l.wick_fraction), "Bottom share of the day's range that counts as a rejection."],
      ["Live feed polling", `every ${l.poll_seconds} s`, `Prices older than ${l.stale_after_seconds} s are ignored.`],
    );
  }
  return (
    <Panel title={`Every parameter (rule version ${version})`}>
      <p className="mb-2 text-xs text-muted">Read from the running engine, so this table cannot differ from what trades.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm" aria-label="Engine parameters">
          <thead><tr className="text-xs uppercase tracking-wide text-muted"><th className="py-1 pr-3 font-medium">Parameter</th><th className="py-1 pr-3 font-medium">Value</th><th className="py-1 font-medium">Meaning</th></tr></thead>
          <tbody>
            {rows.map(([k, v, d]) => (
              <tr key={k} className="border-t border-line">
                <td className="py-1.5 pr-3 text-paper">{k}</td>
                <td className="num py-1.5 pr-3 text-paper">{v}</td>
                <td className="py-1.5 text-muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function SwingRules({ report, config }: { report: SwingReport; config?: { rule_version: string; params?: SwingParams; live?: SwingLiveParams } }) {
  const m = report.meta;
  const p = config?.params;
  const l = config?.live;
  const vol = p ? `${p.vol_mult} ×` : "2 ×";
  return (
    <>
      <Panel title="A trading day, step by step">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li className={li}><span className="text-paper">After the close (from 17:00 IST):</span> the engine fetches the Chartink list and daily prices, scores every stock, and queues the best candidates as orders for the next session. It runs again until 23:30 if data was missing and catches up any session it missed.</li>
          <li className={li}><span className="text-paper">Next session:</span> queued orders are settled on the daily bar: stops on open positions first, then entries best score first.</li>
          <li className={li}><span className="text-paper">During the session:</span> the live view and the live ledger watch the Kotak feed every {l?.poll_seconds ?? 2} s, and the 1-minute shadow book applies the live-style rules on completed candles. None of them places an order or changes the official book.</li>
          <li className={li}><span className="text-paper">Next evening:</span> the official daily result is compared with the live ledger and the shadow book, so the differences show up in the open.</li>
        </ol>
      </Panel>

      <Panel title="1 · Universe, data and safeguards">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Universe" label="Universe">
            <li className={li}>Stocks from your Chartink quality scan: market cap, turnover, ROCE, ROE, debt, profit and price above ₹75 (clause shown at the bottom of this tab).</li>
            <li className={li}>The list is today&apos;s list, so past tests carry survivorship bias (see the limits below).</li>
            <li className={li}>Prices are daily bars; today&apos;s partly-formed bar is dropped before 16:00 IST. Scores need at least 200 daily bars and the NIFTY 50 history.</li>
          </Block>
          <Block title="Safeguards" label="Safeguards">
            <li className={li}>A scan runs only if at least {p ? pct(p.min_fetch_ratio) : "90%"} of the list has price data; otherwise nothing is queued and it retries.</li>
            <li className={li}>Each date is processed once (idempotent) and stored append-only; no stored session is rewritten.</li>
            <li className={li}>Every session is stamped with its rule version ({config?.rule_version ?? "swing-v2"}); results of different versions are not pooled.</li>
          </Block>
        </div>
      </Panel>

      <Panel title="2 · Which stocks qualify">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Market and sector gates" label="Gates">
            <li className={li}>Market gate: NIFTY 50 close above 0.98 × its 50-day average. If it fails, no stock is queued that evening.</li>
            <li className={li}>Sector gate: the stock&apos;s sector index above 0.98 × both its 50- and 200-day averages. A stock needs both gates. Stocks without a mapped sector use the infrastructure index.</li>
          </Block>
          <Block title="Trend template (all must hold, else score 0)" label="Trend template">
            <li className={li}>Close ≥ 0.98 × 20-day EMA, ≥ 0.95 × 50-day SMA and ≥ 0.98 × 200-day SMA.</li>
            <li className={li}>50-day SMA ≥ 0.98 × 200-day SMA.</li>
            <li className={li}>High ≥ 0.80 × the 252-day high (within 20% of the 52-week high).</li>
            <li className={li}>A valid pivot, Mansfield RS and NATR percentile must exist.</li>
          </Block>
          <Block title="Signal window" label="Signal window">
            <li className={li}>The close must sit {p ? `${p.dist_min}% to ${signed(p.dist_max)}` : "−4.0% to +0.8%"} from the pivot: just below it, or barely through it.</li>
            <li className={li}>Pivot = the highest high of the previous 20 sessions.</li>
          </Block>
          <Block title="Pattern label (information only)" label="Archetype">
            <li className={li}>BLUE_SKY: the pivot is at least 98.5% of the prior maximum high. VCP: range contraction and volume dry-up both at or below 0.85. Otherwise CLASSIC_PIVOT. The label does not change any rule.</li>
          </Block>
        </div>
      </Panel>

      <Panel title={`3 · Score 0-100, minimum ${p?.min_score ?? 65}`}>
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Squeeze and contraction (30)" label="Squeeze pillar">
            <li className={li}>Bollinger Bands inside Keltner Channels: 12.</li>
            <li className={li}>Squeeze length: 3-18 bars 6, longer than 18 bars 3.</li>
            <li className={li}>NATR position in its 126-bar range (0 = lowest, 1 = highest): ≤ 0.25 gives 6, ≤ 0.40 gives 3.</li>
            <li className={li}>Narrowest range of the last 7 days 4, of the last 4 days 2; inside day 2.</li>
          </Block>
          <Block title="Institutional accumulation (30)" label="Accumulation pillar">
            <li className={li}>Chaikin money flow (20): ≥ 0.15 gives 10, ≥ 0.05 gives 6, ≥ 0 gives 2.</li>
            <li className={li}>Up-day to down-day volume over 50 days: ≥ 1.30 gives 8, ≥ 1.10 gives 5.</li>
            <li className={li}>Volume dry-up, 3-day against 50-day average: ≤ 0.60 gives 6, ≤ 0.80 gives 3.</li>
            <li className={li}>A pocket-pivot day in the last 5 sessions: 6.</li>
          </Block>
          <Block title="Relative strength (20)" label="Relative strength pillar">
            <li className={li}>Mansfield RS above zero: 7. RS = stock close ÷ NIFTY 50 close; Mansfield = (RS ÷ its 50-day average − 1) × 10.</li>
            <li className={li}>Mansfield RS higher than 5 bars ago: 5.</li>
            <li className={li}>Close &gt; 20 EMA &gt; 50 SMA: 5. 50 SMA &gt; 200 SMA: 3.</li>
          </Block>
          <Block title="Pivot proximity and tightness (20)" label="Pivot pillar">
            <li className={li}>Distance to the pivot: −2.5% to 0 gives 12; −4% to −2.5% gives 7; 0 to +0.8% gives 8.</li>
            <li className={li}>5-day range ÷ 20-day range: ≤ 0.45 gives 8, ≤ 0.65 gives 4.</li>
          </Block>
        </div>
        <p className="mt-3 text-xs text-muted">NATR = ATR14 as a share of the close. ATR14 uses Wilder smoothing. Candidates are ranked by score, highest first; equal scores are ordered by symbol.</p>
      </Panel>

      <Panel title="4 · The order queued for the next session">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Levels" label="Order levels">
            <li className={li}>Trigger: pivot × {p?.trigger_buf ?? 1.003}.</li>
            <li className={li}>Initial stop: the higher of pivot − {p?.atr_sl_mult ?? 1.5} × ATR14 and {p ? pct(p.max_risk_frac) : "94.5%"} of the signal-day close (so the stop is never more than {p ? pct(1 - p.max_risk_frac) : "5.5%"} below it).</li>
            <li className={li}>No-chase limit: pivot × {p?.max_open_gap ?? 1.025}.</li>
            <li className={li}>Minimum volume: {vol} the 20-day average volume. The spec said 1.25 ×; swing-v2 uses 2 × (11 Nov 2026). Orders queued before the change keep their stored minimum.</li>
          </Block>
          <Block title="Entry on the daily bar (the official book)" label="Entry">
            <li className={li}>The order fills only if the day trades through the trigger and the day&apos;s volume reaches the minimum.</li>
            <li className={li}>Fill price: the higher of the open and the trigger.</li>
            <li className={li}>Skipped, with the reason recorded, if: already holding the stock, no free slot, inside the cooldown, no price bar, opened above the no-chase limit, never reached the trigger, volume too low, no risk per share, or not enough cash.</li>
            <li className={li}>Orders are tried best score first.</li>
          </Block>
        </div>
      </Panel>

      <Panel title="5 · Sizing, slots and costs">
        <ul className={`${ul} text-sm`}>
          <li className={li}>Up to {p?.slots ?? 5} positions at once; capital {p ? inr(p.capital) : "₹10,00,000"} (paper).</li>
          <li className={li}>Shares = the smaller of (equity × {p ? pct(p.risk_pct) : "2%"} ÷ (fill − stop)) and (equity ÷ {p?.slots ?? 5} ÷ fill), limited by cash after costs. Equity is the book&apos;s value (cash plus open positions) at the previous close.</li>
          <li className={li}>Cooldown: after an exit the stock cannot be re-entered for {p?.cooldown ?? 3} sessions (the exit session counts as the first).</li>
          <li className={li}>Costs: {p ? pct(p.cost_per_side) : "0.15%"} of value on each side (entry and exit).</li>
        </ul>
      </Panel>

      <Panel title="6 · Exits (official daily book)">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Stop" label="Stop">
            <li className={li}>Checked first each session. If the day opens at or below the stop, exit at the open (STOP_GAP). If the low touches the stop, exit at the stop (STOP).</li>
            <li className={li}>There is no broker-side stop and no fixed profit target: winners are only closed by the stop.</li>
          </Block>
          <Block title="Day 1 (the entry day)" label="Day 1">
            <li className={li}>Exit at the stop if the low reaches it (D1_STOP).</li>
            <li className={li}>Exit at the close if the close is below the pivot (D1_FAIL_CLOSE).</li>
            <li className={li}>Exit at the close if the close is in the bottom 35% of the day&apos;s range (D1_REJECT_WICK).</li>
          </Block>
          <Block title="Breakeven and trail" label="Trail">
            <li className={li}>R = fill − initial stop. The stop only ever moves up, using the highest high since entry.</li>
            <li className={li}>At +{p?.be_r ?? 1.8}R: stop to fill × {p?.be_buf ?? 1.002} (breakeven plus 0.2%).</li>
            <li className={li}>At +{p?.trail_r ?? 2.5}R: stop = the highest of itself, fill × {p?.be_buf ?? 1.002}, highest high − {p?.chand_mult ?? 2.5} × ATR14 (the Chandelier exit) and the 10-day EMA.</li>
            <li className={li}>New stop levels apply from the next session.</li>
          </Block>
          <Block title="Results" label="Results">
            <li className={li}>Reasons recorded per trade: STOP, STOP_GAP, D1_STOP, D1_FAIL_CLOSE, D1_REJECT_WICK. Profit is net of costs.</li>
          </Block>
        </div>
      </Panel>

      <Panel title="7 · The live layers (research only, no orders)">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <Block title="Live view" label="Live view">
            <li className={li}>Watches queued orders and open positions on the feed every {l?.poll_seconds ?? 2} s and shows what would be decided now. Prices older than {l?.stale_after_seconds ?? 120} s are ignored.</li>
            <li className={li}>Events are shadow only: entry trigger, stop hit, 1.8R and 2.5R reached. Stops are not moved intraday here.</li>
          </Block>
          <Block title="Live ledger" label="Live ledger">
            <li className={li}>Records a live-style entry only after two consecutive polls show the trigger crossed; fill = the higher of the open and the trigger.</li>
            <li className={li}>Reconciled with the official book after the evening run. It never changes the official book.</li>
          </Block>
          <Block title="1-minute shadow book: entry" label="Shadow entry">
            <li className={li}>Decisions are taken on the close of a completed 1-minute candle and filled at the open of the next candle, never at the close they were decided on.</li>
            <li className={li}>Entry candles close between {l ? hhmm(l.entry_from_min) : "09:30"} and {l ? hhmm(l.entry_until_min) : "15:00"} IST, at or above the trigger and no more than {l ? pct(l.chase_cap - 1) : "1%"} above it. Entry is cancelled if the next open is above that cap.</li>
            <li className={li}>The day opened at or below the no-chase limit; the volume so far at least the minimum × the share of a normal day that should have traded by now (the recorded stock volume profile; a straight line when none exists, not judged before {l ? hhmm(l.straight_line_judge_min) : "09:45"}).</li>
            <li className={li}>Free slot, no holding, cooldown respected, {p ? pct(p.cost_per_side) : "0.15%"} cost per side, like the official book.</li>
          </Block>
          <Block title="1-minute shadow book: exits" label="Shadow exits">
            <li className={li}>Stop: a candle that closes at or below the stop in force exits at the next candle&apos;s open.</li>
            <li className={li}>Breakeven at +{p?.be_r ?? 1.8}R and trail at +{p?.trail_r ?? 2.5}R on the highest 1-minute close; the new level applies from the next candle. The trail uses the signal day&apos;s ATR14 and has no 10 EMA leg.</li>
            <li className={li}>Day 1: on the candle closing at {l ? hhmm(l.day1_check_min) : "15:20"}, exit if the close is below the pivot or in the bottom {l ? pct(l.wick_fraction) : "35%"} of the day&apos;s range so far.</li>
            <li className={li}>Candles are built from the 2-second polls (first, highest, lowest, last price), so a spike shorter than a poll can be missed.</li>
          </Block>
        </div>
      </Panel>

      {p && <Parameters p={p} l={l} version={config?.rule_version ?? ""} />}

      <Panel title="Rule version history">
        <ul className={`${ul} text-sm`}>
          <li className={li}><span className="text-paper">swing-v1</span> — the reconstructed original rules, volume requirement 1.25 × the 20-day average. Seven sessions were recorded under it.</li>
          <li className={li}><span className="text-paper">swing-v2</span> (11 Nov 2026) — volume requirement 2 ×. Backtest sweeps favoured it, but they test the full-day volume, which is unknown when a trigger fires, so the gain is overstated by an unknown amount; the forward record decides. The research code keeps 1.25 so the published reconstruction stays reproducible.</li>
        </ul>
      </Panel>

      <Panel title="Terms">
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <div><dt className="text-paper">R</dt><dd className="text-muted">Initial risk per share: fill − initial stop. A 2R gain is twice that.</dd></div>
          <div><dt className="text-paper">ATR14</dt><dd className="text-muted">Average true range over 14 days (Wilder).</dd></div>
          <div><dt className="text-paper">NATR</dt><dd className="text-muted">ATR14 as a share of the close.</dd></div>
          <div><dt className="text-paper">Mansfield RS</dt><dd className="text-muted">Stock strength against NIFTY 50, relative to its own 50-day average.</dd></div>
          <div><dt className="text-paper">Pivot</dt><dd className="text-muted">Highest high of the previous 20 sessions.</dd></div>
          <div><dt className="text-paper">Slot</dt><dd className="text-muted">One of the maximum simultaneous positions.</dd></div>
          <div><dt className="text-paper">Cooldown</dt><dd className="text-muted">Sessions a stock must wait after an exit.</dd></div>
          <div><dt className="text-paper">Shadow</dt><dd className="text-muted">Recorded and compared, never traded.</dd></div>
        </dl>
      </Panel>

      <Panel title="Limits of this test">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-paper">
          {report.caveats.map((c) => <li key={c} className={li}>{c}</li>)}
        </ul>
      </Panel>

      <Panel title="Where the data comes from">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Chartink list fetched</dt><dd className="num">{fmtDateTimeIST(m.universe_fetched_at_utc)} · {m.universe_size} stocks, {m.stocks_with_data} with price data</dd></div>
          <div><dt className="text-muted">Report built</dt><dd className="num">{fmtDateTimeIST(m.generated_at_utc)} · prices through the close of {m.data_through}</dd></div>
          <div><dt className="text-muted">Backtest period</dt><dd className="num">{m.period_start} to {m.data_through}</dd></div>
          <div><dt className="text-muted">Price basis</dt><dd>{m.price_basis}</dd></div>
          <div className="sm:col-span-2"><dt className="text-muted">Chartink scan clause</dt><dd className="num break-words text-xs">{m.scan_clause}</dd></div>
          <div className="sm:col-span-2">
            <dt className="text-muted">Refreshing</dt>
            <dd>Run <code>scripts\swing-refresh.ps1</code> after 16:00 IST on a trading day (about 5 minutes). The page then shows the new close, candidates and backtest. The server never trades or places orders.</dd>
          </div>
        </dl>
      </Panel>
    </>
  );
}
