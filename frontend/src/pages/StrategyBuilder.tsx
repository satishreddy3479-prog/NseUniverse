import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EChart, useChartColors } from "../components/EChart";
import { Button, EmptyState, Panel } from "../components/ui";
import { payoffOption } from "../lib/chartOptions";
import { api } from "../lib/api";
import { compactIN } from "../lib/analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { analyzeExpiry, newLegId, payoffCurve, TEMPLATES, validateStrategy, withIds, type Action, type Leg, type OptionType, type Template } from "../lib/strategy";

const SAVE_KEY = "nse.strategies.v1";
interface Saved { name: string; savedAt: string; expiry: string; legs: Leg[] }
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]") as Saved[]; } catch { return []; } };
const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "" : v > 0 ? "text-up" : "text-down");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fieldCls = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const CHAIN_WIDTHS = [5, 10, 20, "all"] as const;

function Stat({ label, value, hint, cls = "" }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="min-w-0 border-b border-rule/50 py-1.5" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num truncate text-[15px] font-medium ${cls || "text-paper"}`}>{value}</dd>
    </div>
  );
}

export default function StrategyBuilder() {
  const colors = useChartColors();
  const ex = useExpiries();
  const available = ex.data?.available ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const expiry = picked ?? ex.data?.weekly ?? available[0] ?? null;
  const [legs, setLegs] = useState<Leg[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof CHAIN_WIDTHS)[number]>(10);
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const [name, setName] = useState("");

  const chain = useQuery({ queryKey: ["chain", expiry], queryFn: () => api.optionChain(expiry!), enabled: !!expiry, retry: false, staleTime: 15_000, refetchInterval: 30_000 });
  const snap = chain.data?.snapshot;
  const lotSize = snap?.lot_size ?? null;
  const spot = snap?.underlying_ltp ?? null;
  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const strikes = useMemo(() => rows.map((r) => r.strike), [rows]);
  const atm = useMemo(() => (spot == null || strikes.length === 0 ? null : strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), strikes[0]!)), [strikes, spot]);
  const ltp = (k: number, t: OptionType): number | null => {
    const row = rows.find((r) => r.strike === k);
    const q = t === "CE" ? row?.call : row?.put;
    return q?.ltp != null && q.ltp > 0 ? q.ltp : null;
  };
  const shown = useMemo(() => {
    if (width === "all" || atm == null) return rows;
    const i = rows.findIndex((r) => r.strike === atm);
    return rows.slice(Math.max(0, i - width), i + width + 1);
  }, [rows, atm, width]);

  const issues = useMemo(
    () => validateStrategy(legs, { expiries: available, strikesByExpiry: expiry ? { [expiry]: strikes } : {}, today: todayIST() }),
    [legs, available, expiry, strikes],
  );
  const errors = issues.filter((i) => i.level === "error");
  const ready = lotSize != null && legs.length > 0 && errors.length === 0;
  const a = useMemo(() => (lotSize ? analyzeExpiry(legs, lotSize) : null), [legs, lotSize]);
  const curve = useMemo(() => {
    if (!ready || !a?.defined || !lotSize || !spot) return null;
    const ks = legs.map((l) => l.strike);
    const lo = Math.min(spot * 0.92, ...ks.map((k) => k * 0.97)), hi = Math.max(spot * 1.08, ...ks.map((k) => k * 1.03));
    const step = Math.max(1, Math.round((hi - lo) / 240));
    return payoffCurve(legs, lotSize, Math.floor(lo / step) * step, hi, step);
  }, [ready, a, lotSize, spot, legs]);
  const chart = useMemo(() => (curve && curve.length && a?.defined && spot ? payoffOption({ expiry: curve, spot, breakevens: a.breakevens }, colors) : null), [curve, a, spot, colors]);
  const netPremium = lotSize && legs.length && legs.every((l) => l.premium != null) ? legs.reduce((s, l) => s + (l.action === "SELL" ? 1 : -1) * (l.premium as number) * l.lots * lotSize, 0) : null;

  const update = (id: string, patch: Partial<Leg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  /** Clicking B or S in the chain: one more lot of the same leg, or a new leg priced at the stored quote. */
  const fromChain = (strike: number, type: OptionType, action: Action) => {
    if (!expiry) return;
    setNote(null);
    setLegs((ls) => {
      const same = ls.find((l) => l.strike === strike && l.type === type && l.action === action);
      if (same) return ls.map((l) => (l.id === same.id ? { ...l, lots: l.lots + 1 } : l));
      const m = ltp(strike, type);
      return [...ls, { id: newLegId(), expiry, strike, type, action, lots: 1, premium: m, premiumSource: m == null ? null : "market" }];
    });
  };
  const apply = (t: Template) => {
    if (!expiry || atm == null) { setNote("Load an option chain first."); return; }
    const r = t.build({ strikes, atm, expiry, premium: (_e, k, ty) => ltp(k, ty) });
    if ("error" in r) { setNote(r.error); return; }
    setNote(null);
    setLegs(withIds(r));
  };
  const chooseStrike = (l: Leg, strike: number) => {
    const m = ltp(strike, l.type);
    update(l.id, { strike, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) });
  };
  const persist = (s: Saved[]) => { setSaved(s); try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: kept for this visit only */ } };
  const held = (k: number, t: OptionType) => legs.filter((l) => l.strike === k && l.type === t);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Strategy builder</h1>
        <p className="mt-1 max-w-[80ch] text-sm text-muted">Pick legs from the stored NIFTY option chain or from a template, edit them, and see the payoff at expiry: exact arithmetic on the premiums you hold, with maximum profit, maximum loss and breakevens.</p>
      </div>

      <Panel title="Option chain">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <div><div className="text-xs text-muted">Underlying</div><div className="text-paper">NIFTY 50</div></div>
            <label className="flex flex-col gap-1 text-xs text-muted">Expiry
              <select className={fieldCls} value={expiry ?? ""} aria-label="Expiry" onChange={(e) => { if (legs.length) setNote("The legs were cleared because the expiry changed."); setLegs([]); setPicked(e.target.value); }}>
                {available.map((e) => <option key={e} value={e}>{e}{e === ex.data?.weekly ? " (weekly)" : e === ex.data?.monthly ? " (monthly)" : ""}</option>)}
              </select>
            </label>
            <div><div className="text-xs text-muted">Spot (snapshot)</div><div className="num text-paper">{spot == null ? "—" : fmtPrice(spot)}</div></div>
            <div><div className="text-xs text-muted">Lot size</div><div className="num text-paper" title="From the broker's instrument data in the stored chain">{lotSize ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Snapshot</div><div className={`num ${chain.data?.stale ? "text-warn" : "text-paper"}`}>{snap ? fmtDateTimeIST(snap.retrieved_at) : "—"}{chain.data?.stale ? " · stale" : ""}</div></div>
            <div role="group" aria-label="Strikes shown" className="flex items-center gap-0.5">
              {CHAIN_WIDTHS.map((w) => <button key={String(w)} type="button" aria-pressed={width === w} onClick={() => setWidth(w)} className={`min-h-8 rounded-sm border px-2 text-xs ${width === w ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{w === "all" ? "All" : `±${w}`}</button>)}
            </div>
          </div>
          {chain.isPending && expiry && <p className="text-sm text-muted">Loading the stored option chain…</p>}
          {chain.error && <p role="alert" className="text-sm text-warn">No stored chain for {expiry}: capture one from Live option chain first. Strikes and premiums come from it; nothing is made up.</p>}
          {snap && lotSize == null && <p role="alert" className="text-sm text-down">The stored chain carries no lot size, so P&L in rupees cannot be computed. It is not assumed.</p>}
          {shown.length > 0 && (
            <div className="max-h-[360px] overflow-auto rounded-sm border border-rule">
              <table className="w-full text-sm" aria-label="Option chain">
                <thead className="sticky top-0 bg-slate text-xs text-muted">
                  <tr><th className="px-2 py-1 text-right font-normal">Call OI</th><th className="px-2 py-1 text-right font-normal">Call LTP</th><th className="px-1 py-1 text-center font-normal" colSpan={2}>Add call</th><th className="px-2 py-1 text-center font-medium text-paper">Strike</th><th className="px-1 py-1 text-center font-normal" colSpan={2}>Add put</th><th className="px-2 py-1 text-right font-normal">Put LTP</th><th className="px-2 py-1 text-right font-normal">Put OI</th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const isAtm = r.strike === atm;
                    const btn = (type: OptionType, action: Action) => {
                      const mine = held(r.strike, type).filter((l) => l.action === action).reduce((s, l) => s + l.lots, 0);
                      const on = mine > 0;
                      const price = ltp(r.strike, type);
                      return (
                        <button type="button" aria-label={`${action === "BUY" ? "Buy" : "Sell"} ${type} ${r.strike}`} title={price == null ? "No stored quote: the premium must be entered by hand" : `${action === "BUY" ? "Buy" : "Sell"} at ${fmtPrice(price)}`}
                          onClick={() => fromChain(r.strike, type, action)}
                          className={`min-h-7 min-w-7 rounded-sm border px-1 text-xs font-medium ${on ? (action === "BUY" ? "border-up bg-up/20 text-up" : "border-down bg-down/20 text-down") : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>
                          {action === "BUY" ? "B" : "S"}{on ? ` ${mine}` : ""}
                        </button>
                      );
                    };
                    return (
                      <tr key={r.strike} className={`num border-t border-rule/50 ${isAtm ? "bg-brass/10" : ""}`} data-testid={`chain-${r.strike}`}>
                        <td className="px-2 py-0.5 text-right text-muted">{r.call?.oi == null ? "—" : compactIN(r.call.oi)}</td>
                        <td className="px-2 py-0.5 text-right">{ltp(r.strike, "CE") == null ? "—" : fmtPrice(ltp(r.strike, "CE"))}</td>
                        <td className="px-0.5 py-0.5">{btn("CE", "BUY")}</td><td className="px-0.5 py-0.5">{btn("CE", "SELL")}</td>
                        <td className={`px-2 py-0.5 text-center font-medium ${isAtm ? "text-brass" : "text-paper"}`}>{fmtInt(r.strike)}{isAtm ? " ATM" : ""}</td>
                        <td className="px-0.5 py-0.5">{btn("PE", "BUY")}</td><td className="px-0.5 py-0.5">{btn("PE", "SELL")}</td>
                        <td className="px-2 py-0.5 text-right">{ltp(r.strike, "PE") == null ? "—" : fmtPrice(ltp(r.strike, "PE"))}</td>
                        <td className="px-2 py-0.5 text-right text-muted">{r.put?.oi == null ? "—" : compactIN(r.put.oi)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">B buys and S sells one lot at the last traded price in the stored snapshot (not a live quote); click again for another lot. A dash means the snapshot has no price for that contract: add the leg and enter the premium yourself.</p>
        </div>
      </Panel>

      <Panel title="Strategy" actions={<div className="flex items-center gap-2"><Button onClick={() => setLegs([])} disabled={legs.length === 0}>Clear</Button></div>}>
        <div className="space-y-3">
          <label className="flex max-w-[460px] flex-col gap-1 text-xs text-muted">Start from a template
            <select className={fieldCls} aria-label="Template" defaultValue="" onChange={(e) => { const t = TEMPLATES.find((x) => x.id === e.target.value); if (t) apply(t); e.target.value = ""; }}>
              <option value="" disabled>Choose a template…</option>
              {(["Directional", "Neutral", "Spreads"] as const).map((g) => (
                <optgroup key={g} label={g}>{TEMPLATES.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.label} · {t.view}</option>)}</optgroup>
              ))}
            </select>
          </label>
          {note && <p role="alert" className="text-sm text-warn" data-testid="template-msg">{note}</p>}
          {legs.length === 0 ? <EmptyState title="No legs yet">Click B or S in the option chain, or pick a template.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Strategy legs">
                <thead className="text-xs text-muted"><tr>{["Action", "Type", "Strike", "Lots", "Entry premium", "Premium source", "Market premium", ""].map((h) => <th key={h} className="px-1 py-1 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {legs.map((l) => {
                    const mk = ltp(l.strike, l.type);
                    const issue = issues.filter((i) => i.legId === l.id);
                    return (
                      <tr key={l.id} className="border-t border-rule/50 align-top" data-testid={`leg-${l.id}`}>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Action" value={l.action} onChange={(e) => update(l.id, { action: e.target.value as Action })}><option>BUY</option><option>SELL</option></select></td>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Option type" value={l.type} onChange={(e) => { const t = e.target.value as OptionType; const m = ltp(l.strike, t); update(l.id, { type: t, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) }); }}><option>CE</option><option>PE</option></select></td>
                        <td className="px-1 py-1"><select className={fieldCls} aria-label="Strike" value={l.strike} onChange={(e) => chooseStrike(l, Number(e.target.value))}>{!strikes.includes(l.strike) && <option value={l.strike}>{l.strike} (not listed)</option>}{strikes.map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}</select></td>
                        <td className="px-1 py-1"><input className={`${fieldCls} w-16`} type="number" min={1} step={1} aria-label="Lots" value={l.lots} onChange={(e) => update(l.id, { lots: Number(e.target.value) })} /></td>
                        <td className="px-1 py-1"><input className={`${fieldCls} w-24`} type="number" min={0} step="0.05" aria-label="Entry premium" value={l.premium ?? ""} placeholder="enter" onChange={(e) => update(l.id, { premium: e.target.value === "" ? null : Number(e.target.value), premiumSource: e.target.value === "" ? null : "manual" })} /></td>
                        <td className="px-1 py-1 text-xs text-muted">{l.premiumSource === "market" ? "stored quote" : l.premiumSource === "manual" ? "you entered" : "missing"}</td>
                        <td className="num px-1 py-1">{mk == null ? <span className="text-muted" title="No quote in the stored chain for this contract">—</span> : <>{fmtPrice(mk)}{l.premium !== mk && <button type="button" className="ml-2 text-xs text-info hover:underline" onClick={() => update(l.id, { premium: mk, premiumSource: "market" })}>use</button>}</>}</td>
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
          <div className="flex flex-wrap items-end gap-2 border-t border-rule/50 pt-2">
            <label className="flex flex-col gap-1 text-xs text-muted">Save as<input className={`${fieldCls} w-48`} aria-label="Strategy name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name" /></label>
            <Button disabled={!name.trim() || legs.length === 0 || !expiry} onClick={() => { persist([{ name: name.trim(), savedAt: new Date().toISOString(), expiry: expiry!, legs }, ...saved.filter((s) => s.name !== name.trim())]); setName(""); }}>Save</Button>
            {saved.length > 0 && (
              <label className="flex flex-col gap-1 text-xs text-muted">Saved strategies
                <select className={fieldCls} aria-label="Saved strategies" defaultValue="" onChange={(e) => { const s = saved.find((x) => x.name === e.target.value); if (s) { setPicked(s.expiry); setLegs(s.legs.map((l) => ({ ...l, id: newLegId() }))); } e.target.value = ""; }}>
                  <option value="" disabled>Load…</option>{saved.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.legs.length} legs · {s.expiry}</option>)}
                </select>
              </label>
            )}
            {saved.length > 0 && <Button onClick={() => persist([])} title="Delete every saved strategy from this browser">Delete saved</Button>}
            <span className="pb-2 text-[11px] text-muted">Saved in this browser only.</span>
          </div>
        </div>
      </Panel>

      <Panel title="Payoff at expiry">
        {!ready || !a?.defined ? <p className="text-sm text-muted" data-testid="payoff-empty">{legs.length === 0 ? "Add legs to see the payoff." : lotSize == null ? "Waiting for a stored chain with a lot size." : errors.length ? "Fix the highlighted legs to see the payoff." : a?.reason ?? "Enter the entry premium of every leg."}</p> : (
          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <div className="h-[360px]">{chart ? <EChart option={chart} ariaLabel="Strategy payoff" /> : null}</div>
            <dl className="grid grid-cols-2 content-start gap-x-4 lg:grid-cols-1" data-testid="risk-stats">
              <Stat label="Max profit" value={a?.defined ? (a.profitUnlimited ? "Unlimited" : money(a.maxProfit)) : "—"} cls="text-up" hint="Largest P&L at expiry over every NIFTY level from 0 upwards" />
              <Stat label="Max loss" value={a?.defined ? (a.lossUnlimited ? "Unlimited" : money(a.maxLoss)) : "—"} cls="text-down" hint="Largest loss at expiry over every NIFTY level from 0 upwards" />
              <Stat label="Breakeven at expiry" value={a?.defined ? (a.breakevens.length ? a.breakevens.map((b) => fmtInt(Math.round(b * 100) / 100)).join(" · ") : "none") : "—"} />
              <Stat label="Net premium" value={netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`} cls={tone(netPremium)} hint="Premium received minus premium paid, in rupees" />
              <Stat label="Lot size" value={String(lotSize)} hint="From the stored chain" />
            </dl>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">Profit and loss are before brokerage, taxes and charges. Premiums are the ones in the leg table, so the graph is only as good as those numbers.</p>
      </Panel>
    </div>
  );
}
