import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EChart, useChartColors } from "../components/EChart";
import { Button } from "../components/ui";
import { payoffOption } from "../lib/chartOptions";
import { api } from "../lib/api";
import { compactIN } from "../lib/analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { contractDelta, expiryEnd, netGreeks, probabilityOfProfit, sdBands, theoreticalPnl, type Valuation } from "../lib/optionModel";
import {
  analyzeExpiry, expiryPnl, newLegId, payoffCurve, sign, TEMPLATE_BIAS, TEMPLATES, validateStrategy, withIds,
  type Action, type Bias, type Leg, type OptionType, type Template,
} from "../lib/strategy";

const SAVE_KEY = "nse.strategies.v1";
interface Saved { name: string; savedAt: string; expiry: string; legs: Leg[] }
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]") as Saved[]; } catch { return []; } };
const money = (v: number | null, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const field = "min-h-8 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const WIDTHS = [5, 10, 20, "all"] as const;
const dayDiff = (iso: string, fromMs: number) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${new Date(fromMs + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
const dmy = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });

function Thumb({ legs, lotSize, spot }: { legs: Leg[]; lotSize: number; spot: number }) {
  const lo = spot * 0.94, hi = spot * 1.06, n = 80;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const s = lo + ((hi - lo) * i) / n;
    return { s, p: expiryPnl(legs, s, lotSize) };
  });
  if (pts.some((x) => x.p == null)) return null;
  const vals = pts.map((x) => x.p as number);
  const mx = Math.max(...vals, 1), mn = Math.min(...vals, -1), W = 150, H = 62;
  const y = (v: number) => 4 + ((mx - v) / (mx - mn)) * (H - 8), x = (i: number) => (i / n) * W;
  const segs = pts.slice(1).map((q, i) => {
    const a = pts[i]!.p as number, b = q.p as number;
    return <line key={i} x1={x(i)} y1={y(a)} x2={x(i + 1)} y2={y(b)} stroke={(a + b) / 2 >= 0 ? "var(--up)" : "var(--down)"} strokeWidth="2" />;
  });
  return <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" aria-hidden="true"><line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--rule)" strokeDasharray="3 3" />{segs}</svg>;
}

function Stat({ label, value, sub, cls = "text-paper", hint }: { label: string; value: string; sub?: string; cls?: string; hint?: string }) {
  return (
    <div className="border-b border-rule/60 px-3 py-2" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num text-[15px] font-medium ${cls}`}>{value}</dd>
      {sub && <dd className="num text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

export default function StrategyBuilder() {
  const colors = useChartColors();
  const ex = useExpiries();
  // only the two expiries this app collects (weekly and monthly), not every date the exchange lists
  const available = useMemo(() => [...new Set([ex.data?.weekly, ex.data?.monthly].filter((e): e is string => !!e))], [ex.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const expiry = picked ?? available[0] ?? null;
  const [legs, setLegs] = useState<Leg[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(10);
  const [sel, setSel] = useState<number | null>(null);
  const [mult, setMult] = useState(1);
  const [tab, setTab] = useState<"positions" | "greeks">("positions");
  const [bias, setBias] = useState<Bias>("Neutral");
  const [rate, setRate] = useState(6);
  const [days, setDays] = useState(0);
  const [showOi, setShowOi] = useState(true);
  const [showSd, setShowSd] = useState(true);
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const [name, setName] = useState("");

  const chain = useQuery({ queryKey: ["chain", expiry], queryFn: () => api.optionChain(expiry!), enabled: !!expiry, retry: false, staleTime: 15_000, refetchInterval: 30_000 });
  const snap = chain.data?.snapshot;
  const lotSize = snap?.lot_size ?? null;
  const spot = snap?.underlying_ltp ?? null;
  const snapMs = snap ? Date.parse(snap.retrieved_at) : Date.now();
  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const strikes = useMemo(() => rows.map((r) => r.strike), [rows]);
  const atm = useMemo(() => (spot == null || strikes.length === 0 ? null : strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), strikes[0]!)), [strikes, spot]);
  const ltp = (k: number, t: OptionType): number | null => {
    const row = rows.find((r) => r.strike === k);
    const q = t === "CE" ? row?.call : row?.put;
    return q?.ltp != null && q.ltp > 0 ? q.ltp : null;
  };
  const r = rate / 100;
  const deltas = useMemo(() => {
    const m = new Map<number, { ce: number | null; pe: number | null; ceIv: number | null; peIv: number | null }>();
    if (!expiry || spot == null) return m;
    for (const row of rows) {
      const c = contractDelta("CE", row.call?.ltp != null && row.call.ltp > 0 ? row.call.ltp : null, spot, row.strike, expiry, snapMs, r);
      const p = contractDelta("PE", row.put?.ltp != null && row.put.ltp > 0 ? row.put.ltp : null, spot, row.strike, expiry, snapMs, r);
      m.set(row.strike, { ce: c?.delta ?? null, pe: p?.delta ?? null, ceIv: c?.iv ?? null, peIv: p?.iv ?? null });
    }
    return m;
  }, [rows, expiry, spot, snapMs, r]);
  const atmIv = useMemo(() => {
    const d = atm == null ? undefined : deltas.get(atm);
    const v = [d?.ceIv, d?.peIv].filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }, [deltas, atm]);
  const shown = useMemo(() => {
    if (width === "all" || atm == null) return rows;
    const i = rows.findIndex((x) => x.strike === atm);
    return rows.slice(Math.max(0, i - width), i + width + 1);
  }, [rows, atm, width]);
  const maxOi = useMemo(() => Math.max(1, ...shown.map((x) => Math.max(x.call?.oi ?? 0, x.put?.oi ?? 0))), [shown]);

  // legs with the multiplier applied and the unticked ones left out
  const live = useMemo(() => legs.filter((l) => l.enabled !== false).map((l) => ({ ...l, lots: l.lots * mult })), [legs, mult]);
  const issues = useMemo(
    () => validateStrategy(legs, { expiries: available, strikesByExpiry: expiry ? { [expiry]: strikes } : {}, today: todayIST() }),
    [legs, available, expiry, strikes],
  );
  const errors = issues.filter((i) => i.level === "error");
  const ready = lotSize != null && live.length > 0 && errors.length === 0;
  const a = useMemo(() => (lotSize && live.length ? analyzeExpiry(live, lotSize) : null), [live, lotSize]);
  const dte = expiry ? Math.max(0, dayDiff(expiry, snapMs)) : 0;
  const targetMs = snapMs + Math.min(days, dte) * 86_400_000;
  const val: Valuation = { spotNow: spot ?? 0, nowMs: snapMs, rate: r, ivShift: 0 };
  const curve = useMemo(() => {
    if (!ready || !a?.defined || !lotSize || !spot) return null;
    const ks = live.map((l) => l.strike);
    const lo = Math.min(spot * 0.93, ...ks.map((k) => k * 0.97)), hi = Math.max(spot * 1.07, ...ks.map((k) => k * 1.03));
    const step = Math.max(1, Math.round((hi - lo) / 240));
    return payoffCurve(live, lotSize, Math.floor(lo / step) * step, hi, step);
  }, [ready, a, lotSize, spot, live]);
  const target = useMemo(() => (curve && lotSize ? curve.map((p) => ({ s: p.s, pnl: theoreticalPnl(live, p.s, targetMs, lotSize, val) })) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curve, live, lotSize, targetMs, r]);
  const bands = expiry && spot && atmIv ? sdBands(spot, atmIv, expiry, snapMs) : null;
  const chart = useMemo(() => (curve?.length && a?.defined && spot ? payoffOption({
    expiry: curve, target: target && target.some((x) => x.pnl != null) ? target : null,
    targetLabel: days > 0 ? `Estimated in ${Math.min(days, dte)} day${days === 1 ? "" : "s"} (model)` : "Estimated at the snapshot time (model)",
    spot, breakevens: a.breakevens, bands: showSd ? bands : null,
    oi: showOi ? shown.map((x) => ({ strike: x.strike, call: x.call?.oi ?? null, put: x.put?.oi ?? null })) : null,
  }, colors) : null), [curve, target, a, spot, days, dte, bands, showSd, showOi, shown, colors]);
  const pop = ready && a?.defined && lotSize && spot && atmIv && expiry ? probabilityOfProfit(live, lotSize, spot, atmIv, expiry, snapMs, r) : null;
  const greeks = ready && lotSize && spot ? netGreeks(live, lotSize, val) : null;
  const unreal = (l: Leg, mkt: number | null) => (mkt == null || l.premium == null || !lotSize ? null : sign(l.action) * (mkt - l.premium) * l.lots * mult * lotSize);
  const totalPnl = lotSize && live.length && live.every((l) => l.premium != null && ltp(l.strike, l.type) != null)
    ? live.reduce((s, l) => s + (unreal({ ...l, lots: l.lots / mult }, ltp(l.strike, l.type)) ?? 0), 0) : null;
  const netPremium = lotSize && live.length && live.every((l) => l.premium != null) ? live.reduce((s, l) => s - sign(l.action) * (l.premium as number) * l.lots * lotSize, 0) : null;
  const rr = a?.defined && a.maxProfit != null && a.maxLoss != null && a.maxLoss < 0 ? a.maxProfit / -a.maxLoss : null;

  const update = (id: string, patch: Partial<Leg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const fromChain = (strike: number, type: OptionType, action: Action) => {
    if (!expiry) return;
    setNote(null);
    setSel(strike);
    setLegs((ls) => {
      const same = ls.find((l) => l.strike === strike && l.type === type && l.action === action);
      if (same) return ls.map((l) => (l.id === same.id ? { ...l, lots: l.lots + 1 } : l));
      const m = ltp(strike, type);
      return [...ls, { id: newLegId(), expiry, strike, type, action, lots: 1, premium: m, premiumSource: m == null ? null : "market" }];
    });
  };
  const build = (t: Template): Leg[] | null => {
    if (!expiry || atm == null) return null;
    const out = t.build({ strikes, atm, expiry, premium: (_e, k, ty) => ltp(k, ty) });
    return "error" in out ? null : withIds(out);
  };
  const apply = (t: Template) => {
    if (!expiry || atm == null) { setNote("Load an option chain first."); return; }
    const out = t.build({ strikes, atm, expiry, premium: (_e, k, ty) => ltp(k, ty) });
    if ("error" in out) { setNote(out.error); return; }
    setNote(null);
    setLegs(withIds(out));
  };
  const chooseStrike = (l: Leg, strike: number) => {
    const m = ltp(strike, l.type);
    update(l.id, { strike, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) });
  };
  const persist = (s: Saved[]) => { setSaved(s); try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: kept for this visit only */ } };
  const net = (k: number, t: OptionType) => legs.filter((l) => l.strike === k && l.type === t).reduce((s, l) => s + sign(l.action) * l.lots, 0);
  const gallery = useMemo(() => TEMPLATES.filter((t) => TEMPLATE_BIAS[t.id] === bias), [bias]);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Strategy builder</h1>
        <span className="rounded-sm border border-rule bg-slate-2 px-2 py-1 text-sm text-paper">NIFTY 50</span>
        <input className={`${field} w-40`} aria-label="Strategy name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name to save" />
        <Button variant="primary" disabled={!name.trim() || legs.length === 0 || !expiry} onClick={() => { persist([{ name: name.trim(), savedAt: new Date().toISOString(), expiry: expiry!, legs }, ...saved.filter((s) => s.name !== name.trim())]); setName(""); }}>Save</Button>
        <select className={field} aria-label="Saved strategies" value="" disabled={saved.length === 0} onChange={(e) => { const s = saved.find((x) => x.name === e.target.value); if (s) { setPicked(s.expiry); setLegs(s.legs.map((l) => ({ ...l, id: newLegId() }))); } }}>
          <option value="">{saved.length ? `Saved (${saved.length})…` : "Saved (none)"}</option>{saved.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.legs.length} legs · {s.expiry}</option>)}
        </select>
        {saved.length > 0 && <button type="button" className="text-xs text-muted hover:text-down" onClick={() => persist([])} title="Delete every saved strategy from this browser">delete saved</button>}
        <Button onClick={() => { setLegs([]); setNote(null); setSel(null); setMult(1); setDays(0); }} disabled={legs.length === 0}>Reset / New</Button>
        <span className="ml-auto text-xs text-muted" title="Premiums are the last traded prices in this stored snapshot, not live quotes">Snapshot <span className={`num ${chain.data?.stale ? "text-warn" : "text-paper"}`}>{snap ? fmtDateTimeIST(snap.retrieved_at) : "—"}</span>{chain.data?.stale ? " · stale" : ""}</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(520px,43%)_1fr]">
        {/* ------------------------------------------------------------ chain */}
        <section aria-label="Option chain" className="flex h-fit flex-col rounded-[var(--radius-panel)] border border-rule bg-slate">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-rule px-3 py-2 text-sm">
            <span className="text-xs text-muted">SPOT <span className="num text-[15px] font-semibold text-paper">{spot == null ? "—" : fmtPrice(spot)}</span></span>
            <span className="text-xs text-muted" title="Average implied volatility of the ATM call and put (model, from stored prices)">ATM IV <span className="num text-paper">{atmIv == null ? "—" : `${(atmIv * 100).toFixed(1)}%`}</span></span>
            <span className="text-xs text-muted" title="From the broker's instrument data in the stored chain">LOT <span className="num text-paper">{lotSize ?? "—"}</span></span>
            <details className="ml-auto text-xs">
              <summary className="cursor-pointer text-info">Settings</summary>
              <div className="absolute z-10 mt-1 flex w-64 flex-col gap-2 rounded-sm border border-rule bg-slate p-3 shadow-lg">
                <div role="group" aria-label="Strikes shown" className="flex flex-wrap items-center gap-1"><span className="text-muted">Strikes</span>
                  {WIDTHS.map((w) => <button key={String(w)} type="button" aria-pressed={width === w} onClick={() => setWidth(w)} className={`min-h-7 rounded-sm border px-2 ${width === w ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted"}`}>{w === "all" ? "All" : `±${w}`}</button>)}</div>
                <label className="flex items-center gap-2 text-muted">Interest rate % (model)<input type="number" step="0.25" className={`${field} w-20`} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Interest rate" /></label>
              </div>
            </details>
          </div>
          <div className="flex flex-wrap gap-2 border-b border-rule px-3 py-2">
            {available.map((e) => (
              <button key={e} type="button" aria-pressed={e === expiry} onClick={() => { if (legs.length) setNote("The legs were cleared because the expiry changed."); setLegs([]); setPicked(e); }}
                className={`min-h-8 rounded-sm border px-3 text-sm ${e === expiry ? "border-info bg-info/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{dmy(e)} ({dayDiff(e, snapMs)}d) · {e === ex.data?.weekly ? "weekly" : "monthly"}</button>
            ))}
          </div>
          {chain.isPending && expiry && <p className="px-3 py-3 text-sm text-muted">Loading the stored option chain…</p>}
          {chain.error && <p role="alert" className="px-3 py-3 text-sm text-warn">No stored chain for {expiry}: capture one from Live option chain first. Strikes and premiums come from it; nothing is made up.</p>}
          {snap && lotSize == null && <p role="alert" className="px-3 py-3 text-sm text-down">The stored chain carries no lot size, so P&L in rupees cannot be computed. It is not assumed.</p>}
          {shown.length > 0 && (
            <div className="max-h-[640px] overflow-auto">
              <table className="w-full text-sm" aria-label="Option chain">
                <thead className="sticky top-0 z-[1] bg-slate text-xs text-muted">
                  <tr><th className="px-2 py-1 text-left font-normal">Call Δ</th><th className="px-2 py-1 text-left font-normal">LTP</th><th className="px-2 py-1 text-right font-normal">OI</th><th className="px-2 py-1 text-center font-medium text-paper">Strike</th><th className="px-2 py-1 text-left font-normal">OI</th><th className="px-2 py-1 text-right font-normal">LTP</th><th className="px-2 py-1 text-right font-normal">Put Δ</th></tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const isAtm = row.strike === atm, on = sel === row.strike, d = deltas.get(row.strike);
                    const bs = (type: OptionType) => (["BUY", "SELL"] as const).map((action) => {
                      const mine = legs.filter((l) => l.strike === row.strike && l.type === type && l.action === action).reduce((s, l) => s + l.lots, 0);
                      return (
                        <button key={action} type="button" aria-label={`${action === "BUY" ? "Buy" : "Sell"} ${type} ${row.strike}`}
                          title={ltp(row.strike, type) == null ? "No stored quote: the premium must be entered by hand" : `${action === "BUY" ? "Buy" : "Sell"} one lot at ${fmtPrice(ltp(row.strike, type))}`}
                          onClick={(e) => { e.stopPropagation(); fromChain(row.strike, type, action); }}
                          className={`min-h-6 min-w-6 rounded-sm border px-1 text-[11px] font-semibold ${action === "BUY" ? "border-up bg-up/10 text-up" : "border-down bg-down text-white"}`}>
                          {action === "BUY" ? "B" : "S"}{mine > 0 ? ` ${mine}` : ""}
                        </button>
                      );
                    });
                    const held = (type: OptionType) => { const v = net(row.strike, type); return v === 0 ? null : <span className={`mr-1 rounded-sm border px-1 text-[10px] ${v > 0 ? "border-up text-up" : "border-down text-down"}`}>{v > 0 ? "+" : "−"}{Math.abs(v)}</span>; };
                    const bar = (v: number | null, color: string, align: "left" | "right") => (
                      <div className={`flex h-4 ${align === "right" ? "justify-end" : ""}`}><div className="h-4 rounded-sm" style={{ width: `${v == null ? 0 : Math.max(2, (v / maxOi) * 100)}%`, background: color, opacity: 0.35 }} title={v == null ? "no OI" : `OI ${compactIN(v)}`} /></div>
                    );
                    return (
                      <tr key={row.strike} onClick={() => setSel(row.strike)} data-testid={`chain-${row.strike}`}
                        className={`group num cursor-pointer border-t border-rule/40 ${on ? "bg-info/20" : isAtm ? "bg-brass/10" : row.strike < (spot ?? 0) ? "bg-up/[0.04]" : "bg-down/[0.03]"}`}>
                        <td className="px-2 py-1 text-left text-muted">{d?.ce == null ? "—" : d.ce.toFixed(2)}</td>
                        <td className="px-2 py-1 text-left"><div className="flex items-center gap-1">{ltp(row.strike, "CE") == null ? "—" : fmtPrice(ltp(row.strike, "CE"))}</div>
                          <div className={`mt-0.5 flex items-center gap-1 ${on ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>{held("CE")}{bs("CE")}</div></td>
                        <td className="w-[22%] px-1 py-1">{bar(row.call?.oi ?? null, colors.up, "right")}</td>
                        <td className={`px-2 py-1 text-center font-medium ${isAtm ? "text-brass" : "text-paper"}`}><span className="inline-block min-w-[3.6rem] rounded-sm border border-rule bg-slate-2 px-1.5 py-0.5">{fmtInt(row.strike)}</span></td>
                        <td className="w-[22%] px-1 py-1">{bar(row.put?.oi ?? null, colors.down, "left")}</td>
                        <td className="px-2 py-1 text-right"><div>{ltp(row.strike, "PE") == null ? "—" : fmtPrice(ltp(row.strike, "PE"))}</div>
                          <div className={`mt-0.5 flex items-center justify-end gap-1 ${on ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>{held("PE")}{bs("PE")}</div></td>
                        <td className="px-2 py-1 text-right text-muted">{d?.pe == null ? "—" : d.pe.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-rule px-3 py-2 text-[11px] text-muted">Hover or click a strike, then B to buy or S to sell one lot at the last traded price in the snapshot; click again for another lot. A dash means no stored price: add the leg and enter the premium. Δ is a Black-76 model value from those prices.</p>
        </section>

        {/* ------------------------------------------------------------ payoff and positions */}
        <div className="flex min-w-0 flex-col gap-3">
          <section aria-label="Payoff" className="rounded-[var(--radius-panel)] border border-rule bg-slate">
            <div className="flex border-b border-rule px-3 py-2 text-sm"><span className="rounded-sm bg-info/15 px-3 py-1 text-info">Payoff</span><span className="ml-auto text-xs text-muted">{expiry ? `expiry ${expiry} · ${dte}d` : ""}</span></div>
            {note && <p role="alert" className="px-3 pt-2 text-sm text-warn" data-testid="template-msg">{note}</p>}
            {legs.length === 0 ? (
              <div className="p-3" data-testid="gallery">
                <h2 className="mb-2 text-sm font-semibold text-paper">Ready-made strategies</h2>
                <div role="tablist" aria-label="Strategy view" className="mb-3 flex gap-2">
                  {(["Bullish", "Bearish", "Neutral", "Other"] as const).map((b) => <button key={b} role="tab" type="button" aria-selected={bias === b} onClick={() => setBias(b)} className={`min-h-8 rounded-sm border px-3 text-sm ${bias === b ? "border-info bg-info/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{b}</button>)}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {gallery.map((t) => {
                    const l = build(t);
                    return (
                      <button key={t.id} type="button" onClick={() => apply(t)} aria-label={t.label} className="rounded-sm border border-rule bg-slate-2 p-2 text-left hover:border-info">
                        <div className="h-16">{l && lotSize && spot ? <Thumb legs={l} lotSize={lotSize} spot={spot} /> : <div className="grid h-16 place-items-center text-xs text-muted">needs a chain</div>}</div>
                        <div className="mt-1 text-center text-sm text-paper">{t.label}</div><div className="text-center text-[11px] text-muted">{t.view}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-muted">Or click B / S in the option chain to add legs one by one. Every ready-made strategy becomes ordinary legs you can edit.</p>
              </div>
            ) : !ready || !a?.defined ? (
              <p className="p-3 text-sm text-muted" data-testid="payoff-empty">{lotSize == null ? "Waiting for a stored chain with a lot size." : errors.length ? "Fix the highlighted legs to see the payoff." : live.length === 0 ? "Tick at least one leg." : a?.reason ?? "Enter the entry premium of every leg."}</p>
            ) : (
              <div className="grid lg:grid-cols-[210px_1fr]">
                <dl className="border-b border-rule lg:border-b-0 lg:border-r" data-testid="risk-stats">
                  <Stat label="P&L now (vs entry)" value={money(totalPnl)} cls={tone(totalPnl)} hint="Stored last traded prices minus your entry premiums" />
                  <Stat label="POP (model estimate)" value={pop == null ? "—" : `${(pop * 100).toFixed(0)}%`} hint="Chance of ending in profit at expiry if NIFTY moves like a lognormal with the ATM implied volatility. A model, not a forecast." />
                  <Stat label="Reward : Risk" value={rr == null ? "N/A" : `${rr.toFixed(2)} : 1`} />
                  <Stat label="Max profit" value={a.profitUnlimited ? "Unlimited" : money(a.maxProfit)} cls="text-up" hint="Best P&L at expiry over every NIFTY level from 0 upwards" />
                  <Stat label="Max loss" value={a.lossUnlimited ? "Unlimited" : money(a.maxLoss)} cls="text-down" hint="Worst P&L at expiry over every NIFTY level from 0 upwards" />
                  <Stat label="Breakevens" value={a.breakevens.length ? a.breakevens.map((b) => fmtInt(Math.round(b * 100) / 100)).join(" · ") : "none"} sub={spot ? a.breakevens.map((b) => `${((b / spot - 1) * 100).toFixed(2)}%`).join(" · ") : undefined} />
                  <Stat label="Net premium" value={netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`} cls={tone(netPremium)} />
                </dl>
                <div className="min-w-0 p-2">
                  <div className="h-[380px]">{chart ? <EChart option={chart} ariaLabel="Strategy payoff" /> : null}</div>
                  <details className="px-2 pb-2 text-xs">
                    <summary className="cursor-pointer text-info">Payoff setting</summary>
                    <div className="mt-2 flex flex-wrap items-center gap-4 text-muted">
                      <label className="flex items-center gap-1"><input type="checkbox" checked={showOi} onChange={(e) => setShowOi(e.target.checked)} /> OI bars</label>
                      <label className="flex items-center gap-1"><input type="checkbox" checked={showSd} onChange={(e) => setShowSd(e.target.checked)} /> ±SD markers</label>
                      <label className="flex items-center gap-2">Dashed estimate for day <span className="num text-paper">{Math.min(days, dte)}</span> of {dte}
                        <input type="range" min={0} max={dte} step={1} value={Math.min(days, dte)} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days from snapshot" /></label>
                    </div>
                  </details>
                  <p className="px-2 pb-2 text-[11px] text-muted">Solid: exact P&L at expiry on your entry premiums, before brokerage, taxes and charges. Dashed: Black-76 model estimate for the chosen day, never a market price.</p>
                </div>
              </div>
            )}
          </section>

          {legs.length > 0 && (
            <section aria-label="Positions" className="rounded-[var(--radius-panel)] border border-rule bg-slate">
              <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-sm">
                {(["positions", "greeks"] as const).map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} className={`rounded-sm px-3 py-1 ${tab === t ? "bg-info/15 text-info" : "text-muted hover:text-paper"}`}>{t === "positions" ? "Positions" : "Greeks"}</button>)}
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span>Multiplier <button type="button" aria-label="Decrease multiplier" className="mx-1 rounded-sm border border-rule px-2" onClick={() => setMult((m) => Math.max(1, m - 1))}>−</button><span className="num text-paper" data-testid="mult">{mult}</span><button type="button" aria-label="Increase multiplier" className="mx-1 rounded-sm border border-rule px-2" onClick={() => setMult((m) => m + 1)}>+</button></span>
                  <span>Qty per lot <span className="num text-paper">{lotSize ?? "—"}</span></span>
                  <span>Total P&L <span className={`num ${tone(totalPnl)}`}>{money(totalPnl)}</span></span>
                </div>
              </div>
              {tab === "positions" ? (
                <div className="overflow-x-auto p-2">
                  <table className="w-full text-sm" aria-label="Strategy legs">
                    <thead className="text-xs text-muted"><tr>{["", "B/S", "Lots", "Expiry", "Strike", "Type", "Entry", "LTP", "P&L", ""].map((h, i) => <th key={i} className="px-1 py-1 text-left font-normal">{h}</th>)}</tr></thead>
                    <tbody>
                      {legs.map((l) => {
                        const mk = ltp(l.strike, l.type);
                        const issue = issues.filter((i) => i.legId === l.id);
                        const pl = unreal(l, mk);
                        return (
                          <tr key={l.id} className={`border-t border-rule/50 align-top ${l.enabled === false ? "opacity-50" : ""}`} data-testid={`leg-${l.id}`}>
                            <td className="px-1 py-1"><input type="checkbox" aria-label="Include leg" checked={l.enabled !== false} onChange={(e) => update(l.id, { enabled: e.target.checked })} /></td>
                            <td className="px-1 py-1"><select className={`${field} font-semibold ${l.action === "BUY" ? "text-up" : "text-down"}`} aria-label="Action" value={l.action} onChange={(e) => update(l.id, { action: e.target.value as Action })}><option>BUY</option><option>SELL</option></select></td>
                            <td className="px-1 py-1"><input className={`${field} w-16`} type="number" min={1} step={1} aria-label="Lots" value={l.lots} onChange={(e) => update(l.id, { lots: Number(e.target.value) })} /></td>
                            <td className="num px-1 py-2 text-xs text-muted">{dmy(l.expiry)}</td>
                            <td className="px-1 py-1"><select className={field} aria-label="Strike" value={l.strike} onChange={(e) => chooseStrike(l, Number(e.target.value))}>{!strikes.includes(l.strike) && <option value={l.strike}>{l.strike} (not listed)</option>}{strikes.map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}</select></td>
                            <td className="px-1 py-1"><select className={field} aria-label="Option type" value={l.type} onChange={(e) => { const t = e.target.value as OptionType; const m = ltp(l.strike, t); update(l.id, { type: t, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) }); }}><option>CE</option><option>PE</option></select></td>
                            <td className="px-1 py-1"><input className={`${field} w-24`} type="number" min={0} step="0.05" aria-label="Entry premium" value={l.premium ?? ""} placeholder="enter" title={l.premiumSource === "market" ? "Stored quote" : l.premiumSource === "manual" ? "You entered this" : "Missing"} onChange={(e) => update(l.id, { premium: e.target.value === "" ? null : Number(e.target.value), premiumSource: e.target.value === "" ? null : "manual" })} />
                              <div className="text-[10px] text-muted">{l.premiumSource === "market" ? "stored quote" : l.premiumSource === "manual" ? "you entered" : "missing"}</div></td>
                            <td className="num px-1 py-2">{mk == null ? <span className="text-muted" title="No quote in the stored chain for this contract">—</span> : fmtPrice(mk)}</td>
                            <td className={`num px-1 py-2 ${tone(pl)}`}>{money(pl)}</td>
                            <td className="whitespace-nowrap px-1 py-2">
                              {mk != null && l.premium !== mk && <button type="button" className="mr-2 text-xs text-info hover:underline" aria-label="Use stored quote" title="Set the entry premium to the stored quote" onClick={() => update(l.id, { premium: mk, premiumSource: "market" })}>⟳</button>}
                              <button type="button" className="mr-2 text-xs text-info hover:underline" aria-label="Duplicate leg" onClick={() => setLegs((ls) => { const i = ls.findIndex((x) => x.id === l.id); const c = [...ls]; c.splice(i + 1, 0, { ...l, id: newLegId() }); return c; })}>Copy</button>
                              <button type="button" className="text-xs text-down hover:underline" aria-label="Remove leg" onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}>✕</button>
                              {issue.map((i) => <div key={i.field + i.message} role={i.level === "error" ? "alert" : undefined} className={`max-w-[28ch] whitespace-normal text-[11px] ${i.level === "error" ? "text-down" : "text-warn"}`}>{i.message}</div>)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto p-2" data-testid="greeks">
                  <table className="w-full text-sm" aria-label="Greeks">
                    <thead className="text-xs text-muted"><tr><th className="px-1 py-1 text-left font-normal">Leg</th><th className="px-1 py-1 text-right font-normal">IV</th><th className="px-1 py-1 text-right font-normal">Delta</th><th className="px-1 py-1 text-right font-normal">Gamma</th><th className="px-1 py-1 text-right font-normal">Theta / day</th><th className="px-1 py-1 text-right font-normal">Vega / vol pt</th></tr></thead>
                    <tbody>
                      {live.map((l) => {
                        const g = lotSize && spot ? netGreeks([l], lotSize, val) : null;
                        const unavailable = !g || g.unavailable.length > 0;
                        return <tr key={l.id} className="num border-t border-rule/50"><td className="px-1 py-1">{l.action} {l.lots}× {fmtInt(l.strike)} {l.type}</td><td className="px-1 text-right">{(() => { const d = deltas.get(l.strike); const v = l.type === "CE" ? d?.ceIv : d?.peIv; return v == null ? "—" : `${(v * 100).toFixed(1)}%`; })()}</td>
                          {unavailable ? <td colSpan={4} className="px-1 text-right text-xs text-muted">unavailable: no volatility fits the premium</td> : <><td className="px-1 text-right">{g.delta.toFixed(1)}</td><td className="px-1 text-right">{g.gamma.toFixed(4)}</td><td className={`px-1 text-right ${tone(g.thetaDay)}`}>{money(g.thetaDay)}</td><td className={`px-1 text-right ${tone(g.vegaPt)}`}>{money(g.vegaPt)}</td></>}</tr>;
                      })}
                      {greeks && <tr className="num border-t border-rule font-medium"><td className="px-1 py-1">Net</td><td /><td className="px-1 text-right">{greeks.delta.toFixed(1)}</td><td className="px-1 text-right">{greeks.gamma.toFixed(4)}</td><td className={`px-1 text-right ${tone(greeks.thetaDay)}`}>{money(greeks.thetaDay)}</td><td className={`px-1 text-right ${tone(greeks.vegaPt)}`}>{money(greeks.vegaPt)}</td></tr>}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-muted">Model values (Black-76, volatility implied by each leg's premium at the snapshot, rate {rate}%). Delta is rupees of P&L per 1-point NIFTY move; theta is the change from one day passing.</p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted">NIFTY only: it is the one instrument NSE Universe collects option data for. Not available because the data does not exist here: margin, VIX tick, futures price. {expiry ? `Expiry ends ${new Date(expiryEnd(expiry)).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST.` : ""}</p>
    </div>
  );
}
