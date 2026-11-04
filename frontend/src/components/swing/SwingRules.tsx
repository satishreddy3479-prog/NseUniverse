import { Panel } from "../ui";
import { fmtDateTimeIST } from "../../lib/format";
import type { SwingReport } from "../../lib/types";

const li = "leading-relaxed";

export function SwingRules({ report }: { report: SwingReport }) {
  const m = report.meta;
  return (
    <>
      <Panel title="What the engine does">
        <div className="grid gap-5 text-sm md:grid-cols-2">
          <section aria-label="Universe and gates">
            <h3 className="mb-1 font-medium text-paper">1 · Universe and gates</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li className={li}>Stocks from your Chartink quality scan (market cap, turnover, ROCE, ROE, debt, profit, price above ₹75).</li>
              <li className={li}>Market gate: NIFTY 50 above 0.98 × its 50-day average.</li>
              <li className={li}>Sector gate: the stock&apos;s sector index above 0.98 × its 50- and 200-day averages.</li>
              <li className={li}>Stage-2 trend template: close above its 20 EMA, 50 and 200 SMAs (with 2-5% tolerance), 50 SMA above 200 SMA, within 20% of the 52-week high.</li>
            </ul>
          </section>
          <section aria-label="Scoring">
            <h3 className="mb-1 font-medium text-paper">2 · Score 0-100, minimum 65</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li className={li}>Volatility squeeze and contraction (30): Bollinger inside Keltner, squeeze length, NATR range, narrow-range days.</li>
              <li className={li}>Institutional accumulation (30): Chaikin money flow, up/down volume, volume dry-up, pocket pivots.</li>
              <li className={li}>Relative strength (20): Mansfield RS vs NIFTY 50, its slope, trend alignment.</li>
              <li className={li}>Pivot proximity and base tightness (20). Pivot = highest high of the previous 20 sessions.</li>
            </ul>
          </section>
          <section aria-label="Entry">
            <h3 className="mb-1 font-medium text-paper">3 · Entry on the next session</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li className={li}>Trigger: price trades through pivot × 1.003, with volume at least 1.25 × the 20-day average.</li>
              <li className={li}>Skip if the open is above pivot × 1.025 (no chasing). Fill at the higher of the open and the trigger.</li>
              <li className={li}>Initial stop: higher of pivot − 1.5 × ATR14 and 94.5% of the signal-day close.</li>
              <li className={li}>Day-1 cuts: exit at the stop if hit; exit at the close if it is below the pivot or in the bottom 35% of the day&apos;s range.</li>
            </ul>
          </section>
          <section aria-label="Exits and sizing">
            <h3 className="mb-1 font-medium text-paper">4 · Exits and sizing</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li className={li}>Stop moves to breakeven (+0.2%) after a 1.8R gain, then trails the higher of the Chandelier exit (high − 2.5 × ATR14) and the 10 EMA after 2.5R. It never moves down.</li>
              <li className={li}>Maximum 5 positions, 20% of equity each, risk capped at 2% of equity per trade. 3-session cooldown after exiting a stock.</li>
              <li className={li}>When several candidates tie on score, the first alphabetically is taken (the original engine&apos;s behaviour).</li>
            </ul>
          </section>
        </div>
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
