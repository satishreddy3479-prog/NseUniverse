import { useMemo, useState } from "react";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { useDash } from "./DashContext";
import { Frame, GROUP, Panel, pill, useStrikeSeries } from "./PriceBoards";
import { fmtInt, fmtTimeIST, MISSING } from "../../lib/format";
import { strikeBoard, strikesAround } from "../../lib/optionTools";
import { rupee, timeLinesOption, type Line } from "../../lib/priceCharts";
import { readRollingStraddle, rollingStraddle, type RollRule } from "../../lib/rollingStraddle";

const RULES: { id: string; label: string; title: string; rule: RollRule }[] = [
  { id: "nearest", label: "Nearest ATM", title: "Hold the strike nearest spot at every sample (rolls whenever spot crosses a mid-point)", rule: { kind: "nearest" } },
  { id: "1", label: "Roll at 1 strike", title: "Stay with a strike until spot is a full strike-gap away from it, then roll to the nearest (fewer rolls)", rule: { kind: "steps", n: 1 } },
  { id: "2", label: "Roll at 2 strikes", title: "Stay with a strike until spot is two strike-gaps away from it, then roll to the nearest", rule: { kind: "steps", n: 2 } },
];

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const n1 = (v: number | null | undefined, d = 1) => (v == null ? MISSING : v.toFixed(d));

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="min-w-0 rounded-sm bg-slate-2 px-2.5 py-2" data-testid="rs-tile"><div className="truncate text-[11px] text-muted">{label}</div><div className={`num truncate text-[15px] font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="truncate text-[10px] text-muted">{sub}</div>}</div>;
}

/** ATM rolling straddle: the premium of the strike held under a roll rule, the fixed opening strike for comparison, the roll-adjusted premium (rolls add no jump),
 *  the implied move, the rolls themselves and a plain reading. From the stored one-minute samples; see lib/rollingStraddle.ts for every definition. */
export function RollingStraddleBoard() {
  const d = useDash();
  const c = useChartColors();
  const [ruleId, setRuleId] = useState("nearest");
  const rule = RULES.find((r) => r.id === ruleId)!.rule;
  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((x, y) => x - y), [d.rows]);
  const strikes = useMemo(() => strikesAround(listed, d.atmStrike, 21), [listed, d.atmStrike]);
  const key = strikes.join(",");
  const { q, w } = useStrikeSeries(key || "atm");
  const res = q.data;
  const r = useMemo(() => {
    if (!res) return null;
    const boards = strikes.map((k) => strikeBoard(res, k)).filter((x): x is NonNullable<ReturnType<typeof strikeBoard>> => x != null);
    if (boards.length === 0 || boards[0]!.times.length < 2) return null;
    return rollingStraddle(boards[0]!.times, boards[0]!.spot, boards.map((b) => ({ strike: b.strike, straddle: b.straddle })), rule);
  }, [res, strikes, rule]);
  const text = useMemo(() => (r ? readRollingStraddle(r) : []), [r]);
  const opts = useMemo(() => {
    if (!r) return null;
    const lines: Line[] = [
      { name: "Rolling ATM straddle", color: c.brass, data: r.rolling, fmt: rupee },
      { name: r.openingStrike == null ? "Fixed opening strike" : `Fixed ${fmtInt(r.openingStrike)} straddle`, color: c.info, data: r.fixed, fmt: rupee, dotted: true },
      { name: "Roll-adjusted premium", color: c.up, data: r.adjusted, fmt: rupee, dotted: true },
      { name: "NIFTY 50", color: c.muted, data: r.spot, fmt: (v: number) => fmtInt(Math.round(v)), axis: 1, dotted: true, hidden: true },
    ];
    const prem = timeLinesOption(r.times, lines, c, w.bounds, { leftFmt: rupee, rightFmt: (v) => fmtInt(Math.round(v)) }) as unknown as { series: unknown[] };
    prem.series.push({
      name: "Rolls", type: "scatter", symbolSize: 9, itemStyle: { color: c.down, borderColor: c.slate, borderWidth: 1 }, z: 5,
      data: r.rolls.filter((x) => r.rolling[x.index] != null).map((x) => ({ value: [x.time, r.rolling[x.index]], from: x.from, to: x.to })),
      tooltip: { formatter: (p: { data: { from: number; to: number } }) => `Roll ${p.data.from} → ${p.data.to}` },
    });
    const pct = timeLinesOption(r.times, [{ name: "Implied move (premium ÷ spot)", color: c.brass, data: r.impliedPct, fmt: (v: number) => `${v.toFixed(2)}%`, area: true }], c, w.bounds, { leftFmt: (v: number) => `${v.toFixed(2)}%` });
    return { prem, pct };
  }, [r, c, w.bounds]);
  const s = r?.stats;
  if (!d.expiry) return <EmptyState title="No expiry">Choose an expiry above.</EmptyState>;
  return (
    <div className="flex flex-col gap-3" data-testid="rolling-straddle-board">
      <div role="group" aria-label="Roll rule" className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
        <span className="mr-1 text-sm text-muted">Roll rule</span>
        {RULES.map((x) => <button key={x.id} type="button" title={x.title} aria-pressed={ruleId === x.id} onClick={() => setRuleId(x.id)} className={pill(ruleId === x.id)}>{x.label}</button>)}
        <span className="basis-full text-[11px] text-muted sm:basis-auto">{RULES.find((x) => x.id === ruleId)!.title}.</span>
      </div>
      <Frame q={q} w={w} res={res} footer={
        <span className="basis-full">
          Straddle = call price + put price of one strike (last traded prices). Rolling premium: the strike held under the roll rule. Fixed: the strike that was ATM at the first sample. Roll-adjusted: adds up only same-contract changes, so a roll makes no jump.
          Roll credit = new strike&apos;s premium − old strike&apos;s premium at the roll. Descriptive figures from stored samples, not a trade signal.
        </span>
      }>
        {r && s && opts ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="rs-stats">
              <Tile label="Rolling straddle now" value={n1(s.current)} sub={`held ${s.heldNow == null ? MISSING : fmtInt(s.heldNow)} strike`} />
              <Tile label="Change from open" value={sg(s.changeFromOpen)} sub={`${sg(s.changeFromOpenPct, 2)}% (includes rolls)`} tone={s.changeFromOpen == null ? undefined : s.changeFromOpen >= 0 ? "text-up" : "text-down"} />
              <Tile label="Roll-adjusted change" value={sg(s.adjustedChange)} sub={s.adjustedLast60 == null ? "last hour: needs a full hour" : `last hour ${sg(s.adjustedLast60)}`} tone={s.adjustedChange == null ? undefined : s.adjustedChange >= 0 ? "text-up" : "text-down"} />
              <Tile label="Day high / low" value={`${n1(s.high)} / ${n1(s.low)}`} sub={`average ${n1(s.average)} (time average)`} />
              <Tile label="Implied move now" value={s.impliedMovePctNow == null ? MISSING : `${s.impliedMovePctNow.toFixed(2)}%`} sub={s.bandLow == null ? undefined : `break-even ${fmtInt(Math.round(s.bandLow))} to ${fmtInt(Math.round(s.bandHigh ?? 0))}`} />
              <Tile label="NIFTY move vs opening premium" value={s.moveVsOpeningPremium == null ? MISSING : `${(s.moveVsOpeningPremium * 100).toFixed(0)}%`} sub={`${sg(s.spotMove, 0)} pts since the first sample`} />
              <Tile label="Rolls" value={String(s.rolls)} sub={s.rollCreditTotal == null ? "credit unavailable" : `credit total ${sg(s.rollCreditTotal)}`} />
              <Tile label="Opening premium" value={n1(s.open)} sub={r.openingStrike == null ? undefined : `${fmtInt(r.openingStrike)} strike`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Panel title="Rolling, fixed and roll-adjusted premium"><div className="h-[380px]"><EChart group={GROUP} option={opts.prem} ariaLabel="Rolling ATM straddle, fixed opening-strike straddle and roll-adjusted premium through the session" /></div></Panel>
              <Panel title="Implied move"><div className="h-[380px]"><EChart group={GROUP} option={opts.pct} ariaLabel="Rolling straddle premium as a percentage of spot" /></div></Panel>
            </div>
            <section aria-label="Reading" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="rs-reading">
              <h2 className="mb-1 text-sm font-semibold text-paper">Reading <span className="font-normal text-muted">· description of the numbers, not a forecast</span></h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-paper">{text.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
            <section aria-label="Rolls" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="rs-rolls">
              <h2 className="mb-1 text-sm font-semibold text-paper">Rolls <span className="font-normal text-muted">· {r.rolls.length} under “{RULES.find((x) => x.id === ruleId)!.label}”</span></h2>
              {r.rolls.length === 0 ? <p className="text-sm text-muted">The held strike never changed under this rule.</p> : (
                <div className="max-h-64 overflow-auto"><table className="w-full min-w-[30rem] text-xs"><thead className="sticky top-0 bg-slate text-[11px] text-muted"><tr className="text-left"><th className="py-1 font-normal">Time</th><th className="py-1 font-normal">Strike</th><th className="py-1 text-right font-normal">NIFTY</th><th className="py-1 text-right font-normal">Old premium</th><th className="py-1 text-right font-normal">New premium</th><th className="py-1 text-right font-normal">Roll credit</th></tr></thead>
                  <tbody>{r.rolls.map((x) => <tr key={x.index} className="border-t border-rule/50"><td className="num py-1">{fmtTimeIST(new Date(x.time).toISOString())}</td><td className="num py-1">{fmtInt(x.from)} → {fmtInt(x.to)}</td><td className="num py-1 text-right">{fmtInt(Math.round(x.spot))}</td><td className="num py-1 text-right">{n1(x.fromPremium)}</td><td className="num py-1 text-right">{n1(x.toPremium)}</td><td className={`num py-1 text-right ${x.credit == null ? "" : x.credit >= 0 ? "text-up" : "text-down"}`}>{sg(x.credit)}</td></tr>)}</tbody></table></div>
              )}
              {s.rollsWithMissingPrice > 0 && <p className="mt-1 text-[11px] text-warn">{s.rollsWithMissingPrice} roll(s) have no credit because a price was missing at that sample; nothing is filled in.</p>}
            </section>
            {s.missingPoints > 0 && <p className="text-[11px] text-muted">{s.missingPoints} sample(s) have no straddle for the held strike (a price was missing) and are gaps in the line.</p>}
          </>
        ) : <EmptyState title="Not enough stored samples">The rolling straddle needs at least two samples with option prices for the strikes around the money.</EmptyState>}
      </Frame>
    </div>
  );
}
