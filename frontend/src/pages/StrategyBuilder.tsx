import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { EChart, useChartColors } from "../components/EChart";
import { Button, EmptyState, Panel } from "../components/ui";
import { BacktestPanel } from "../components/BacktestPanel";
import { payoffOption } from "../lib/chartOptions";
import { api } from "../lib/api";
import { fmtDateTimeIST, fmtInt, fmtPrice } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import {
  analyzeExpiry, DEFAULT_COSTS, expiryEnd, expiryPnl, legIv, netGreeks, newLegId, payoffCurve, roundTripCost,
  TEMPLATES, theoreticalPnl, validateStrategy, withIds, type CostModel, type Leg, type OptionType, type Template, type Valuation,
} from "../lib/strategy";

const SAVE_KEY = "nse.strategies.v1";
interface Saved { name: string; savedAt: string; underlying: string; legs: Leg[] }
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]") as Saved[]; } catch { return []; } };
const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "" : v > 0 ? "text-up" : "text-down");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function Stat({ label, value, hint, cls = "" }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="min-w-0 border-b border-rule/50 py-1.5" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num truncate text-[15px] font-medium ${cls || "text-paper"}`}>{value}</dd>
    </div>
  );
}

const fieldCls = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

export default function StrategyBuilder() {
  const colors = useChartColors();
  const ex = useExpiries();
  const available = ex.data?.available ?? [];
  const [mainExpiry, setMainExpiry] = useState<string | null>(null);
  const expiry = mainExpiry ?? ex.data?.weekly ?? available[0] ?? null;
  const [legs, setLegs] = useState<Leg[]>([]);
  const [tplMsg, setTplMsg] = useState<string | null>(null);
  const [costs, setCosts] = useState<CostModel>(DEFAULT_COSTS);
  const [rate, setRate] = useState(6);
  const [wi, setWi] = useState({ targetSpot: null as number | null, days: 0, ivShift: 0 });
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const [name, setName] = useState("");

  // chains for every expiry the strategy touches (the main one is always loaded)
  const needed = useMemo(() => [...new Set([...(expiry ? [expiry] : []), ...legs.map((l) => l.expiry)])], [expiry, legs]);
  const chains = useQueries({ queries: needed.map((e) => ({ queryKey: ["chain", e], queryFn: () => api.optionChain(e), retry: false, staleTime: 15_000, refetchInterval: 30_000 })) });
  const chainOf = (e: string) => chains[needed.indexOf(e)];
  const snap = expiry ? chainOf(expiry)?.data?.snapshot : undefined;
  const lotSize = snap?.lot_size ?? null;
  const spot = snap?.underlying_ltp ?? null;
  const strikesOf = (e: string) => chainOf(e)?.data?.snapshot.rows.map((r) => r.strike) ?? [];
  const ltpOf = (e: string, k: number, t: OptionType): number | null => {
    const row = chainOf(e)?.data?.snapshot.rows.find((r) => r.strike === k);
    const q = t === "CE" ? row?.call : row?.put;
    return q?.ltp != null && q.ltp > 0 ? q.ltp : null;
  };
  const atm = useMemo(() => {
    const ks = snap?.rows.map((r) => r.strike) ?? [];
    return spot == null || ks.length === 0 ? null : ks.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ks[0]!);
  }, [snap, spot]);

  const now = Date.now();
  const val: Valuation = { spotNow: spot ?? 0, nowMs: now, rate: rate / 100, ivShift: wi.ivShift / 100 };
  const issues = useMemo(
    () => validateStrategy(legs, { expiries: available, strikesByExpiry: Object.fromEntries(needed.map((e) => [e, strikesOf(e)])), today: todayIST() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legs, available, chains],
  );
  const errors = issues.filter((i) => i.level === "error");
  const ready = lotSize != null && legs.length > 0 && errors.length === 0;
  const a = useMemo(() => (lotSize ? analyzeExpiry(legs, lotSize) : null), [legs, lotSize]);

  const nearest = legs.length ? legs.map((l) => l.expiry).sort()[0]! : expiry;
  const maxDays = nearest ? Math.max(0, Math.floor((expiryEnd(nearest) - now) / 86_400_000)) : 0;
  const days = Math.min(wi.days, maxDays);
  const targetMs = now + days * 86_400_000;
  const targetSpot = wi.targetSpot ?? spot;

  const range = useMemo(() => {
    if (!spot) return null;
    const ks = legs.map((l) => l.strike);
    const lo = Math.min(spot * 0.92, ...(ks.length ? ks.map((k) => k * 0.97) : [spot])), hi = Math.max(spot * 1.08, ...(ks.length ? ks.map((k) => k * 1.03) : [spot]));
    const step = Math.max(1, Math.round((hi - lo) / 240));
    return { lo: Math.floor(lo / step) * step, hi, step };
  }, [spot, legs]);

  const curves = useMemo(() => {
    if (!ready || !range || !lotSize || !a?.defined) return null;
    const expiryCurve = payoffCurve(legs, lotSize, range.lo, range.hi, range.step);
    const target = days > 0 || wi.ivShift !== 0
      ? expiryCurve.map((p) => ({ s: p.s, pnl: theoreticalPnl(legs, p.s, targetMs, lotSize, val) }))
      : null;
    return { expiryCurve, target };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, range, lotSize, a, legs, days, wi.ivShift, rate]);

  const multi = legs.length > 0 && new Set(legs.map((l) => l.expiry)).size > 1;
  const nowPnl = ready && lotSize && targetSpot ? theoreticalPnl(legs, targetSpot, targetMs, lotSize, val) : null;
  const expPnl = ready && lotSize && targetSpot && !multi ? expiryPnl(legs, targetSpot, lotSize) : null;
  const greeks = ready && lotSize && spot ? netGreeks(legs, lotSize, val) : null;
  const netPremium = legs.every((l) => l.premium != null) ? legs.reduce((s, l) => s + (l.action === "SELL" ? 1 : -1) * (l.premium as number) * l.lots * (lotSize ?? 0), 0) : null;
  const unreal = legs.every((l) => l.premium != null && ltpOf(l.expiry, l.strike, l.type) != null) && lotSize
    ? legs.reduce((s, l) => s + (l.action === "BUY" ? 1 : -1) * ((ltpOf(l.expiry, l.strike, l.type) as number) - (l.premium as number)) * l.lots * lotSize, 0) : null;
  const estCost = ready && lotSize && !multi ? roundTripCost(legs, (l) => Math.max(0, (l.type === "CE" ? Math.max((targetSpot ?? 0) - l.strike, 0) : Math.max(l.strike - (targetSpot ?? 0), 0))), lotSize, costs) : null;

  const update = (id: string, patch: Partial<Leg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLeg = () => {
    if (!expiry || atm == null) return;
    setLegs((ls) => [...ls, { id: newLegId(), expiry, strike: atm, type: "CE", action: "BUY", lots: 1, premium: ltpOf(expiry, atm, "CE"), premiumSource: ltpOf(expiry, atm, "CE") == null ? null : "market" }]);
  };
  const apply = (t: Template) => {
    if (!expiry || atm == null || !snap) { setTplMsg("Load an option chain first."); return; }
    const next = available.filter((e) => e > expiry).sort()[0] ?? null;
    const r = t.build({ strikes: strikesOf(expiry), atm, expiry, nextExpiry: next, premium: ltpOf });
    if ("error" in r) { setTplMsg(r.error); return; }
    setTplMsg(null);
    setLegs(withIds(r));
  };
  const chooseStrike = (l: Leg, strike: number) => {
    const m = ltpOf(l.expiry, strike, l.type);
    update(l.id, { strike, premium: l.premiumSource === "manual" ? l.premium : m, premiumSource: l.premiumSource === "manual" ? "manual" : m == null ? null : "market" });
  };
  const persist = (s: Saved[]) => { setSaved(s); try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: kept for this visit only */ } };

  const chart = useMemo(() => (curves && a?.defined && targetSpot ? payoffOption({
    expiry: curves.expiryCurve, target: curves.target, spot: spot ?? targetSpot, targetSpot, breakevens: a.breakevens,
    targetLabel: `Estimated ${days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : "now"}${wi.ivShift ? `, IV ${wi.ivShift > 0 ? "+" : ""}${wi.ivShift}` : ""} (model)`,
  }, colors) : null), [curves, a, spot, targetSpot, days, wi.ivShift, colors]);

  const chainState = expiry ? chainOf(expiry) : undefined;

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Strategy builder</h1>
        <p className="mt-1 max-w-[80ch] text-sm text-muted">Build a multi-leg options position from the stored NIFTY option chain, see its payoff, risk and Greeks, then test it on the option data NSE Universe has stored. Expiry payoff is exact arithmetic; the dashed estimate is a Black-76 model value, not a market price.</p>
      </div>

      <Panel title="1 · Instrument and expiry">
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <div><div className="text-xs text-muted">Underlying</div><div className="text-paper">NIFTY 50</div><div className="max-w-[34ch] text-[11px] text-muted">The only instrument NSE Universe collects option data for. BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX need their own contract master and data feed.</div></div>
          <label className="flex flex-col gap-1 text-xs text-muted">Expiry
            <select className={fieldCls} value={expiry ?? ""} onChange={(e) => setMainExpiry(e.target.value)} aria-label="Expiry">
              {available.map((e) => <option key={e} value={e}>{e}{e === ex.data?.weekly ? " (weekly)" : e === ex.data?.monthly ? " (monthly)" : ""}</option>)}
            </select>
          </label>
          <div><div className="text-xs text-muted">Spot (snapshot)</div><div className="num text-paper">{spot == null ? "—" : fmtPrice(spot)}</div></div>
          <div><div className="text-xs text-muted">Lot size</div><div className="num text-paper" title="From the broker's instrument data in the stored chain">{lotSize ?? "—"}</div></div>
          <div><div className="text-xs text-muted">Chain snapshot</div><div className={`num ${chainState?.data?.stale ? "text-warn" : "text-paper"}`}>{snap ? fmtDateTimeIST(snap.retrieved_at) : "—"}{chainState?.data?.stale ? " · stale" : ""}</div></div>
          <label className="flex flex-col gap-1 text-xs text-muted">Interest rate % (model)
            <input type="number" step="0.25" className={`${fieldCls} w-24`} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Interest rate" />
          </label>
        </div>
        {chainState?.isPending && <p className="mt-2 text-sm text-muted">Loading the stored option chain…</p>}
        {chainState?.error && <p role="alert" className="mt-2 text-sm text-warn">No stored chain for {expiry}: capture one from Live option chain first. Strikes and market premiums come from it; nothing is made up.</p>}
        {snap && lotSize == null && <p role="alert" className="mt-2 text-sm text-down">The stored chain carries no lot size, so P&L in rupees cannot be computed. It is not assumed.</p>}
      </Panel>

      <Panel title="2 · Strategy" actions={<div className="flex items-center gap-2"><Button onClick={addLeg} disabled={atm == null}>Add leg</Button><Button onClick={() => setLegs([])} disabled={legs.length === 0}>Clear</Button></div>}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">Template
              <select className={fieldCls} aria-label="Template" defaultValue="" onChange={(e) => { const t = TEMPLATES.find((x) => x.id === e.target.value); if (t) apply(t); e.target.value = ""; }}>
                <option value="" disabled>Choose a template…</option>
                {(["Directional", "Neutral", "Spreads", "Multi-expiry"] as const).map((g) => (
                  <optgroup key={g} label={g}>{TEMPLATES.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.label} · {t.view}</option>)}</optgroup>
                ))}
              </select>
            </label>
            <span className="pb-2 text-xs text-muted">A template fills editable legs around the ATM strike ({atm == null ? "—" : fmtInt(atm)}) using listed strikes and stored market premiums.</span>
          </div>
          {tplMsg && <p role="alert" className="text-sm text-warn" data-testid="template-msg">{tplMsg}</p>}
          {legs.length === 0 ? <EmptyState title="No legs yet">Pick a template or add a leg.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Strategy legs">
                <thead className="text-xs text-muted"><tr>
                  {["Action", "Type", "Expiry", "Strike", "Lots", "Entry premium", "Source", "Market premium", "IV", "Position value", "Unrealised P&L", ""].map((h) => <th key={h} className="px-1 py-1 text-left font-normal">{h}</th>)}
                </tr></thead>
                <tbody>
                  {legs.map((l) => {
                    const mk = ltpOf(l.expiry, l.strike, l.type);
                    const iv = spot && l.premium != null ? legIv(l, val) : null;
                    const issue = issues.filter((i) => i.legId === l.id);
                    return (
                      <tr key={l.id} className="border-t border-rule/50 align-top" data-testid={`leg-${l.id}`}>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Action" value={l.action} onChange={(e) => update(l.id, { action: e.target.value as Leg["action"] })}><option>BUY</option><option>SELL</option></select></td>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Option type" value={l.type} onChange={(e) => { const t = e.target.value as OptionType; const m = ltpOf(l.expiry, l.strike, t); update(l.id, { type: t, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) }); }}><option>CE</option><option>PE</option></select></td>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Leg expiry" value={l.expiry} onChange={(e) => update(l.id, { expiry: e.target.value, premium: null, premiumSource: null })}>{available.map((e) => <option key={e}>{e}</option>)}</select></td>
                        <td className="px-1 py-1">
                          {strikesOf(l.expiry).length ? <select className={fieldCls} aria-label="Strike" value={l.strike} onChange={(e) => chooseStrike(l, Number(e.target.value))}>{!strikesOf(l.expiry).includes(l.strike) && <option value={l.strike}>{l.strike} (not listed)</option>}{strikesOf(l.expiry).map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}</select>
                            : <input className={`${fieldCls} w-24`} type="number" aria-label="Strike" value={l.strike} onChange={(e) => update(l.id, { strike: Number(e.target.value) })} />}
                        </td>
                        <td className="px-1 py-1"><input className={`${fieldCls} w-16`} type="number" min={1} step={1} aria-label="Lots" value={l.lots} onChange={(e) => update(l.id, { lots: Number(e.target.value) })} /></td>
                        <td className="px-1 py-1"><input className={`${fieldCls} w-24`} type="number" min={0} step="0.05" aria-label="Entry premium" value={l.premium ?? ""} placeholder="enter" onChange={(e) => update(l.id, { premium: e.target.value === "" ? null : Number(e.target.value), premiumSource: e.target.value === "" ? null : "manual" })} /></td>
                        <td className="px-1 py-1 text-xs text-muted">{l.premiumSource === "market" ? "stored quote" : l.premiumSource === "manual" ? "you entered" : "missing"}{mk != null && l.premiumSource !== "market" && <button type="button" className="ml-1 text-info hover:underline" onClick={() => update(l.id, { premium: mk, premiumSource: "market" })}>use {fmtPrice(mk)}</button>}</td>
                        <td className="num px-1 py-1">{mk == null ? <span className="text-muted" title="No quote in the stored chain for this contract">—</span> : fmtPrice(mk)}</td>
                        <td className="num px-1 py-1 text-xs" title={iv?.source}>{iv?.iv == null ? "—" : `${(iv.iv * 100).toFixed(1)}%`}</td>
                        <td className="num px-1 py-1">{l.premium == null || !lotSize ? "—" : money((l.action === "SELL" ? 1 : -1) * l.premium * l.lots * lotSize)}</td>
                        <td className={`num px-1 py-1 ${tone(mk != null && l.premium != null && lotSize ? (l.action === "BUY" ? 1 : -1) * (mk - l.premium) * l.lots * lotSize : null)}`}>{mk != null && l.premium != null && lotSize ? money((l.action === "BUY" ? 1 : -1) * (mk - l.premium) * l.lots * lotSize) : "—"}</td>
                        <td className="whitespace-nowrap px-1 py-1">
                          <button type="button" className="mr-2 text-xs text-info hover:underline" aria-label="Duplicate leg" onClick={() => setLegs((ls) => { const i = ls.findIndex((x) => x.id === l.id); const c = [...ls]; c.splice(i + 1, 0, { ...l, id: newLegId() }); return c; })}>Duplicate</button>
                          <button type="button" className="text-xs text-down hover:underline" aria-label="Remove leg" onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}>Remove</button>
                          {issue.map((i) => <div key={i.field + i.message} role={i.level === "error" ? "alert" : undefined} className={`max-w-[28ch] whitespace-normal text-[11px] ${i.level === "error" ? "text-down" : "text-warn"}`}>{i.message}</div>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">Market premium is the last traded price in the stored snapshot at {snap ? fmtDateTimeIST(snap.retrieved_at) : "—"}, not a live quote. Net premium: <span className={`num ${tone(netPremium)}`}>{netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`}</span>{unreal != null && <> · unrealised vs snapshot: <span className={`num ${tone(unreal)}`}>{money(unreal)}</span></>}</p>
          <div className="flex flex-wrap items-end gap-2 border-t border-rule/50 pt-2">
            <label className="flex flex-col gap-1 text-xs text-muted">Save as<input className={`${fieldCls} w-48`} aria-label="Strategy name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name" /></label>
            <Button disabled={!name.trim() || legs.length === 0} onClick={() => { persist([{ name: name.trim(), savedAt: new Date().toISOString(), underlying: "NIFTY", legs }, ...saved.filter((s) => s.name !== name.trim())]); setName(""); }}>Save</Button>
            {saved.length > 0 && (
              <label className="flex flex-col gap-1 text-xs text-muted">Saved strategies
                <select className={fieldCls} aria-label="Saved strategies" defaultValue="" onChange={(e) => { const s = saved.find((x) => x.name === e.target.value); if (s) setLegs(s.legs.map((l) => ({ ...l, id: newLegId() }))); e.target.value = ""; }}>
                  <option value="" disabled>Load…</option>{saved.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.legs.length} legs</option>)}
                </select>
              </label>
            )}
            {saved.length > 0 && <Button onClick={() => persist([])} title="Delete every saved strategy from this browser">Delete saved</Button>}
          </div>
          <p className="text-[11px] text-muted">Saved strategies stay in this browser only.</p>
        </div>
      </Panel>

      <Panel title="3 · Payoff and risk">
        {!ready ? <p className="text-sm text-muted" data-testid="payoff-empty">{legs.length === 0 ? "Add legs to see the payoff." : lotSize == null ? "Waiting for a stored chain with a lot size." : errors.length ? "Fix the highlighted legs to see the payoff." : "Enter the entry premium of every leg."}</p> : (
          <div className="space-y-3">
            {a && !a.defined && <p className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" data-testid="payoff-note">{a.reason}</p>}
            <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
              <div className="h-[340px]">{chart ? <EChart option={chart} ariaLabel="Strategy payoff" /> : <p className="text-sm text-muted">The model estimate for several expiries is shown in the table below.</p>}</div>
              <dl className="grid grid-cols-2 content-start gap-x-4 lg:grid-cols-1" data-testid="risk-stats">
                <Stat label="Max profit" value={a?.defined ? (a.profitUnlimited ? "Unlimited" : money(a.maxProfit)) : "—"} cls={tone(1)} hint="Largest P&L at expiry over every price from 0 upwards" />
                <Stat label="Max loss" value={a?.defined ? (a.lossUnlimited ? "Unlimited" : money(a.maxLoss)) : "—"} cls={tone(-1)} hint="Largest loss at expiry over every price from 0 upwards" />
                <Stat label="Breakeven at expiry" value={a?.defined ? (a.breakevens.length ? a.breakevens.map((b) => fmtInt(Math.round(b * 100) / 100)).join(" · ") : "none") : "—"} />
                <Stat label="Net premium" value={netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`} />
                <Stat label="Net delta" value={greeks ? greeks.delta.toFixed(1) : "—"} hint="Change in P&L (rupees) for a 1-point rise in NIFTY, from the model" />
                <Stat label="Net gamma" value={greeks ? greeks.gamma.toFixed(4) : "—"} />
                <Stat label="Net theta / day" value={greeks ? money(greeks.thetaDay) : "—"} cls={tone(greeks?.thetaDay ?? null)} hint="Model P&L change from one day passing, spot and volatility unchanged" />
                <Stat label="Net vega / vol point" value={greeks ? money(greeks.vegaPt) : "—"} cls={tone(greeks?.vegaPt ?? null)} />
              </dl>
            </div>
            {greeks && greeks.unavailable.length > 0 && <p className="text-xs text-warn">Greeks exclude {greeks.unavailable.join(", ")}: no volatility fits the entered premium.</p>}
            <fieldset className="grid gap-3 rounded-sm border border-rule p-3 sm:grid-cols-3">
              <legend className="px-1 text-xs text-muted">What-if (model estimate, not a market price)</legend>
              <label className="text-xs text-muted">Target spot: <span className="num text-paper">{targetSpot == null ? "—" : fmtInt(Math.round(targetSpot))}</span>
                <input type="range" className="w-full" aria-label="Target spot" min={Math.round((spot ?? 0) * 0.9)} max={Math.round((spot ?? 0) * 1.1)} step={Math.max(1, Math.round((spot ?? 0) / 2000))} value={targetSpot ?? 0} onChange={(e) => setWi((w) => ({ ...w, targetSpot: Number(e.target.value) }))} /></label>
              <label className="text-xs text-muted">Days from now: <span className="num text-paper">{days}</span> of {maxDays}
                <input type="range" className="w-full" aria-label="Days from now" min={0} max={maxDays} step={1} value={days} onChange={(e) => setWi((w) => ({ ...w, days: Number(e.target.value) }))} /></label>
              <label className="text-xs text-muted">Volatility change: <span className="num text-paper">{wi.ivShift > 0 ? "+" : ""}{wi.ivShift} points</span>
                <input type="range" className="w-full" aria-label="Volatility change" min={-10} max={10} step={1} value={wi.ivShift} onChange={(e) => setWi((w) => ({ ...w, ivShift: Number(e.target.value) }))} /></label>
              <dl className="grid grid-cols-2 gap-x-4 sm:col-span-3 sm:grid-cols-4">
                <Stat label="Estimated P&L at target" value={nowPnl == null ? "unavailable" : money(nowPnl)} cls={tone(nowPnl)} hint="Black-76 estimate on the chosen date, spot and volatility change" />
                <Stat label="P&L at expiry if spot = target" value={multi ? "n/a (several expiries)" : money(expPnl)} cls={tone(expPnl)} />
                <Stat label="Estimated costs (round trip)" value={estCost == null ? "—" : money(-estCost)} hint="Entry plus closing each leg at its expiry value, using the cost assumptions below" />
                <Stat label="Estimated net at expiry" value={expPnl == null || estCost == null ? "—" : money(expPnl - estCost)} cls={tone(expPnl == null || estCost == null ? null : expPnl - estCost)} />
              </dl>
              <button type="button" className="text-left text-xs text-info hover:underline sm:col-span-3" onClick={() => setWi({ targetSpot: null, days: 0, ivShift: 0 })}>Reset what-if</button>
            </fieldset>
            {range && lotSize && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="P&L table">
                  <caption className="mb-1 text-left text-xs text-muted">P&L by NIFTY level: exact at expiry, model estimate on the chosen date</caption>
                  <thead className="text-xs text-muted"><tr><th className="text-left font-normal">NIFTY</th><th className="text-right font-normal">At expiry</th><th className="text-right font-normal">Estimate on target date</th></tr></thead>
                  <tbody>
                    {[-5, -3, -2, -1, 0, 1, 2, 3, 5].map((pct) => {
                      const s = Math.round((spot ?? 0) * (1 + pct / 100));
                      const e = multi ? null : expiryPnl(legs, s, lotSize);
                      const t = theoreticalPnl(legs, s, targetMs, lotSize, val);
                      return <tr key={pct} className="num border-t border-rule/50"><td>{fmtInt(s)} <span className="text-muted">({pct > 0 ? "+" : ""}{pct}%)</span></td><td className={`text-right ${tone(e)}`}>{money(e)}</td><td className={`text-right ${tone(t)}`}>{money(t)}</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-sm text-info">Cost assumptions (editable; statutory rates change, check your contract note)</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                {([["brokeragePerOrder", "Brokerage per leg (₹)"], ["sttSellPct", "STT on sell premium (%)"], ["exchangePct", "Exchange charges (%)"], ["sebiPct", "SEBI fee (%)"], ["stampBuyPct", "Stamp duty on buy (%)"], ["gstPct", "GST (%)"], ["slippagePerUnit", "Slippage per unit (₹)"]] as [keyof CostModel, string][]).map(([k, label]) => (
                  <label key={k} className="flex flex-col gap-1 text-xs text-muted">{label}<input type="number" step="any" className={fieldCls} value={costs[k]} aria-label={label} onChange={(e) => setCosts((c) => ({ ...c, [k]: Number(e.target.value) }))} /></label>
                ))}
              </div>
            </details>
          </div>
        )}
      </Panel>

      <BacktestPanel legs={legs} lotSize={lotSize} atm={atm} strikes={expiry ? strikesOf(expiry) : []} costs={costs} />
    </div>
  );
}

