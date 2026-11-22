import { useMemo, type ReactNode } from "react";
import {
  attribution, closeToCloseVol, deltaFlipSpot, forwardVol, gammaThetaBreakeven, greekLadder, hedgeSheet, largestMoves, marketExposure, nameOf, positionGreeks,
  replayMoves, reverseStress, smileFactors, smileMetrics, stressGrid, valueAtRisk, vegaBuckets, type AttribInput, type PLeg,
} from "../../lib/advancedGreeks";
import { fmtExpiry, fmtInt, MISSING } from "../../lib/format";
import { expiryEnd } from "../../lib/optionModel";
import type { BuilderPosition } from "../../lib/builderPosition";
import type { OptionChainRow } from "../../lib/types";

const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? MISSING : v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const rs = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? MISSING : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${(v * 100).toFixed(d)} %`);
const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-up" : v < 0 ? "text-down" : "");

function Card({ title, note, children, id }: { title: string; note?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="rounded-sm border border-rule bg-slate p-3" data-testid={id}>
      <h2 className="text-sm font-semibold text-paper">{title}</h2>
      {note && <p className="mb-2 mt-0.5 text-xs text-muted">{note}</p>}
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}
const Th = ({ children }: { children: ReactNode }) => <th className="px-2 py-1 text-right text-xs font-semibold text-muted first:text-left">{children}</th>;
const Td = ({ children, cls = "" }: { children: ReactNode; cls?: string }) => <td className={`num px-2 py-1 text-right text-xs first:text-left ${cls}`}>{children}</td>;

export interface AdvancedProps {
  pos: BuilderPosition;
  nowMs: number;
  rate: number;
  lotSize: number | null;
  rows: Record<string, readonly OptionChainRow[]>;
  closes: { day: string; close: number }[] | null;
  entryLevel: (leg: PLeg) => { spot: number; ms: number } | null;
  nowPrice: (leg: PLeg) => number | null;
}

/** The institutional risk views of the Strategy Builder's strategy (Black-76, sticky strike). Every figure is a model estimate from stored prices. */
export function AdvancedPanels({ pos, nowMs, rate, lotSize, rows, closes, entryLevel, nowPrice }: AdvancedProps) {
  const m = useMemo(() => ({ rate }), [rate]);
  const { legs, spot } = pos;
  const mainExpiry = useMemo(() => [...new Set(legs.map((l) => l.expiry))].sort()[0] ?? null, [legs]);
  const atmIv = (mainExpiry && pos.books.get(mainExpiry)?.atmIv) || null;
  const calc = useMemo(() => {
    if (!spot || !legs.length) return null;
    const ladder = greekLadder(legs, spot, nowMs, m);
    const g = positionGreeks(legs, spot, nowMs, m);
    const real = (n: number) => (closes && closes.length > n ? closeToCloseVol(closes.slice(-(n + 1)).map((c) => c.close)) : null);
    const r20 = real(20), sigma = atmIv ?? r20;
    return {
      ladder, g, flip: deltaFlipSpot(ladder), hedge: lotSize ? hedgeSheet(ladder, lotSize) : null,
      real: { 5: real(5), 10: real(10), 20: r20 },
      be: gammaThetaBreakeven(g.gamma, g.theta, spot, atmIv, r20),
      perLeg: legs.map((l) => ({ l, g: positionGreeks([l], spot, nowMs, m) })),
      vb: vegaBuckets(legs, spot, nowMs, m), sf: smileFactors(legs, spot, nowMs, m),
      sigma, var: sigma ? valueAtRisk(legs, spot, nowMs, m, sigma) : null,
      stress: sigma ? stressGrid(legs, spot, nowMs, m, sigma) : [],
      moves: closes ? largestMoves(closes, 3) : [],
    };
  }, [legs, spot, nowMs, m, atmIv, lotSize, closes]);
  const attr = useMemo(() => {
    if (!spot) return null;
    const inputs: AttribInput[] = legs.map((l) => { const e = entryLevel(l); return { leg: l, entrySpot: e?.spot ?? null, entryMs: e?.ms ?? null, nowSpot: spot, nowMs, nowPrice: l.type === "FUT" ? nowPrice(l) : nowPrice(l) }; });
    return attribution(inputs, m);
  }, [legs, spot, nowMs, m, entryLevel, nowPrice]);
  const smile = useMemo(() => [...pos.books.values()].sort((a, b) => a.expiry.localeCompare(b.expiry)).map((b) => {
    const rws = [...b.deltas].map(([strike, d]) => ({ strike, ceIv: d.ceIv, ceDelta: d.ce, peIv: d.peIv, peDelta: d.pe }));
    const T = (expiryEnd(b.expiry) - nowMs) / (365 * 86_400_000);
    return { expiry: b.expiry, T, ...smileMetrics(rws, b.atmIv) };
  }), [pos.books, nowMs]);
  const exposure = useMemo(() => {
    if (!spot || !mainExpiry) return null;
    const rws = rows[mainExpiry];
    const b = pos.books.get(mainExpiry);
    if (!rws || !b) return null;
    const ex = marketExposure(rws.map((r) => ({ strike: r.strike, ceIv: b.deltas.get(r.strike)?.ceIv ?? null, peIv: b.deltas.get(r.strike)?.peIv ?? null, ceOi: r.call?.oi ?? null, peOi: r.put?.oi ?? null })), spot, mainExpiry, nowMs, m, b.carry);
    return ex.filter((e) => e.vanna != null && Math.abs(e.strike - spot) <= spot * 0.05);
  }, [rows, mainExpiry, pos.books, spot, nowMs, m]);

  if (!legs.length) return <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="adv-empty">The Strategy Builder has no open legs. Build or load a strategy there and its risk views appear here.</p>;
  if (!spot) return <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="adv-nospot">No stored chain with an index level is available yet, so nothing can be valued.</p>;
  if (!calc || !spot) return null;
  const { ladder, g, hedge, be, vb, sf } = calc;
  const fwd = smile.length >= 2 ? forwardVol(smile[0]!.atm ?? NaN, smile[0]!.T, smile[1]!.atm ?? NaN, smile[1]!.T) : null;
  const step = (x: number) => Math.round(x * 1000) / 1000;
  return (
    <div className="flex flex-col gap-3" data-testid="adv-panels">
      <p className="px-1 text-xs text-muted" data-testid="adv-assumptions">
        Model: Black-76, each option at the volatility its own stored price implies (sticky strike), carry read from the chain, rate {step(rate * 100)} %. Time-decay is per calendar day. Index {num(spot)} at the stored chain's market time.
        {pos.unvalued.length > 0 && <span className="text-warn"> No volatility for {pos.unvalued.join(", ")}: {pos.unvalued.length === 1 ? "it is" : "they are"} left out of the Greeks, never counted as zero.</span>}
      </p>

      <Card id="adv-ladder" title="Greek ladder" note={`The position's Greeks and its P&L if the index were at each level now (volatility and time held).${calc.flip ? ` Net delta changes sign near ${fmtInt(calc.flip)}.` : ""}`}>
        <table className="w-full min-w-[640px]"><thead><tr><Th>Move</Th><Th>Index</Th><Th>P&L</Th><Th>Delta</Th><Th>Gamma</Th><Th>Vega / pt</Th><Th>Theta / day</Th></tr></thead>
          <tbody>{ladder.map((r) => (<tr key={r.pct} className={r.pct === 0 ? "bg-rule/30 font-semibold" : ""}><Td>{r.pct > 0 ? "+" : ""}{r.pct} %</Td><Td>{fmtInt(r.spot)}</Td><Td cls={tone(r.pnl)}>{rs(r.pnl)}</Td><Td>{num(r.greeks.delta)}</Td><Td>{num(r.greeks.gamma, 4)}</Td><Td>{rs(r.greeks.vega)}</Td><Td>{rs(r.greeks.theta)}</Td></tr>))}</tbody></table>
      </Card>

      <Card id="adv-hedge" title="Delta hedge sheet" note="Futures lots that make the position delta-neutral (positive = buy, negative = sell), now and if the index moved first. No trading cost is estimated: the app holds no order-book depth.">
        {hedge ? (<table className="w-full min-w-[480px]"><thead><tr><Th>Index</Th><Th>Net delta</Th><Th>Lots to neutralise</Th><Th>Change from the hedge held now</Th></tr></thead>
          <tbody>{hedge.rows.map((r) => (<tr key={r.pct} className={r.pct === 0 ? "bg-rule/30 font-semibold" : ""}><Td>{fmtInt(r.spot)} ({r.pct > 0 ? "+" : ""}{r.pct} %)</Td><Td>{num(r.delta)}</Td><Td>{num(r.lots, 2)}</Td><Td>{r.pct === 0 ? MISSING : num(r.adjust, 2)}</Td></tr>))}</tbody></table>) : <p className="text-xs text-muted">No lot size for the chain: the sheet needs it.</p>}
      </Card>

      <Card id="adv-breakeven" title="Gamma against theta" note="The one-day index move at which gamma gains cancel theta: m = √(2·|theta| / |gamma|). Compared with the move the market implies (ATM volatility) and the move realised over the last 20 sessions.">
        {be ? (<div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div>Breakeven move <b className="num">{num(be.points, 0)} points</b> ({be.kind})</div>
          <div>Implied daily move <b className="num">{num(be.impliedDay, 0)} points</b> {be.impliedRatio != null && <>· breakeven is <b className="num">{num(be.impliedRatio, 2)}×</b> of it</>}</div>
          <div>Realised daily move (20 sessions) <b className="num">{num(be.realisedDay, 0)} points</b> {be.realisedRatio != null && <>· <b className="num">{num(be.realisedRatio, 2)}×</b></>}</div>
          <div className="text-muted">{be.kind === "long gamma pays theta" ? "Long gamma needs the index to move more than the breakeven each day to pay for its decay." : "Short gamma keeps its decay only while the index moves less than the breakeven."}</div></div>)
          : <p className="text-xs text-muted" data-testid="adv-no-breakeven">Gamma and theta have the same sign here (or one is zero), so there is no breakeven move.</p>}
      </Card>

      <Card id="adv-greeks" title="Higher-order Greeks" note="Net and by leg, in rupees. Vanna: change of delta per volatility point. Volga: change of vega per volatility point. Charm: change of delta per day. Closed forms, checked against finite differences of the price.">
        <table className="w-full min-w-[640px]"><thead><tr><Th>Leg</Th><Th>Delta</Th><Th>Gamma</Th><Th>Vega / pt</Th><Th>Theta / day</Th><Th>Vanna</Th><Th>Volga</Th><Th>Charm / day</Th></tr></thead>
          <tbody>{calc.perLeg.map(({ l, g: x }) => (<tr key={l.id}><Td>{l.qty > 0 ? "Long" : "Short"} {nameOf(l)} {fmtExpiry(l.expiry)}</Td><Td>{x.unavailable.length ? MISSING : num(x.delta)}</Td><Td>{x.unavailable.length ? MISSING : num(x.gamma, 4)}</Td><Td>{x.unavailable.length ? MISSING : rs(x.vega)}</Td><Td>{x.unavailable.length ? MISSING : rs(x.theta)}</Td><Td>{x.unavailable.length ? MISSING : num(x.vanna)}</Td><Td>{x.unavailable.length ? MISSING : num(x.volga)}</Td><Td>{x.unavailable.length ? MISSING : num(x.charm)}</Td></tr>))}
            <tr className="border-t border-rule font-semibold"><Td>Net</Td><Td>{num(g.delta)}</Td><Td>{num(g.gamma, 4)}</Td><Td>{rs(g.vega)}</Td><Td>{rs(g.theta)}</Td><Td>{num(g.vanna)}</Td><Td>{num(g.volga)}</Td><Td>{num(g.charm)}</Td></tr></tbody></table>
      </Card>

      <Card id="adv-vega" title="Where the vega sits" note="Rupees per volatility point by expiry and by strike zone, then exposure to three shapes of change of the smile (defined here, not fitted parameters): level = every strike +1 pt; skew = +1 pt at 5 % under the forward falling to −1 at 5 % over; curvature = +1 pt at ±5 %, 0 at the money.">
        <div className="grid gap-4 md:grid-cols-2">
          <table className="w-full"><tbody>{vb.byExpiry.map((e) => <tr key={e.expiry}><Td>{fmtExpiry(e.expiry)}</Td><Td cls={tone(e.vega)}>{rs(e.vega)}</Td></tr>)}{vb.byZone.map((z) => <tr key={z.zone}><Td>{z.zone}</Td><Td cls={tone(z.vega)}>{rs(z.vega)}</Td></tr>)}</tbody></table>
          <table className="w-full"><tbody><tr><Td>Level (+1 pt everywhere)</Td><Td cls={tone(sf.level)}>{rs(sf.level)}</Td></tr><tr><Td>Skew (steeper downside +1 pt)</Td><Td cls={tone(sf.skew)}>{rs(sf.skew)}</Td></tr><tr><Td>Curvature (wings +1 pt)</Td><Td cls={tone(sf.curvature)}>{rs(sf.curvature)}</Td></tr></tbody></table>
        </div>
      </Card>

      <Card id="adv-attribution" title="P&L by Greek since entry" note="Delta, gamma, vega and theta taken at the entry (index level, time and the volatility the entry price implies), with what they do not explain shown as the residual. A leg needs its entry price and a stored index level at the entry time.">
        {attr && attr.rows.length > 0 && (<table className="w-full min-w-[560px]"><thead><tr><Th>Leg</Th><Th>Delta</Th><Th>Gamma</Th><Th>Vega</Th><Th>Theta</Th><Th>Residual</Th><Th>Actual</Th></tr></thead>
          <tbody>{attr.rows.map((r) => <tr key={r.id}><Td>{r.name}</Td><Td cls={tone(r.delta)}>{rs(r.delta)}</Td><Td cls={tone(r.gamma)}>{rs(r.gamma)}</Td><Td cls={tone(r.vega)}>{rs(r.vega)}</Td><Td cls={tone(r.theta)}>{rs(r.theta)}</Td><Td cls={tone(r.residual)}>{rs(r.residual)}</Td><Td cls={tone(r.actual)}>{rs(r.actual)}</Td></tr>)}
            <tr className="border-t border-rule font-semibold"><Td>Total</Td><Td>{rs(attr.total.delta)}</Td><Td>{rs(attr.total.gamma)}</Td><Td>{rs(attr.total.vega)}</Td><Td>{rs(attr.total.theta)}</Td><Td>{rs(attr.total.residual)}</Td><Td>{rs(attr.total.actual)}</Td></tr></tbody></table>)}
        {attr && attr.skipped.length > 0 && <ul className="mt-1 text-xs text-muted" data-testid="adv-attr-skipped">{attr.skipped.map((s) => <li key={s.name}>{s.name}: {s.why}</li>)}</ul>}
      </Card>

      <Card id="adv-smile" title="Smile and term structure" note="25-delta quotes by expiry (each interpolated in delta between the two strikes that bracket 0.25): risk reversal = call − put (negative: puts richer); butterfly = average of the two − ATM. Forward volatility between the first two expiries: √((σ₂²T₂ − σ₁²T₁)/(T₂ − T₁)).">
        <table className="w-full min-w-[520px]"><thead><tr><Th>Expiry</Th><Th>ATM</Th><Th>25Δ call</Th><Th>25Δ put</Th><Th>Risk reversal</Th><Th>Butterfly</Th></tr></thead>
          <tbody>{smile.map((s) => <tr key={s.expiry}><Td>{fmtExpiry(s.expiry)}</Td><Td>{pct(s.atm)}</Td><Td>{pct(s.call25)}</Td><Td>{pct(s.put25)}</Td><Td>{pct(s.riskReversal, 2)}</Td><Td>{pct(s.butterfly, 2)}</Td></tr>)}</tbody></table>
        {smile.length >= 2 && <p className="mt-1 text-xs" data-testid="adv-fwdvol">Forward volatility {fmtExpiry(smile[0]!.expiry)} → {fmtExpiry(smile[1]!.expiry)}: <b className="num">{pct(fwd)}</b>{fwd == null && " (total variance falls between them, so none exists)"}</p>}
      </Card>

      <Card id="adv-implied-realised" title="Implied against realised volatility" note="ATM implied volatility of the nearest leg expiry against close-to-close realised volatility of the NIFTY index (annualised, √252). A positive gap is the premium option sellers are paid. Rank and percentile need more stored sessions than the app holds yet, so none is shown.">
        <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-4"><div>Implied (ATM) <b className="num">{pct(atmIv)}</b></div>
          {([5, 10, 20] as const).map((n) => <div key={n}>Realised {n} sessions <b className="num">{pct(calc.real[n])}</b>{atmIv != null && calc.real[n] != null && <span className="text-muted"> · gap {pct(atmIv - calc.real[n]!)}</span>}</div>)}</div>
        {!closes && <p className="mt-1 text-xs text-muted">Daily closes are not available, so realised volatility is left empty.</p>}
      </Card>

      <Card id="adv-exposure" title="Vanna and charm exposure by strike" note={`Of the market, not your position, for ${mainExpiry ? fmtExpiry(mainExpiry) : ""} within 5 % of the index. Convention (an assumption, not an observed position): the market is long calls and short puts, so calls count positive and puts negative. Vanna = change of the market's delta per volatility point × open interest; charm = per day.`}>
        {exposure && exposure.length ? (<table className="w-full min-w-[360px]"><thead><tr><Th>Strike</Th><Th>Vanna exposure</Th><Th>Charm exposure / day</Th></tr></thead>
          <tbody>{exposure.map((e) => <tr key={e.strike}><Td>{fmtInt(e.strike)}</Td><Td cls={tone(e.vanna)}>{num(e.vanna, 0)}</Td><Td cls={tone(e.charm)}>{num(e.charm, 0)}</Td></tr>)}</tbody></table>) : <p className="text-xs text-muted">No open interest and volatility for strikes near the index.</p>}
      </Card>

      <Card id="adv-var" title="One-day value at risk (model estimate)" note={`Full revaluation of every leg on ${num(calc.var?.paths ?? 0, 0)} seeded paths (same seed, same answer): lognormal index move, one trading day, volatility ${pct(calc.sigma)} (the nearest leg expiry's ATM implied volatility), each option kept at its own volatility, one calendar day of decay. A normal-distribution estimate: it understates gaps and is not a forecast. Delta-only closed form shown as a check.`}>
        {calc.var ? (<table className="w-full min-w-[420px]"><thead><tr><Th>Level</Th><Th>VaR (full revaluation)</Th><Th>Expected shortfall</Th><Th>Delta-only check</Th></tr></thead>
          <tbody><tr><Td>95 %</Td><Td>{rs(-calc.var.var95)}</Td><Td>{rs(-calc.var.es95)}</Td><Td>{rs(calc.var.deltaNormal95 == null ? null : -calc.var.deltaNormal95)}</Td></tr>
            <tr><Td>99 %</Td><Td>{rs(-calc.var.var99)}</Td><Td>{rs(-calc.var.es99)}</Td><Td>{rs(calc.var.deltaNormal99 == null ? null : -calc.var.deltaNormal99)}</Td></tr></tbody></table>) : <p className="text-xs text-muted" data-testid="adv-no-var">Not available: a leg cannot be valued, or there is no volatility to size the move.</p>}
      </Card>

      <Card id="adv-stress" title="Stress tests" note="P&L now (time held) for index moves in one-day standard deviations with a parallel volatility shift; the largest daily index moves in the stored closes replayed on this position; and the smallest moves that lose a chosen amount.">
        {calc.stress.length > 0 && (<table className="w-full min-w-[560px]"><thead><tr><Th>Vol shift</Th>{[-3, -2, -1, 0, 1, 2, 3].map((k) => <Th key={k}>{k > 0 ? "+" : ""}{k} sd</Th>)}</tr></thead>
          <tbody>{[-5, 0, 5].map((vs) => <tr key={vs}><Td>{vs > 0 ? "+" : ""}{vs} pts</Td>{[-3, -2, -1, 0, 1, 2, 3].map((k) => { const c = calc.stress.find((x) => x.k === k && x.volShift === vs); return <Td key={k} cls={tone(c?.pnl)}>{rs(c?.pnl)}</Td>; })}</tr>)}</tbody></table>)}
        <Replay legs={legs} spot={spot} nowMs={nowMs} m={m} moves={calc.moves} />
        <Reverse legs={legs} spot={spot} nowMs={nowMs} m={m} />
      </Card>

      <section className="rounded-sm border border-rule bg-slate p-3 text-xs text-muted" data-testid="adv-unavailable">
        <b className="text-paper">Not available from the data this app holds:</b> the cost of unwinding (no stored order-book depth per option), margin and SPAN requirements, funding and counterparty exposure, and any live P&L from a broker. They are not zero; they are not known. Percentile ranks wait for more stored sessions.
      </section>
    </div>
  );
}

function Replay({ legs, spot, nowMs, m, moves }: { legs: PLeg[]; spot: number; nowMs: number; m: { rate: number }; moves: { label: string; pct: number }[] }) {
  const out = useMemo(() => replayMoves(legs, spot, nowMs, m, moves), [legs, spot, nowMs, m, moves]);
  if (!out.length) return <p className="mt-2 text-xs text-muted">Daily closes are not available, so no historical move can be replayed.</p>;
  return (<table className="mt-3 w-full min-w-[360px]" data-testid="adv-replay"><thead><tr><Th>Day</Th><Th>Index move</Th><Th>Position P&L</Th></tr></thead>
    <tbody>{out.map((r) => <tr key={r.label}><Td>{r.label}</Td><Td cls={tone(r.pct)}>{r.pct > 0 ? "+" : ""}{r.pct.toFixed(2)} %</Td><Td cls={tone(r.pnl)}>{rs(r.pnl)}</Td></tr>)}</tbody></table>);
}
const LOSSES = [25_000, 50_000, 100_000] as const;
function Reverse({ legs, spot, nowMs, m }: { legs: PLeg[]; spot: number; nowMs: number; m: { rate: number } }) {
  const out = useMemo(() => LOSSES.map((loss) => ({ loss, ...reverseStress(legs, spot, nowMs, m, loss) })), [legs, spot, nowMs, m]);
  return (<table className="mt-3 w-full min-w-[360px]" data-testid="adv-reverse"><thead><tr><Th>Loss of</Th><Th>Index move down</Th><Th>Index move up</Th></tr></thead>
    <tbody>{out.map((r) => <tr key={r.loss}><Td>₹{r.loss.toLocaleString("en-IN")}</Td><Td>{r.down == null ? "not within −15 %" : `${r.down.toFixed(2)} % (${fmtInt(spot * (1 + r.down / 100))})`}</Td><Td>{r.up == null ? "not within +15 %" : `+${r.up.toFixed(2)} % (${fmtInt(spot * (1 + r.up / 100))})`}</Td></tr>)}</tbody></table>);
}
