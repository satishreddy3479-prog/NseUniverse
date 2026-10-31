import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { mergeRows, type LiveMode } from "../components/ChainTable";
import { useThrottledVersion } from "../components/dashboard/DashContext";
import { useLiveSpot, useStreamStatus } from "../lib/useLive";
import { EChart, useChartColors } from "../components/EChart";
import { Info } from "../components/Info";
import { Button } from "../components/ui";
import { PAYOFF_ZOOM, payoffOption, payoffView } from "../lib/chartOptions";
import { api } from "../lib/api";
import { compactIN } from "../lib/analytics";
import { fmtDateTimeIST, fmtInt, fmtPrice } from "../lib/format";
import { useExpiries, useThrottledValue } from "../lib/hooks";
import { marketClockMs } from "../lib/session";
import { carryFromForward, contractGreeks, expiryEnd, impliedForward, legGreeks, sdLevel, netGreeks, probabilityOfProfit, scenarioGrid, sdBands, spotAtPremium, theoreticalPnl, type ContractGreeks, type Valuation } from "../lib/optionModel";
import {
  analyzeExpiry, applyAutomation, exitLeg, expiryPnl, hitOf, isExited, newLegId, reenterLeg, payoffCurve, sign, TEMPLATE_BIAS, TEMPLATES, validateStrategy, withIds,
  type Action, type Bias, type Leg, type OptionType, type Template,
} from "../lib/strategy";

const SAVE_KEY = "nse.strategies.v1";
interface Saved { name: string; savedAt: string; updatedAt?: string; expiry: string; legs: Leg[] }
const CLOSED_KEY = "nse.closed.v1";
interface ClosedLeg extends Leg { exit: number }
interface Closed { id: string; name: string; closedAt: string; snapshotAt: string; expiry: string; lotSize: number; pnl: number; legs: ClosedLeg[]; /** the stored chain was stale when the exit prices were read */ stale?: boolean }
const loadClosed = (): Closed[] => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]") as Closed[]; } catch { return []; } };
const loadSaved = (): Saved[] => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]") as Saved[]; } catch { return []; } };
const money = (v: number | null, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const field = "min-h-8 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const WIDTHS = [5, 10, 20, "all"] as const;
type GKey = "delta" | "gamma" | "theta" | "vega" | "iv";
const GCOLS: { key: GKey; short: string; hint: string }[] = [
  { key: "delta", short: "Δ", hint: "Delta: change of the option price per 1-point NIFTY move (Black-76 model)" },
  { key: "gamma", short: "Γ", hint: "Gamma: change of delta per 1-point NIFTY move" },
  { key: "theta", short: "Θ", hint: "Theta: change of the option price in one calendar day (₹ per unit)" },
  { key: "vega", short: "Vega", hint: "Vega: change of the option price per volatility point (₹ per unit)" },
  { key: "iv", short: "IV", hint: "Implied volatility of the stored last traded price" },
];
const fmtG = (k: GKey, c: ContractGreeks) => (k === "delta" ? c.delta.toFixed(2) : k === "gamma" ? c.gamma.toFixed(4) : k === "theta" ? c.thetaDay.toFixed(1) : k === "vega" ? c.vegaPt.toFixed(2) : `${(c.iv * 100).toFixed(1)}`);
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

/**
 * Percentage box for a target or stop. What you type is kept exactly as typed while you are in the box (so "7.5" and
 * "70" arrive intact); the price it sets is rounded to the 0.05 tick, which is why the percentage computed back from
 * the price can differ slightly, and that computed value is shown only when you are not typing.
 */
function PctBox({ derived, onType, label, title, disabled, className }: { derived: number | null; onType: (raw: string) => void; label: string; title: string; disabled: boolean; className: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className={className} type="number" min={0} step="any" aria-label={label} title={title} placeholder="%" disabled={disabled}
      value={draft ?? (derived ?? "")}
      onChange={(e) => { setDraft(e.target.value); onType(e.target.value); }}
      onBlur={() => setDraft(null)} />
  );
}

function Stat({ label, value, sub, cls = "text-paper", hint, big = false }: { label: string; value: string; sub?: string; cls?: string; hint?: string; big?: boolean }) {
  // tiles grow to fill their row, so a row never ends with an empty cell
  return (
    <div className={`min-w-0 flex-1 bg-slate px-3 py-2 ${big ? "basis-[8.5rem]" : "basis-[11rem]"}`} title={hint}>
      <dt className="flex items-center gap-1 text-xs text-muted">{label}<Info term={label} /></dt>
      <dd className={`num font-semibold ${big ? "text-lg" : "text-[15px] font-medium"} ${cls}`}>{value}</dd>
      {sub && <dd className="num text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

export default function StrategyBuilder() {
  const colors = useChartColors();
  const ex = useExpiries();
  // only the two expiries this app collects (weekly and monthly), not every date the exchange lists
  const available = useMemo(() => [...new Set([ex.data?.weekly, ex.data?.monthly].filter((e): e is string => !!e))], [ex.data]);
  // The strategy being worked on is kept in this browser, so a refresh does not bring back an older saved copy and
  // repeat exits that already happened. Copies older than three days are ignored.
  const [work] = useState(() => {
    try {
      const w = JSON.parse(localStorage.getItem("nse.builder.working.v1") ?? "null") as { legs?: Leg[]; expiry?: string | null; name?: string; loaded?: string | null; baseline?: Leg[]; at?: number } | null;
      return w && Array.isArray(w.legs) && w.at && Date.now() - w.at < 3 * 86_400_000 ? w : null;
    } catch { return null; }
  });
  const [picked, setPicked] = useState<string | null>(work?.expiry ?? null);
  const expiry = picked ?? available[0] ?? null;
  const [legs, setLegs] = useState<Leg[]>(work?.legs ?? []);
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(10);
  const [sel, setSel] = useState<number | null>(null);
  const [mult, setMult] = useState(1);
  const [tab, setTab] = useState<"positions" | "greeks" | "scenarios">("positions");
  const [bias, setBias] = useState<Bias>("Neutral");
  const [rate, setRate] = useState(6);
  const [days, setDays] = useState(0);
  const [oiMode, setOiMode] = useState<"oi" | "change" | "off">("oi");
  /** which reference lines the payoff chart draws: the expected-move (SD) markers and/or the stop and target prices of the legs */
  const [lines, setLines] = useState<"both" | "sd" | "levels" | "none">(() => { try { const v = localStorage.getItem("nse.builder.lines"); return v === "sd" || v === "levels" || v === "none" ? v : "both"; } catch { return "both"; } });
  const sdOn = lines === "both" || lines === "sd";
  const levelsOn = lines === "both" || lines === "levels";
  const [autoOn, setAutoOn] = useState(() => { try { return localStorage.getItem("nse.builder.auto") !== "0"; } catch { return true; } });
  /** Zoom steps from the profit-zone window: + narrows around the centre of the profit zone, − widens. */
  const [zoom, setZoom] = useState(0);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 640px)");
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [ivPts, setIvPts] = useState(0);
  /** The legs as they were when this strategy was built from a template or loaded from Saved/Closed: what Reset returns to. */
  const [baseline, setBaseline] = useState<Leg[]>(work?.baseline ?? []);
  const [gcols, setGcols] = useState<GKey[]>(["delta", "iv"]);
  const [wide, setWide] = useState(false);
  const [whatPct, setWhatPct] = useState(0);
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const [name, setName] = useState(work?.name ?? "");
  /** Name of the saved strategy currently loaded in the builder (the one the Update button overwrites). */
  const [loaded, setLoaded] = useState<string | null>(work?.loaded ?? null);
  const [closed, setClosed] = useState<Closed[]>(loadClosed);
  /** "server": kept on the server; "browser": the server could not be reached, this browser's copy is all there is. */
  const [sync, setSync] = useState<"checking" | "server" | "browser">("checking");
  const [syncProblem, setSyncProblem] = useState<string | null>(null);
  // The server is the source of truth, with two exceptions that are never lost: strategies only this browser holds
  // (from before server storage, or saved while the server was unreachable) move up, and an edit made here after the
  // server's copy was last changed (a newer Update while offline) is sent up. Retried every 45 s until it works.
  const syncNow = useCallback(async (): Promise<boolean> => {
    try {
      let got = await api.strategies();
      type Stamped = { updatedAt?: string; savedAt?: string; closedAt?: string };
      const newer = (a: Stamped, b: Stamped) => (a.updatedAt ?? a.savedAt ?? a.closedAt ?? "") > (b.updatedAt ?? b.savedAt ?? b.closedAt ?? "");
      const srvSaved = new Map((got.saved as unknown as Saved[]).map((x) => [x.name, x]));
      const srvClosed = new Map((got.closed as unknown as Closed[]).map((x) => [x.id, x]));
      const upSaved = loadSaved().filter((x) => { const o = srvSaved.get(x.name); return !o || newer(x, o); });
      const upClosed = loadClosed().filter((x) => !srvClosed.has(x.id));
      const fresh = upSaved.filter((x) => srvSaved.has(x.name));
      await Promise.all(fresh.map((x) => api.putStrategy("saved", x.name, x)));
      const isNew = upSaved.filter((x) => !srvSaved.has(x.name));
      if (isNew.length || upClosed.length) {
        await api.importStrategies(Object.fromEntries(isNew.map((x) => [x.name, x])), Object.fromEntries(upClosed.map((x) => [x.id, x])));
      }
      if (fresh.length || isNew.length || upClosed.length) got = await api.strategies();
      const sv = got.saved as unknown as Saved[], cl = got.closed as unknown as Closed[];
      setSaved(sv); setClosed(cl); setSync("server"); setSyncProblem(null);
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(sv)); localStorage.setItem(CLOSED_KEY, JSON.stringify(cl)); } catch { /* cache only */ }
      return true;
    } catch {
      setSync("browser");
      return false;
    }
  }, []);
  useEffect(() => {
    void syncNow();
    const t = setInterval(() => { if (sync !== "server" || syncProblem) void syncNow(); }, 45_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncNow, sync, syncProblem]);
  const [opened, setOpened] = useState<Closed | null>(null);
  const [confirmAll, setConfirmAll] = useState<"saved" | "closed" | null>(null);

  const chain = useQuery({ queryKey: ["chain", expiry], queryFn: () => api.optionChain(expiry!), enabled: !!expiry, retry: false, staleTime: 5_000, refetchInterval: 15_000 });
  const snap = chain.data?.snapshot;
  const lotSize = snap?.lot_size ?? null;
  // Same live feed as the Option chain page: streamed prices overlay the stored snapshot while the stream is fresh.
  const { stream } = useStreamStatus();
  const streamActive = !!stream && ["streaming", "waiting_for_data", "reconnecting"].includes(stream.state);
  const liveMode: LiveMode = !streamActive || !snap ? "off" : stream.effective_state === "streaming" ? "fresh" : "stale";
  const liveVersion = useThrottledVersion(400);
  const liveSpot = useLiveSpot();
  const spot = liveMode === "fresh" && liveSpot.live ? liveSpot.ltp : snap?.underlying_ltp ?? null;
  // prices are valued at the market time they belong to: live prices now, a stored chain at the time it was fetched
  const fetchedMs = snap ? Date.parse(snap.retrieved_at) : Date.now();
  const snapMs = marketClockMs(liveMode === "fresh" ? Date.now() : fetchedMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (snap ? mergeRows(snap.rows, liveMode) : []), [snap, liveMode, liveVersion]);
  const strikes = useMemo(() => rows.map((r) => r.strike), [rows]);
  const atm = useMemo(() => (spot == null || strikes.length === 0 ? null : strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), strikes[0]!)), [strikes, spot]);
  const ltp = (k: number, t: OptionType): number | null => {
    const row = rows.find((r) => r.strike === k);
    const q = t === "CE" ? row?.call : row?.put;
    return q?.ltp != null && q.ltp > 0 ? q.ltp : null;
  };
  const r = rate / 100;
  // forward from put-call parity in the stored chain; the carry that reproduces it replaces the assumed rate in the model
  const fwd = useMemo(() => (expiry && spot != null ? impliedForward(rows.map((x) => ({ strike: x.strike, call: x.call?.ltp ?? null, put: x.put?.ltp ?? null })), spot, expiry, snapMs, r) : null), [rows, expiry, spot, snapMs, r]);
  const fwdCarry = fwd && expiry && spot != null ? carryFromForward(spot, fwd.forward, expiry, snapMs) : null;
  const carry = fwdCarry ?? r;
  // Black-76 Greeks of every listed contract from its own stored price: one calculation feeds the chain, the legs and the strategy
  const cg = useMemo(() => {
    const m = new Map<number, { ce: ContractGreeks | null; pe: ContractGreeks | null }>();
    if (!expiry || spot == null) return m;
    for (const row of rows) {
      const px = (q: typeof row.call) => (q?.ltp != null && q.ltp > 0 ? q.ltp : null);
      m.set(row.strike, { ce: contractGreeks("CE", px(row.call), spot, row.strike, expiry, snapMs, r, carry), pe: contractGreeks("PE", px(row.put), spot, row.strike, expiry, snapMs, r, carry) });
    }
    return m;
  }, [rows, expiry, spot, snapMs, r, carry]);
  const deltas = useMemo(() => {
    const m = new Map<number, { ce: number | null; pe: number | null; ceIv: number | null; peIv: number | null }>();
    for (const [k, v] of cg) m.set(k, { ce: v.ce?.delta ?? null, pe: v.pe?.delta ?? null, ceIv: v.ce?.iv ?? null, peIv: v.pe?.iv ?? null });
    return m;
  }, [cg]);
  const atmK = useMemo(() => {
    const ref = fwd?.forward ?? spot;
    return ref == null || strikes.length === 0 ? null : strikes.reduce((b, k) => (Math.abs(k - ref) < Math.abs(b - ref) ? k : b), strikes[0]!);
  }, [strikes, fwd, spot]);
  const atmIv = useMemo(() => {
    const d = atmK == null ? undefined : deltas.get(atmK);
    const v = [d?.ceIv, d?.peIv].filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }, [deltas, atmK]);
  const straddle = atmK != null && ltp(atmK, "CE") != null && ltp(atmK, "PE") != null ? (ltp(atmK, "CE") as number) + (ltp(atmK, "PE") as number) : null;
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
  /** legs still in the market (a leg closed by its stop or target keeps only its booked P&L) */
  const open = useMemo(() => live.filter((l) => !isExited(l)), [live]);
  const errors = issues.filter((i) => i.level === "error");
  const ready = lotSize != null && live.length > 0 && errors.length === 0;
  const a = useMemo(() => (lotSize && live.length ? analyzeExpiry(live, lotSize) : null), [live, lotSize]);
  const dte = expiry ? Math.max(0, dayDiff(expiry, snapMs)) : 0;
  const targetMs = snapMs + Math.min(days, dte) * 86_400_000;
  const val0: Valuation = { spotNow: spot ?? 0, nowMs: snapMs, rate: r, carry, ivShift: 0 };
  const val: Valuation = { ...val0, ivShift: ivPts / 100 };
  // every model leg uses the volatility the stored market price of its own strike implies, not one backed out of the entry premium you typed
  const marketIv = (l: Leg) => { const d = deltas.get(l.strike); return (l.type === "CE" ? d?.ceIv : d?.peIv) ?? null; };
  const mlegs = useMemo(() => open.map((l) => ({ ...l, iv: l.iv ?? marketIv(l) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, deltas]);
  const bands = expiry && spot && atmIv ? sdBands(spot, atmIv, expiry, snapMs) : null;
  const curve = useMemo(() => {
    if (!ready || !a?.defined || !lotSize || !spot) return null;
    const ks = open.map((l) => l.strike);
    // show the part that matters: out to the 2-sigma band, the strikes and the breakevens, plus a margin
    const near = [spot, ...ks, ...a.breakevens, ...(bands ? [bands.m2, bands.p2] : [spot * 0.94, spot * 1.06])];
    const m = spot * 0.012;
    const lo = Math.min(...near) - m, hi = Math.max(...near) + m;
    const step = Math.max(1, Math.round((hi - lo) / 240));
    return payoffCurve(live, lotSize, Math.floor(lo / step) * step, hi, step);
  }, [ready, a, lotSize, spot, live, bands]);
  const target = useMemo(() => (curve && lotSize ? curve.map((p) => ({ s: p.s, pnl: theoreticalPnl(mlegs, p.s, targetMs, lotSize, val) })) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curve, mlegs, lotSize, targetMs, r, carry, ivPts]);
  const levels = useMemo(() => {
    if (!curve?.length || !spot) return [];
    const lo = curve[0]!.s, hi = curve[curve.length - 1]!.s;
    const out: { s: number; kind: "target" | "stop" | "whatif"; label: string }[] = [];
    for (const l of mlegs) for (const kind of ["target", "stop"] as const) {
      const px = kind === "target" ? l.target : l.stop;
      if (px == null || px <= 0) continue;
      const x = spotAtPremium(l, px, targetMs, val, lo, hi);
      if (x != null) out.push({ s: x, kind, label: `${l.strike}${l.type}` });
    }
    if (whatPct !== 0) out.push({ s: spot * (1 + whatPct / 100), kind: "whatif", label: `${whatPct > 0 ? "+" : ""}${whatPct}%` });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, mlegs, targetMs, r, carry, ivPts, spot, whatPct]);
  const view = useMemo(() => (curve?.length && a?.defined && spot ? payoffView(curve, a.breakevens, spot, live.map((l) => l.strike), zoom) : null), [curve, a, spot, live, zoom]);
  const chartNow = useMemo(() => (curve?.length && a?.defined && spot ? payoffOption({
    expiry: curve, target: target && target.some((x) => x.pnl != null) ? target : null,
    targetLabel: `${days > 0 ? `Estimated in ${Math.min(days, dte)} day${days === 1 ? "" : "s"}` : "Estimated at the snapshot time"}${ivPts ? `, IV ${ivPts > 0 ? "+" : ""}${ivPts} pts` : ""} (model)`,
    spot, breakevens: a.breakevens, bands: sdOn ? bands : null, levels: levelsOn ? levels : [],
    oiMode: oiMode === "change" ? "change" : "oi",
    oi: oiMode === "off" ? null : rows.map((x) => ({ strike: x.strike, call: (oiMode === "change" ? x.call?.oi_change : x.call?.oi) ?? null, put: (oiMode === "change" ? x.put?.oi_change : x.put?.oi) ?? null })),
  }, colors, view, narrow) : null), [curve, target, a, spot, days, dte, bands, sdOn, levelsOn, oiMode, rows, colors, levels, ivPts, view, narrow]);
  // Live ticks change the spot, premiums and OI many times a second; redraw the payoff at a calm pace. A change of
  // zoom, window, strategy or the controls shows at once.
  const chart = useThrottledValue(chartNow, 2500, `${zoom}|${narrow}|${live.length}|${live.map((l) => `${l.action}${l.type}${l.strike}${l.lots}${l.premium}${l.exitPrice ?? ''}${l.stop ?? ''}${l.target ?? ''}`).join(",")}|${lines}|${oiMode}|${days}|${ivPts}|${whatPct}`);
  const pop = ready && a?.defined && lotSize && spot && atmIv && expiry ? probabilityOfProfit(live, lotSize, spot, atmIv, expiry, snapMs, carry) : null;
  const greeks = ready && lotSize && spot ? netGreeks(mlegs, lotSize, val0) : null;
  /** P&L of one leg: what is booked, plus the open part against the market price */
  const unreal = (l: Leg, mkt: number | null) => {
    if (!lotSize) return null;
    if (isExited(l)) return l.realised ?? 0;
    return mkt == null || l.premium == null ? null : sign(l.action) * (mkt - l.premium) * l.lots * mult * lotSize + (l.realised ?? 0);
  };
  const realisedTotal = live.reduce((t, l) => t + (l.realised ?? 0), 0);
  const totalPnl = lotSize && live.length && live.every((l) => isExited(l) || (l.premium != null && ltp(l.strike, l.type) != null))
    ? live.reduce((s, l) => s + (unreal({ ...l, lots: l.lots / mult }, ltp(l.strike, l.type)) ?? 0), 0) : null;
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [exitDraft, setExitDraft] = useState<Record<string, string>>({});
  // Automatic stop, target and re-entry (paper only: nothing is sent to a broker). It runs on live streamed prices only,
  // and only while this page is open; with the stream stale or the market closed it is paused, never guessing from old prices.
  const autoActive = autoOn && liveMode === "fresh" && lotSize != null;
  useEffect(() => {
    if (!autoActive || !lotSize || legs.length === 0) return;
    const r = applyAutomation(legs, ltp, lotSize, new Date().toISOString(), mult);
    if (r.events.length) {
      setLegs((cur) => (cur === legs ? r.legs : cur));
      setAutoNote(r.events.join(" · "));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, legs, autoActive, mult, lotSize]);
  useEffect(() => {
    try { localStorage.setItem("nse.builder.working.v1", JSON.stringify({ legs, expiry, name, loaded, baseline, at: Date.now() })); } catch { /* this visit only */ }
  }, [legs, expiry, name, loaded, baseline]);
  const exitNow = (l: Leg) => {
    if (!lotSize) return;
    const typed = exitDraft[l.id];
    const px = typed != null && typed !== "" ? Number(typed) : ltp(l.strike, l.type);
    if (px == null || !(px > 0)) { setNote("No live price for that leg: type the exit price in the box."); return; }
    setLegs((ls) => ls.map((x) => (x.id === l.id ? exitLeg(x, px, "manual", lotSize, new Date().toISOString(), mult) : x)));
    setExitDraft((d) => ({ ...d, [l.id]: "" }));
  };
  const enterAgain = (l: Leg) => {
    const px = ltp(l.strike, l.type);
    if (px == null) { setNote("No live price for that leg yet."); return; }
    setLegs((ls) => ls.map((x) => (x.id === l.id ? reenterLeg(x, px, new Date().toISOString(), false) : x)));
  };
  const netPremium = lotSize && live.length && live.every((l) => l.premium != null) ? live.reduce((s, l) => s - sign(l.action) * (l.premium as number) * l.lots * lotSize, 0) : null;
  const exitPnl = (kind: "target" | "stop") => {
    if (!lotSize) return null;
    const withPx = open.filter((l) => (kind === "target" ? l.target : l.stop) != null && l.premium != null);
    if (withPx.length === 0) return null;
    return { v: withPx.reduce((t, l) => t + sign(l.action) * (((kind === "target" ? l.target : l.stop) as number) - (l.premium as number)) * l.lots * lotSize, 0), n: withPx.length };
  };
  const ifTarget = exitPnl("target"), ifStop = exitPnl("stop");
  const whatSpot = spot == null ? null : spot * (1 + whatPct / 100);
  const whatEst = whatSpot != null && lotSize && ready ? theoreticalPnl(mlegs, whatSpot, targetMs, lotSize, val) : null;
  const whatExp = whatSpot != null && lotSize && ready ? expiryPnl(live, whatSpot, lotSize) : null;
  // scenario grid: spot rows at standard deviations of the model distribution, date columns from the snapshot to expiry
  const grid = useMemo(() => {
    if (!ready || !lotSize || !expiry || !spot || !atmIv || tab !== "scenarios") return null;
    const ks = [-2, -1, -0.5, 0, 0.5, 1, 2];
    const spots = ks.map((k) => sdLevel(spot, atmIv, expiry, snapMs, k)).filter((x): x is number => x != null);
    if (spots.length !== ks.length) return null;
    const dayOffsets = [...new Set(Array.from({ length: Math.min(dte, 5) + 1 }, (_, i) => Math.round((i * dte) / Math.max(1, Math.min(dte, 5)))))];
    const dates = dayOffsets.map((d) => (d >= dte ? expiryEnd(expiry) : snapMs + d * 86_400_000));
    return { ks, spots, dayOffsets, cells: scenarioGrid(mlegs, lotSize, spots, dates, val) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, lotSize, expiry, spot, atmIv, tab, dte, snapMs, carry, mlegs, ivPts, r]);
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
  /** + / - on a held strike: one more lot in the direction already held, or one lot fewer (the leg goes when its last lot does). */
  const adjust = (strike: number, type: OptionType, dir: 1 | -1) => {
    setLegs((ls) => {
      const mine = ls.filter((l) => l.strike === strike && l.type === type);
      const netLots = mine.reduce((t, l) => t + sign(l.action) * l.lots, 0);
      if (netLots === 0) return ls;
      const action: Action = netLots > 0 ? "BUY" : "SELL";
      const target = [...mine].reverse().find((l) => l.action === action);
      if (!target) return ls;
      if (dir === 1) return ls.map((l) => (l.id === target.id ? { ...l, lots: l.lots + 1 } : l));
      return target.lots > 1 ? ls.map((l) => (l.id === target.id ? { ...l, lots: l.lots - 1 } : l)) : ls.filter((l) => l.id !== target.id);
    });
  };
  const build = (t: Template): Leg[] | null => {
    if (!expiry || atm == null) return null;
    const out = t.build({ strikes, atm, expiry, premium: (_e, k, ty) => ltp(k, ty) });
    return "error" in out ? null : withIds(out);
  };
  const loadLegs = (ls: Leg[]) => { setLegs(ls); setBaseline(ls); };
  const apply = (t: Template) => {
    if (!expiry || atm == null) { setNote("Load an option chain first."); return; }
    const out = t.build({ strikes, atm, expiry, premium: (_e, k, ty) => ltp(k, ty) });
    if ("error" in out) { setNote(out.error); return; }
    setNote(null);
    loadLegs(withIds(out));
  };
  const chooseStrike = (l: Leg, strike: number) => {
    const m = ltp(strike, l.type);
    update(l.id, { strike, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) });
  };
  /** Target or stop-loss for one leg: a premium, or a % of the entry premium. Targets are on the profit side of the entry, stops on the loss side. */
  const setExit = (l: Leg, kind: "target" | "stop", px: number | null) => update(l.id, kind === "target" ? { target: px } : { stop: px });
  const exitCell = (l: Leg, kind: "target" | "stop") => {
    const cur = kind === "target" ? l.target ?? null : l.stop ?? null;
    const buy = l.action === "BUY";
    const profitSide = kind === "target";
    const up = profitSide === buy; // the premium moves up for a buyer's target and a seller's stop
    const mkt = ltp(l.strike, l.type);
    const wrong = cur != null && l.premium != null && (up ? cur <= l.premium : cur >= l.premium);
    const tone2 = kind === "target" ? "border-up/60 text-up" : "border-down/60 text-down";
    // The percentage is how far the premium moves from the entry premium; typing one sets the price.
    const curPct = cur != null && l.premium ? Math.round((up ? cur / l.premium - 1 : 1 - cur / l.premium) * 1000) / 10 : null;
    const fromPct = (raw: string) => {
      if (raw === "" || l.premium == null) return setExit(l, kind, null);
      const p = Number(raw);
      if (Number.isFinite(p) && p >= 0) setExit(l, kind, Math.max(0.05, Math.round(l.premium * (up ? 1 + p / 100 : 1 - p / 100) * 20) / 20));
    };
    return (
      <div>
        <input className={`${field} w-[4.4rem] !px-1.5 ${wrong ? "border-down" : ""}`} type="number" min={0} step="0.05" aria-label={kind === "target" ? "Target premium" : "Stop-loss premium"}
          value={cur ?? ""} placeholder="none" onChange={(e) => setExit(l, kind, e.target.value === "" ? null : Number(e.target.value))} />
        <div className="mt-0.5 flex items-center gap-1">
          <PctBox className={`${field} w-12 !px-1 text-xs ${tone2}`} label={`${kind === "target" ? "Target" : "Stop"} percent of entry premium`}
            title={`% the premium moves ${up ? "above" : "below"} the entry premium`} derived={curPct} disabled={l.premium == null} onType={fromPct} />
          <span className="text-[10px] text-muted">%</span>
          {cur != null && <button type="button" aria-label={`Clear ${kind === "target" ? "target" : "stop"}`} onClick={() => setExit(l, kind, null)} className="text-[10px] text-muted hover:text-paper">✕</button>}
        </div>
        {cur != null && !wrong && mkt != null && !isExited(l) && (
          hitOf(l, kind, mkt)
            ? <div className={`mt-0.5 rounded-sm px-1 text-[10px] font-semibold ${kind === "target" ? "bg-up/20 text-up" : "bg-down/20 text-down"}`} data-testid={`${kind}-hit`}>{kind === "target" ? "Target hit" : "Stop hit"} · LTP {fmtPrice(mkt)}</div>
            : <div className="num mt-0.5 text-[10px] text-muted" data-testid={`${kind}-away`}>{Math.abs(cur - mkt).toFixed(2)} away (LTP {fmtPrice(mkt)})</div>
        )}
        {wrong && <div className="max-w-[16ch] text-[10px] text-down">{kind === "target" ? "Target" : "Stop"} must be {up ? "above" : "below"} the entry.</div>}
        {cur != null && !wrong && l.premium != null && lotSize && <div className={`num text-[10px] ${tone(sign(l.action) * (cur - l.premium))}`}>{money(sign(l.action) * (cur - l.premium) * l.lots * mult * lotSize)}</div>}
      </div>
    );
  };
  /** Send what changed between two lists to the server (new/changed -> save, missing -> delete). */
  const pushDiff = <T,>(kind: "saved" | "closed", before: T[], after: T[], keyOf: (x: T) => string) => {
    if (sync === "browser") return; // server unreachable: kept in this browser, moved up when it is reachable again
    const old = new Map(before.map((x) => [keyOf(x), JSON.stringify(x)]));
    const now = new Set(after.map(keyOf));
    const jobs: Promise<unknown>[] = [];
    for (const x of after) if (old.get(keyOf(x)) !== JSON.stringify(x)) jobs.push(api.putStrategy(kind, keyOf(x), x));
    for (const k of old.keys()) if (!now.has(k)) jobs.push(api.deleteStrategy(kind, k));
    if (jobs.length === 0) return;
    void Promise.all(jobs).then(() => setSyncProblem(null), (e: unknown) => setSyncProblem(e instanceof Error ? e.message : "the server did not accept the change"));
  };
  const persistClosed = (c: Closed[]) => { pushDiff("closed", closed, c, (x) => x.id); setClosed(c); try { localStorage.setItem(CLOSED_KEY, JSON.stringify(c)); } catch { /* storage unavailable: kept for this visit only */ } };
  /** Exit every active leg at its stored price, record the realised P&L as a closed trade and clear the builder. Nothing is sent to any broker. */
  const exitAll = () => {
    if (!expiry || !lotSize || !snap) return;
    const active = legs.filter((l) => l.enabled !== false);
    const missing = active.filter((l) => !isExited(l) && (ltp(l.strike, l.type) == null || l.premium == null));
    if (active.length === 0) return;
    if (missing.length) { setNote(`Cannot exit: no stored price or no entry premium for ${missing.map((l) => `${l.strike} ${l.type}`).join(", ")}. Untick or remove those legs, or enter the entry premium.`); return; }
    const out: ClosedLeg[] = active.map((l) => ({ ...l, lots: l.lots * mult, exit: isExited(l) ? (l.exitPrice as number) : (ltp(l.strike, l.type) as number) }));
    // a leg closed earlier by its stop or target keeps its booked P&L; an open one is closed now; earlier cycles stay booked
    const pnl = out.reduce((t, l) => t + (isExited(l) ? 0 : sign(l.action) * (l.exit - (l.premium as number)) * l.lots * lotSize) + (l.realised ?? 0), 0);
    const at = new Date();
    persistClosed([{ id: newLegId(), name: name.trim() || `Strategy ${at.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}`, closedAt: at.toISOString(), snapshotAt: snap.retrieved_at, expiry, lotSize, pnl, legs: out, stale: !!chain.data?.stale }, ...closed]);
    setLegs([]); setNote(null); setSel(null); setMult(1); setDays(0); setName(""); setOpened(null); setLoaded(null);
  };
  const openClosed = (c: Closed) => { setPicked(c.expiry); loadLegs(c.legs.map(({ exit: _e, ...l }) => ({ ...l, id: newLegId() }))); setMult(1); setNote(null); setOpened(c); setLoaded(null); };
  const persist = (s: Saved[]) => { pushDiff("saved", saved, s, (x) => x.name); setSaved(s); try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: kept for this visit only */ } };
  const net = (k: number, t: OptionType) => legs.filter((l) => l.strike === k && l.type === t).reduce((s, l) => s + sign(l.action) * l.lots, 0);
  const controlsChanged = mult !== 1 || days !== 0 || ivPts !== 0 || whatPct !== 0 || zoom !== 0;
  const legsChanged = JSON.stringify(legs.map(({ id: _i, ...r }) => r)) !== JSON.stringify(baseline.map(({ id: _i, ...r }) => r));
  const canReset = legsChanged || controlsChanged;
  const canNew = legs.length > 0 || name !== "" || loaded != null || opened != null;
  /** Reset: undo edits, keeping the strategy. */
  const resetStrategy = () => { setLegs(baseline.map((l) => ({ ...l }))); setMult(1); setDays(0); setIvPts(0); setWhatPct(0); setZoom(0); setNote(null); setSel(null); };
  /** New: forget the strategy entirely and start from the gallery. */
  const newStrategy = () => { setLegs([]); setBaseline([]); setName(""); setLoaded(null); setOpened(null); setNote(null); setSel(null); setMult(1); setDays(0); setIvPts(0); setWhatPct(0); setZoom(0); };
  const savedEntry = loaded ? saved.find((x) => x.name === loaded) : undefined;
  const sig = (ls: Leg[]) => JSON.stringify(ls.map(({ id: _i, ...r }) => r));
  const dirty = !!savedEntry && (sig(legs) !== sig(savedEntry.legs) || savedEntry.expiry !== expiry);
  const gallery = useMemo(() => TEMPLATES.filter((t) => TEMPLATE_BIAS[t.id] === bias), [bias]);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 w-full text-xl font-semibold sm:w-auto">Strategy builder</h1>
        <span className="rounded-sm border border-rule bg-slate-2 px-2 py-1 text-sm text-paper">NIFTY 50</span>
        <input className={`${field} min-w-0 flex-1 sm:w-40 sm:flex-none`} aria-label="Strategy name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name to save" />
        <Button variant="primary" disabled={!name.trim() || legs.length === 0 || !expiry} onClick={() => { persist([{ name: name.trim(), savedAt: new Date().toISOString(), expiry: expiry!, legs }, ...saved.filter((s) => s.name !== name.trim())]); setLoaded(name.trim()); setBaseline(legs); setName(""); }}>Save</Button>
        <span data-testid="sync-state" className={`text-[11px] ${sync === "browser" || syncProblem ? "text-warn" : "text-muted"}`}
          title={sync === "server" ? "Saved and closed strategies are stored on the server and kept in its nightly backups" : "The server could not be reached: strategies are held in this browser only and move to the server the next time it is reachable"}>
          {syncProblem ? `Not saved on server: ${syncProblem}` : sync === "server" ? "Stored on server" : sync === "browser" ? "Browser only (server unreachable)" : "Checking server…"}
        </span>
        <details className="relative text-sm" data-testid="saved-menu">
          <summary className={`${field} flex cursor-pointer items-center`} aria-label="Saved strategies">Saved ({saved.length})</summary>
          <div className="absolute left-0 z-20 mt-1 w-80 max-w-[90vw] rounded-sm border border-rule bg-slate p-1 shadow-lg">
            {saved.length === 0 ? <p className="p-2 text-xs text-muted">Nothing saved yet. Name a strategy and press Save.</p> : (
              <>
                <ul className="max-h-72 overflow-auto">
                  {saved.map((sv) => (
                    <li key={sv.name} className="flex items-center gap-1 border-b border-rule/40 last:border-0">
                      <button type="button" className="flex-1 rounded-sm p-2 text-left hover:bg-slate-2" onClick={(e) => { setPicked(sv.expiry); loadLegs(sv.legs.map((l) => ({ ...l, id: newLegId() }))); setOpened(null); setLoaded(sv.name); (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); }}>
                        <div className="text-paper">{sv.name}</div>
                        <div className="text-[11px] text-muted">{sv.legs.length} legs · expiry {sv.expiry}</div>
                      </button>
                      <button type="button" aria-label={`Delete saved strategy ${sv.name}`} title="Delete this saved strategy" className="px-2 text-xs text-muted hover:text-down" onClick={() => persist(saved.filter((x) => x.name !== sv.name))}>✕</button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="w-full border-t border-rule/40 p-2 text-left text-xs text-muted hover:text-down" onClick={() => (confirmAll === "saved" ? (persist([]), setConfirmAll(null)) : setConfirmAll("saved"))}>{confirmAll === "saved" ? "Click again to delete all saved strategies" : "Delete all saved"}</button>
              </>
            )}
          </div>
        </details>
        <details className="relative text-sm" data-testid="closed-menu">
          <summary className={`${field} flex cursor-pointer items-center`} aria-label="Closed strategies">Closed ({closed.length})</summary>
          <div className="absolute left-0 z-20 mt-1 w-80 max-w-[90vw] rounded-sm border border-rule bg-slate p-1 shadow-lg">
            {closed.length === 0 ? <p className="p-2 text-xs text-muted">No closed trades yet. Exit all in the positions card saves one here.</p> : (
              <>
              <ul className="max-h-72 overflow-auto">
                {closed.map((c) => (
                  <li key={c.id} className="flex items-center gap-1 border-b border-rule/40 last:border-0">
                    <button type="button" className="flex-1 rounded-sm p-2 text-left hover:bg-slate-2" onClick={(e) => { openClosed(c); (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); }}>
                      <div className="text-paper">{c.name}</div>
                      <div className="text-[11px] text-muted">{c.legs.length} legs · expiry {c.expiry} · closed {new Date(c.closedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</div>
                      <div className={`num text-xs ${tone(c.pnl)}`}>Realised {money(c.pnl)}{c.stale && <span className="ml-2 text-warn" title={`Exit prices were the stored prices from ${fmtDateTimeIST(c.snapshotAt)}, which were stale (not live)`}>at stale prices</span>}</div>
                    </button>
                    <button type="button" aria-label={`Delete closed trade ${c.name}`} title="Remove from the closed list" className="px-2 text-xs text-muted hover:text-down" onClick={() => persistClosed(closed.filter((x) => x.id !== c.id))}>✕</button>
                  </li>
                ))}
              </ul>
              <button type="button" className="w-full border-t border-rule/40 p-2 text-left text-xs text-muted hover:text-down" onClick={() => (confirmAll === "closed" ? (persistClosed([]), setConfirmAll(null)) : setConfirmAll("closed"))}>{confirmAll === "closed" ? "Click again to delete all closed trades" : "Delete all closed"}</button>
              </>
            )}
          </div>
        </details>
        <Button ariaLabel="Reset strategy" onClick={resetStrategy} disabled={!canReset} title="Undo your edits: back to the strategy as it was built or loaded (legs, strikes, lots, targets, stops, what-if, date and IV shift)">Reset</Button>
        <Button ariaLabel="New strategy" onClick={newStrategy} disabled={!canNew} title="Start a blank strategy: clears the legs and the name">New</Button>
        <span className="text-xs text-muted sm:ml-auto" title={liveMode === "fresh" ? "Streamed last traded prices overlay the stored snapshot, as on the Option chain page" : "Premiums are the last traded prices in this stored snapshot, not live quotes"}>{liveMode === "fresh" ? <span className="mr-2 rounded-sm border border-up/60 px-1 text-up">LIVE</span> : null}Snapshot <span className={`num ${chain.data?.stale ? "text-warn" : "text-paper"}`}>{snap ? fmtDateTimeIST(snap.retrieved_at) : "—"}</span>{chain.data?.stale ? " · stale" : ""}</span>
      </div>

      <div className={`grid gap-3 [&>*]:min-w-0 ${wide ? "" : "xl:grid-cols-[minmax(480px,36%)_1fr]"}`}>
        {/* ------------------------------------------------------------ chain */}
        <section aria-label="Option chain" className={`flex h-fit flex-col rounded-[var(--radius-panel)] border border-rule bg-slate ${wide ? "" : "xl:sticky xl:top-2 xl:self-start"}`}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-rule px-3 py-2 text-sm">
            <span className="text-xs text-muted">SPOT <span className="num text-[15px] font-semibold text-paper">{spot == null ? "—" : fmtPrice(spot)}</span></span>
            <span className="text-xs text-muted" title="Average implied volatility of the call and put at the strike nearest the forward, from their stored prices (model)">ATM IV <span className="num text-paper">{atmIv == null ? "—" : `${(atmIv * 100).toFixed(1)}%`}</span></span>
            <span className="text-xs text-muted" title="From the broker's instrument data in the stored chain">LOT <span className="num text-paper">{lotSize ?? "—"}</span></span>
            <button type="button" aria-pressed={wide} onClick={() => setWide((w) => !w)} className="ml-auto rounded-sm border border-rule px-2 py-0.5 text-xs text-muted hover:text-paper" title="Give the option chain the full width, useful with several Greeks columns">{wide ? "⤡ Narrow" : "⤢ Wide"}</button>
            <details className="text-xs">
              <summary className="cursor-pointer text-info">Settings</summary>
              <div className="absolute z-10 mt-1 flex w-64 flex-col gap-2 rounded-sm border border-rule bg-slate p-3 shadow-lg">
                <div role="group" aria-label="Strikes shown" className="flex flex-wrap items-center gap-1"><span className="text-muted">Strikes</span>
                  {WIDTHS.map((w) => <button key={String(w)} type="button" aria-pressed={width === w} onClick={() => setWidth(w)} className={`min-h-7 rounded-sm border px-2 ${width === w ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted"}`}>{w === "all" ? "All" : `±${w}`}</button>)}</div>
                <div role="group" aria-label="Greeks columns" className="flex flex-wrap items-center gap-2"><span className="text-muted">Greeks</span>
                  {GCOLS.map((g) => <label key={g.key} className="flex items-center gap-1" title={g.hint}><input type="checkbox" checked={gcols.includes(g.key)} onChange={(e) => setGcols((c) => (e.target.checked ? [...c, g.key] : c.filter((x) => x !== g.key)))} />{g.short}</label>)}</div>
                <label className="flex items-center gap-2 text-muted">Interest rate % (model)<input type="number" step="0.25" className={`${field} w-20`} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Interest rate" /></label>
              </div>
            </details>
          </div>
          <div className="flex flex-wrap gap-2 border-b border-rule px-3 py-2">
            {available.map((e) => (
              <button key={e} type="button" aria-pressed={e === expiry} onClick={() => { if (legs.length) setNote("The legs were cleared because the expiry changed."); setLegs([]); setLoaded(null); setPicked(e); }}
                className={`min-h-8 rounded-sm border px-3 text-sm ${e === expiry ? "border-info bg-info/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{dmy(e)} ({dayDiff(e, snapMs)}d) · {e === ex.data?.weekly ? "weekly" : "monthly"}</button>
            ))}
          </div>
          {chain.isPending && expiry && <p className="px-3 py-3 text-sm text-muted">Loading the stored option chain…</p>}
          {chain.error && <p role="alert" className="px-3 py-3 text-sm text-warn">No stored chain for {expiry}: capture one from Live option chain first. Strikes and premiums come from it; nothing is made up.</p>}
          {snap && lotSize == null && <p role="alert" className="px-3 py-3 text-sm text-down">The stored chain carries no lot size, so P&L in rupees cannot be computed. It is not assumed.</p>}
          {shown.length > 0 && (
            <div className={`max-h-[460px] overflow-auto sm:max-h-[640px] ${wide ? "" : "xl:max-h-[calc(100vh-15rem)]"}`}>
              <table className="w-full text-sm" aria-label="Option chain">
                <thead className="sticky top-0 z-[1] bg-slate text-xs text-muted">
                  <tr>
                    {GCOLS.filter((g) => gcols.includes(g.key)).map((g) => <th key={`c${g.key}`} className="px-1.5 py-1 text-left font-normal" title={g.hint}>{g.short}</th>)}
                    <th className="px-2 py-1 text-left font-normal">LTP</th><th className="px-2 py-1 text-right font-normal">Call OI <Info term="Call OI" /></th>
                    <th className="px-2 py-1 text-center font-medium text-paper">Strike</th>
                    <th className="px-2 py-1 text-left font-normal">Put OI <Info term="Put OI" /></th><th className="px-2 py-1 text-right font-normal">LTP</th>
                    {[...GCOLS].reverse().filter((g) => gcols.includes(g.key)).map((g) => <th key={`p${g.key}`} className="px-1.5 py-1 text-right font-normal" title={g.hint}>{g.short}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const isAtm = row.strike === atm, on = sel === row.strike, g = cg.get(row.strike);
                    const netCe = net(row.strike, "CE"), netPe = net(row.strike, "PE");
                    const held = netCe !== 0 || netPe !== 0;
                    const side = (v: number) => (v > 0 ? "bg-up/20" : v < 0 ? "bg-down/20" : "");
                    const pm = (type: OptionType, v: number) => v === 0 ? null : (
                      <span className="flex items-center gap-0.5">
                        <button type="button" aria-label={`Remove one lot ${type} ${row.strike}`} title="One lot fewer (the leg is removed with its last lot)" onClick={(e) => { e.stopPropagation(); adjust(row.strike, type, -1); }} className="grid size-6 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-down">−</button>
                        <button type="button" aria-label={`Add one lot ${type} ${row.strike}`} title="One more lot in the same direction" onClick={(e) => { e.stopPropagation(); adjust(row.strike, type, 1); }} className="grid size-6 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-up">+</button>
                      </span>
                    );
                    const bs = (type: OptionType) => (["BUY", "SELL"] as const).map((action) => {
                      const mine = legs.filter((l) => l.strike === row.strike && l.type === type && l.action === action && l.enabled !== false).reduce((s, l) => s + l.lots, 0);
                      return (
                        <button key={action} type="button" aria-label={`${action === "BUY" ? "Buy" : "Sell"} ${type} ${row.strike}`}
                          title={ltp(row.strike, type) == null ? "No stored quote: the premium must be entered by hand" : `${action === "BUY" ? "Buy" : "Sell"} one lot at ${fmtPrice(ltp(row.strike, type))}`}
                          onClick={(e) => { e.stopPropagation(); fromChain(row.strike, type, action); }}
                          className={`min-h-6 min-w-6 rounded-sm border px-1 text-[11px] font-semibold ${action === "BUY" ? "border-up bg-up/10 text-up" : "border-down bg-down text-white"} ${mine > 0 ? "ring-1 ring-paper" : ""}`}>
                          {action === "BUY" ? "B" : "S"}{mine > 0 ? ` ${mine}` : ""}
                        </button>
                      );
                    });
                    const tag = (v: number) => (v === 0 ? null : <span data-testid={`held-${row.strike}`} className={`rounded-sm border px-1 text-[10px] font-semibold ${v > 0 ? "border-up text-up" : "border-down text-down"}`}>{v > 0 ? "+" : "−"}{Math.abs(v)} lot{Math.abs(v) === 1 ? "" : "s"}</span>);
                    const bar = (v: number | null, color: string, align: "left" | "right") => (
                      <div className={`flex h-4 ${align === "right" ? "justify-end" : ""}`}><div className="h-4 rounded-sm" style={{ width: `${v == null ? 0 : Math.max(2, (v / maxOi) * 100)}%`, background: color, opacity: 0.35 }} title={v == null ? "no OI" : `OI ${compactIN(v)}`} /></div>
                    );
                    const cell = (c: ContractGreeks | null | undefined, key: GKey, right: boolean) => (
                      <td key={`${right ? "p" : "c"}${key}`} className={`px-1.5 py-1 text-xs text-muted ${right ? "text-right" : "text-left"}`}>{c == null ? "—" : fmtG(key, c)}</td>
                    );
                    return (
                      <tr key={row.strike} onClick={() => setSel(row.strike)} data-testid={`chain-${row.strike}`} data-held={held ? "true" : undefined}
                        className={`group num cursor-pointer border-t border-rule/40 ${on ? "bg-info/20" : held ? "bg-info/[0.08]" : isAtm ? "bg-brass/10" : row.strike < (spot ?? 0) ? "bg-up/[0.04]" : "bg-down/[0.03]"}`}>
                        {GCOLS.filter((x) => gcols.includes(x.key)).map((x) => cell(g?.ce, x.key, false))}
                        <td className={`px-2 py-1 text-left ${side(netCe)}`}><div className="flex items-center gap-1">{ltp(row.strike, "CE") == null ? "—" : fmtPrice(ltp(row.strike, "CE"))}{tag(netCe)}</div>
                          <div className={`mt-0.5 flex items-center gap-1 ${on || netCe !== 0 ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>{pm("CE", netCe)}{bs("CE")}</div></td>
                        <td className="w-[16%] px-1 py-1">{bar(row.call?.oi ?? null, colors.up, "right")}</td>
                        <td className={`px-2 py-1 text-center font-medium ${isAtm ? "text-brass" : "text-paper"}`}><span className={`inline-block min-w-[3.6rem] rounded-sm border px-1.5 py-0.5 ${held ? "border-info bg-info/25" : "border-rule bg-slate-2"}`}>{fmtInt(row.strike)}</span></td>
                        <td className="w-[16%] px-1 py-1">{bar(row.put?.oi ?? null, colors.down, "left")}</td>
                        <td className={`px-2 py-1 text-right ${side(netPe)}`}><div className="flex items-center justify-end gap-1">{tag(netPe)}{ltp(row.strike, "PE") == null ? "—" : fmtPrice(ltp(row.strike, "PE"))}</div>
                          <div className={`mt-0.5 flex items-center justify-end gap-1 ${on || netPe !== 0 ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>{pm("PE", netPe)}{bs("PE")}</div></td>
                        {[...GCOLS].reverse().filter((x) => gcols.includes(x.key)).map((x) => cell(g?.pe, x.key, true))}
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
            {opened && (
              <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-info/50 bg-info/10 px-3 py-2 text-xs" data-testid="opened-closed">
                <span className="text-paper">Opened closed trade <b>{opened.name}</b>, closed {new Date(opened.closedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST</span>
                <span>Realised <span className={`num ${tone(opened.pnl)}`}>{money(opened.pnl)}</span>{opened.stale && <span className="ml-2 text-warn">at stale stored prices from {fmtDateTimeIST(opened.snapshotAt)}, not live fills</span>}</span>
                <span className="text-muted">Exits: {opened.legs.map((l) => `${l.action === "BUY" ? "B" : "S"} ${l.strike}${l.type} ${l.premium} → ${l.exit}`).join(" · ")}</span>
                <button type="button" className="ml-auto text-info hover:underline" onClick={() => setOpened(null)}>Dismiss</button>
              </div>
            )}
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
              <div className="flex flex-col">
                <div className="border-b border-rule" data-testid="risk-stats">
                  <dl className="flex flex-wrap gap-px bg-rule/60">
                  <Stat big label="P&L now (vs entry)" value={money(totalPnl)} cls={tone(totalPnl)} sub={realisedTotal !== 0 && totalPnl != null ? `booked ${money(realisedTotal)} · open ${money(totalPnl - realisedTotal)}` : undefined} hint="Booked P&L of closed legs plus the open legs at their latest price against your entry premiums" />
                  <Stat big label="Max profit" value={a.profitUnlimited ? "Unlimited" : money(a.maxProfit)} cls="text-up" hint="Best P&L at expiry over every NIFTY level from 0 upwards" />
                  <Stat big label="Max loss" value={a.lossUnlimited ? "Unlimited" : money(a.maxLoss)} cls="text-down" hint="Worst P&L at expiry over every NIFTY level from 0 upwards" />
                  <Stat big label="Reward : Risk" value={rr == null ? "N/A" : `${rr.toFixed(2)} : 1`} />
                  <Stat big label="POP (model estimate)" value={pop == null ? "—" : `${(pop * 100).toFixed(0)}%`} hint="Chance of ending in profit at expiry if NIFTY moves like a lognormal with the ATM implied volatility. A model, not a forecast." />
                                    </dl>
                  <dl className="flex flex-wrap gap-px border-t border-rule/60 bg-rule/60">
                  <Stat label="Breakevens" value={a.breakevens.length ? a.breakevens.map((b) => fmtInt(Math.round(b * 100) / 100)).join(" · ") : "none"} sub={spot ? a.breakevens.map((b) => `${((b / spot - 1) * 100).toFixed(2)}%`).join(" · ") : undefined} />
                  <Stat label="Net premium" value={netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`} cls={tone(netPremium)} />
                  {greeks && greeks.unavailable.length === 0 && <Stat label="Net Δ (model)" value={greeks.delta.toFixed(1)} sub={`Θ ${money(greeks.thetaDay)}/day · Vega ${money(greeks.vegaPt)}`} hint="Position delta in NIFTY units; theta per calendar day; vega per volatility point. Black-76 model values." />}
                  {ifTarget && <Stat label="If targets hit" value={money(ifTarget.v)} cls={tone(ifTarget.v)} sub={`${ifTarget.n} of ${live.length} legs, at their target premium`} hint="Sum over the legs that have a target of (target premium - entry) x quantity. Exact arithmetic, not a forecast." />}
                  {ifStop && <Stat label="If stops hit" value={money(ifStop.v)} cls={tone(ifStop.v)} sub={`${ifStop.n} of ${live.length} legs, at their stop premium`} hint="Sum over the legs that have a stop of (stop premium - entry) x quantity. Exact arithmetic, not a forecast." />}
                  </dl>
                </div>
                <div className="min-w-0 p-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-sm bg-slate-2 px-3 py-2 text-xs" data-testid="oi-strip">
                    <span className="text-muted">{oiMode === "change" ? "OI change" : "OI"} data at <span className="num text-paper">{atmK ?? "—"}</span></span>
                    {atmK != null && (() => { const row = rows.find((x) => x.strike === atmK); const f = (q: typeof row extends undefined ? never : NonNullable<typeof row>["call"]) => (oiMode === "change" ? q?.oi_change : q?.oi) ?? null; const c = row ? f(row.call) : null, pu = row ? f(row.put) : null; return <><span className="text-muted"><span className="mr-1 inline-block size-2 rounded-sm" style={{ background: colors.up }} />Call <span className="num text-paper">{c == null ? "—" : compactIN(c)}</span></span><span className="text-muted"><span className="mr-1 inline-block size-2 rounded-sm" style={{ background: colors.down }} />Put <span className="num text-paper">{pu == null ? "—" : compactIN(pu)}</span></span></>; })()}
                    <span className="ml-auto flex items-center gap-3 text-muted"><span><span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: colors.up }} />On expiry</span><span><span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: colors.info }} />On target date (model)</span></span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
                    <select className={field} aria-label="Sigma markers" value={lines} onChange={(e) => { const v = e.target.value as typeof lines; setLines(v); try { localStorage.setItem("nse.builder.lines", v); } catch { /* this visit only */ } }}
                      title="Which reference lines the chart draws: expected-move levels at the snapshot (spot x (1 ± k x ATM IV x sqrt(time))) and the stop and target prices of your legs">
                      <option value="both">SD + stop/target lines</option><option value="sd">SD only</option><option value="levels">Stop/target lines only</option><option value="none">No reference lines</option></select>
                    <select className={field} aria-label="Open interest on the chart" value={oiMode} onChange={(e) => setOiMode(e.target.value as "oi" | "change" | "off")} title="Bars come from the option chain on the left, strike by strike"><option value="oi">Open interest</option><option value="change">Change in OI</option><option value="off">No OI</option></select>
                    <span role="group" aria-label="Zoom the payoff chart" className="flex items-center gap-1">
                      <button type="button" aria-label="Zoom out" title="Show a wider price range" disabled={!view?.canOut || zoom <= PAYOFF_ZOOM.min} onClick={() => setZoom((z) => Math.max(PAYOFF_ZOOM.min, z - 1))} className="grid size-9 place-items-center rounded-sm border border-rule bg-slate-2 text-lg text-paper hover:border-info disabled:opacity-40">−</button>
                      <button type="button" aria-label="Zoom in" title="Narrow the chart around the centre of the profit zone" disabled={!view?.canIn || zoom >= PAYOFF_ZOOM.max} onClick={() => setZoom((z) => Math.min(PAYOFF_ZOOM.max, z + 1))} className="grid size-9 place-items-center rounded-sm border border-rule bg-slate-2 text-lg text-paper hover:border-info disabled:opacity-40">+</button>
                      <button type="button" aria-label="Fit profit zone" title="Back to the profit zone view" disabled={zoom === 0} onClick={() => setZoom(0)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-3 text-paper hover:border-info disabled:opacity-40">Fit</button>
                    </span>
                    {view && <span className="num text-muted" data-testid="zoom-range">{fmtInt(view.lo)} – {fmtInt(view.hi)}</span>}
                  </div>
                  <div className="h-[320px] sm:h-[440px]" data-testid="payoff-chart">{chart ? <EChart option={chart} ariaLabel="Strategy payoff" /> : null}</div>
                  <div className="my-2 flex justify-center" data-testid="projected"><span className={`rounded-sm px-3 py-1 text-xs font-semibold text-white ${whatEst == null ? "bg-slate-2" : whatEst >= 0 ? "bg-up/80" : "bg-down/80"}`}>Projected {whatEst == null || Math.round(whatEst) === 0 ? "P&L" : whatEst > 0 ? "profit" : "loss"} at NIFTY {fmtInt(Math.round(whatSpot ?? 0))} on {new Date(targetMs).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}: {money(whatEst == null ? null : Math.round(whatEst) + 0)} (model)</span></div>
                  <div className="grid gap-5 border-t border-rule px-2 py-3 text-xs text-muted md:grid-cols-2" data-testid="whatif">
                    <div>
                      <div className="flex items-center justify-between"><span className="text-paper">NIFTY target</span>
                        <span className="flex items-center gap-1"><span className="num">{whatPct > 0 ? "+" : ""}{whatPct.toFixed(1)}%</span>
                          <button type="button" aria-label="Lower NIFTY target" className="grid size-7 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-info" onClick={() => setWhatPct((v) => Math.max(-5, Math.round((v - 0.1) * 10) / 10))}>−</button>
                          <input type="number" aria-label="NIFTY target level" className={`${field} w-24 text-center`} value={whatSpot == null ? "" : Number(whatSpot.toFixed(2))} onChange={(e) => spot && e.target.value !== "" && setWhatPct(Math.max(-5, Math.min(5, (Number(e.target.value) / spot - 1) * 100)))} />
                          <button type="button" aria-label="Raise NIFTY target" className="grid size-7 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-info" onClick={() => setWhatPct((v) => Math.min(5, Math.round((v + 0.1) * 10) / 10))}>+</button></span></div>
                      <button type="button" className="text-info hover:underline" onClick={() => setWhatPct(0)}>Reset</button>
                      <input type="range" className="mt-1 w-full" min={-5} max={5} step={0.1} value={whatPct} onChange={(e) => setWhatPct(Number(e.target.value))} aria-label="NIFTY what-if" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between"><span className="text-paper">Date: <span className="num">{Math.max(0, dte - Math.min(days, dte))}D to expiry</span></span>
                        <span className="flex items-center gap-1">
                          <button type="button" aria-label="Previous day" disabled={days <= 0} className="grid size-7 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-info disabled:opacity-40" onClick={() => setDays((d) => Math.max(0, Math.min(d, dte) - 1))}>‹</button>
                          <span className="num text-paper">{new Date(targetMs).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span>
                          <button type="button" aria-label="Next day" disabled={days >= dte} className="grid size-7 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-info disabled:opacity-40" onClick={() => setDays((d) => Math.min(dte, Math.min(d, dte) + 1))}>›</button></span></div>
                      <button type="button" className="text-info hover:underline" onClick={() => setDays(0)}>Reset</button>
                      <input type="range" className="mt-1 w-full" min={0} max={dte} step={1} value={Math.min(days, dte)} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days from snapshot" />
                      <div className="flex justify-between"><span>{new Date(snapMs).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}</span><span>{expiry ? dmy(expiry) : ""}</span></div>
                    </div>
                    <label className="flex items-center gap-3 md:col-span-2">Implied volatility shift <span className="num text-paper">{ivPts > 0 ? "+" : ""}{ivPts} vol points</span>
                      <input type="range" className="flex-1" min={-10} max={10} step={0.5} value={ivPts} onChange={(e) => setIvPts(Number(e.target.value))} aria-label="IV shift" /><button type="button" className="text-info hover:underline" onClick={() => setIvPts(0)}>Reset</button></label>
                    <p className="md:col-span-2" data-testid="whatif-readout">{whatPct === 0 ? "Move the NIFTY target to see the P&L at a level." : <>At NIFTY <span className="num text-paper">{fmtInt(Math.round(whatSpot ?? 0))}</span>: estimated on the chosen day <span className={`num ${tone(whatEst)}`}>{money(whatEst)}</span> (model) · if held to expiry <span className={`num ${tone(whatExp)}`}>{money(whatExp)}</span> (exact)</>}</p>
                  </div>
                  <details className="px-2 pb-2 text-xs" data-testid="model-inputs">
                    <summary className="cursor-pointer text-info">Model inputs (where every estimate comes from)</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                      <li>Forward: {fwd ? <><span className="num text-paper">{fmtPrice(fwd.forward)}</span> from put-call parity at the {fwd.n} strikes nearest spot (spread between them {fwd.spread.toFixed(1)} pts); implied carry <span className="num text-paper">{(carry * 100).toFixed(2)}%</span> a year</> : <>not available (fewer than 3 strikes with both a stored call and put price), so spot grown at the {rate}% rate you set is used</>}.</li>
                      <li>Rate {rate}% is used only to discount; change it in Settings.</li>
                      <li>Valued at {new Date(snapMs).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST{snapMs !== fetchedMs ? <>: the chain was fetched at {new Date(fetchedMs).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST, after the prices were last traded, so decay is counted from the market time, not the fetch.</> : "."}</li>
                      <li>Volatility: each leg uses the implied volatility of its own strike's stored price ({mlegs.filter((l) => marketIv(l) != null).length} of {mlegs.length} legs; the rest fall back to the entry premium). The ±σ markers and POP use the ATM implied volatility <span className="num text-paper">{atmIv == null ? "—" : `${(atmIv * 100).toFixed(1)}%`}</span> at strike {atmK ?? "—"}.</li>
                      <li>Markers: spot × (1 ± k × ATM IV × √T) with T the calendar time to the expiry close; the probability of profit separately uses a lognormal around the forward ({dte} days). {straddle != null && spot ? <>For a model-free cross-check the ATM straddle costs <span className="num text-paper">{fmtPrice(straddle)}</span> ({((straddle / spot) * 100).toFixed(2)}% of spot) against a ±1σ move of {bands ? <span className="num text-paper">{fmtInt(Math.round((bands.p1 - bands.m1) / 2))}</span> : "—"} points.</> : null}</li>
                    </ul>
                  </details>
                  <p className="px-2 pb-2 text-[11px] text-muted">Solid: exact P&L at expiry on your entry premiums, before brokerage, taxes and charges. Dashed: Black-76 model estimate for the chosen day, never a market price.</p>
                </div>
              </div>
            )}
          </section>

          {legs.length > 0 && (
            <section aria-label="Positions" className="rounded-[var(--radius-panel)] border border-rule bg-slate">
              <div className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2 text-sm">
                {(["positions", "greeks", "scenarios"] as const).map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} className={`rounded-sm px-3 py-1 ${tab === t ? "bg-info/15 text-info" : "text-muted hover:text-paper"}`}>{t === "positions" ? "Positions" : t === "greeks" ? "Greeks" : "Scenarios"}</button>)}
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span>Multiplier <button type="button" aria-label="Decrease multiplier" className="mx-1 rounded-sm border border-rule px-2" onClick={() => setMult((m) => Math.max(1, m - 1))}>−</button><span className="num text-paper" data-testid="mult">{mult}</span><button type="button" aria-label="Increase multiplier" className="mx-1 rounded-sm border border-rule px-2" onClick={() => setMult((m) => m + 1)}>+</button></span>
                  <span>Qty per lot <span className="num text-paper">{lotSize ?? "—"}</span></span>
                  <span>Total P&L <span className={`num ${tone(totalPnl)}`}>{money(totalPnl)}</span></span>
                  {loaded && savedEntry && (
                    <button type="button" disabled={!dirty || legs.length === 0 || !expiry} data-testid="update-saved"
                      title={dirty ? `Overwrite the saved strategy “${loaded}” with what is shown now` : `“${loaded}” already matches what is shown`}
                      onClick={() => { persist(saved.map((x) => (x.name === loaded ? { ...x, updatedAt: new Date().toISOString(), expiry: expiry!, legs } : x))); setBaseline(legs); }}
                      className="rounded-sm border border-brass bg-brass/15 px-3 py-1 text-paper hover:bg-brass/25 disabled:opacity-40">Update{dirty && <span className="ml-1 text-warn" aria-label="unsaved changes">●</span>}</button>
                  )}
                  <button type="button" onClick={exitAll} disabled={!lotSize || legs.every((l) => l.enabled === false)} title="Exit every ticked leg at its stored price and save the result to Closed. Nothing is sent to a broker." className="rounded-sm border border-down bg-down/15 px-3 py-1 font-semibold text-down hover:bg-down/25 disabled:opacity-40">Exit all</button>
                </div>
              </div>
              {tab === "positions" ? (
                <div className="p-2">
                  {(() => {
                    const hits = open.flatMap((l) => (["stop", "target"] as const).flatMap((k) => { const m = ltp(l.strike, l.type); return m != null && hitOf(l, k, m) ? [{ l, k, m }] : []; }));
                    return hits.length === 0 ? null : (
                      <div role="status" className="mb-2 rounded-sm border border-warn/60 bg-warn/10 px-3 py-2 text-xs" data-testid="hit-banner">
                        {hits.map(({ l, k, m }) => <div key={l.id + k} className={k === "stop" ? "text-down" : "text-up"}>{k === "stop" ? "Stop" : "Target"} reached on {l.action} {fmtInt(l.strike)} {l.type}: price {fmtPrice(m)} against {fmtPrice((k === "stop" ? l.stop : l.target) as number)}.</div>)}
                        <div className="mt-1 text-muted">Nothing is exited for you and nothing is sent to a broker. Use Exit all, or untick or remove the leg here and act in your broker.</div>
                      </div>
                    );
                  })()}
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-slate-2 px-3 py-2 text-xs" data-testid="auto-bar">
                    <label className="flex items-center gap-1.5 text-paper" title="When the live price of a leg reaches its stop or target, the leg is closed in this strategy at the live price, and a stopped-out leg can be entered again (see Re-entry). Paper only: nothing is sent to a broker. Needs live prices and this page open.">
                      <input type="checkbox" aria-label="Auto stop and target" checked={autoOn} onChange={(e) => { setAutoOn(e.target.checked); try { localStorage.setItem("nse.builder.auto", e.target.checked ? "1" : "0"); } catch { /* this visit only */ } }} />
                      Auto stop &amp; target (paper) <Info term="Auto stop and target" />
                    </label>
                    <span data-testid="auto-state" className={autoActive ? "text-up" : "text-muted"}>
                      {!autoOn ? "off: levels are only shown" : autoActive ? "watching live prices" : "paused: no live prices (market closed or stream not live)"}
                    </span>
                    {autoNote && <button type="button" onClick={() => setAutoNote(null)} className="ml-auto max-w-full truncate text-left text-warn" title="Click to dismiss" data-testid="auto-note">{autoNote} ✕</button>}
                  </div>
                  <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted" data-testid="legs-summary">
                    <span><span className="num text-paper">{legs.filter((l) => l.enabled !== false).length}</span> of {legs.length} legs active</span>
                    <span>Net premium <span className={`num ${tone(netPremium)}`}>{netPremium == null ? "—" : `${money(netPremium)} ${netPremium >= 0 ? "credit" : "debit"}`}</span></span>
                    <span>Greeks: Δ <span className="num text-paper">{greeks && greeks.unavailable.length === 0 ? greeks.delta.toFixed(1) : "—"}</span> · Θ/day <span className={`num ${tone(greeks ? greeks.thetaDay : null)}`}>{greeks && greeks.unavailable.length === 0 ? money(greeks.thetaDay) : "—"}</span> (model)</span>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="legs-table w-full text-sm md:[&_td]:!px-0.5 md:[&_th]:!px-0.5" aria-label="Strategy legs">
                    <thead className="text-xs text-muted"><tr>{[["", ""], ["Leg", ""], ["Strike", "Strike"], ["Lots", "Lots"], ["Entry ₹", "Entry"], ["LTP", "LTP"], ["P&L", "P&L"], ["Δ · Θ/day", "Delta per day"], ["Target ₹", "Target"], ["Stop ₹", "Stop"], ["", ""]].map(([h, term], i) => <th key={i} className="px-1 py-1 text-left font-normal"><span className="inline-flex items-center gap-1">{h}{term && <Info term={term} />}</span></th>)}</tr></thead>
                    <tbody>
                      {legs.map((l) => {
                        const mk = ltp(l.strike, l.type);
                        const issue = issues.filter((i) => i.legId === l.id);
                        const pl = unreal(l, mk);
                        const si = strikes.indexOf(l.strike);
                        const lg = lotSize && spot && l.enabled !== false && !isExited(l) ? legGreeks({ ...l, lots: l.lots * mult, iv: l.iv ?? marketIv(l) }, lotSize, val0) : null;
                        const buy = l.action === "BUY";
                        const step = "grid size-6 place-items-center rounded-sm border border-rule bg-slate-2 text-paper hover:border-info disabled:opacity-40";
                        const exited = isExited(l);
                        return (
                          <Fragment key={l.id}>
                          <tr className={`border-t border-rule/50 align-top ${l.enabled === false ? "opacity-50" : exited ? "opacity-70" : ""}`} style={{ boxShadow: `inset 3px 0 0 ${buy ? "var(--up)" : "var(--down)"}` }} data-testid={`leg-${l.id}`}>
                            <td className="px-2 py-2"><input type="checkbox" aria-label="Include leg" checked={l.enabled !== false} onChange={(e) => update(l.id, { enabled: e.target.checked })} /></td>
                            <td data-label="Leg" className="px-1 py-1.5"><div className="flex gap-1">
                              <select className={`${field} !px-1 font-semibold ${buy ? "border-up/60 text-up" : "border-down/60 text-down"}`} aria-label="Action" value={l.action} onChange={(e) => update(l.id, { action: e.target.value as Action })}><option>BUY</option><option>SELL</option></select>
                              <select className={`${field} !px-1 font-semibold`} aria-label="Option type" value={l.type} onChange={(e) => { const t = e.target.value as OptionType; const m = ltp(l.strike, t); update(l.id, { type: t, ...(l.premiumSource === "manual" ? {} : { premium: m, premiumSource: m == null ? null : "market" }) }); }}><option>CE</option><option>PE</option></select>
                            </div></td>
                            <td data-label="Strike" className="px-1 py-1.5"><div className="flex items-center gap-1">
                              <button type="button" className={step} aria-label="Previous strike" disabled={si <= 0} onClick={() => chooseStrike(l, strikes[si - 1]!)}>‹</button>
                              <select className={`${field} w-[4.9rem] !px-1`} aria-label="Strike" value={l.strike} onChange={(e) => chooseStrike(l, Number(e.target.value))}>{si < 0 && <option value={l.strike}>{l.strike} (not listed)</option>}{strikes.map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}</select>
                              <button type="button" className={step} aria-label="Next strike" disabled={si < 0 || si >= strikes.length - 1} onClick={() => chooseStrike(l, strikes[si + 1]!)}>›</button>
                            </div><div className="num mt-0.5 text-[10px] text-muted">{dmy(l.expiry)}{spot ? ` · ${(((l.strike / spot) - 1) * 100).toFixed(1)}% vs spot` : ""}</div></td>
                            <td data-label="Lots" className="px-1 py-1.5"><div className="flex items-center gap-1">
                              <button type="button" className={step} aria-label="Decrease lots" disabled={l.lots <= 1} onClick={() => update(l.id, { lots: Math.max(1, l.lots - 1) })}>−</button>
                              <input className={`${field} w-10 !px-1 text-center`} type="number" min={1} step={1} aria-label="Lots" value={l.lots} onChange={(e) => update(l.id, { lots: Number(e.target.value) })} />
                              <button type="button" className={step} aria-label="Increase lots" onClick={() => update(l.id, { lots: l.lots + 1 })}>+</button>
                            </div><div className="num mt-0.5 text-[10px] text-muted">{lotSize ? `${fmtInt(l.lots * mult * lotSize)} qty` : ""}</div></td>
                            <td data-label="Entry ₹" className="px-1 py-1.5"><input className={`${field} w-[4.6rem] !px-1.5`} type="number" min={0} step="0.05" aria-label="Entry premium" value={l.premium ?? ""} placeholder="enter" title={l.premiumSource === "market" ? "Stored quote" : l.premiumSource === "manual" ? "You entered this" : "Missing"} onChange={(e) => update(l.id, { premium: e.target.value === "" ? null : Number(e.target.value), premiumSource: e.target.value === "" ? null : "manual" })} />
                              <div className="text-[10px] text-muted">{l.premiumSource === "market" ? "stored quote" : l.premiumSource === "manual" ? "you entered" : "missing"}</div></td>
                            <td data-label="LTP" className="num px-1 py-2">{mk == null ? <span className="text-muted" title="No quote in the stored chain for this contract">—</span> : fmtPrice(mk)}</td>
                            <td data-label="P&L" className={`num whitespace-nowrap px-1 py-2 ${tone(pl)}`}>{money(pl)}</td>
                            <td data-label="Δ · Θ/day" className="num px-1 py-2 text-xs">{lg ? <><div className="whitespace-nowrap"><span className="text-muted">Δ </span><span className="text-paper">{lg.delta.toFixed(1)}</span></div><div className="whitespace-nowrap"><span className="text-muted">Θ </span><span className={tone(lg.thetaDay)}>{money(lg.thetaDay)}</span></div></> : <span className="text-muted" title="No volatility fits this leg's stored price">—</span>}</td>
                            <td data-label="Target ₹" className="px-1 py-1">{exitCell(l, "target")}</td>
                            <td data-label="Stop ₹" className="px-1 py-1">{exitCell(l, "stop")}</td>
                            <td className="whitespace-nowrap px-1 py-2">
                              {mk != null && l.premium !== mk && <button type="button" className="mr-2 text-xs text-info hover:underline" aria-label="Use stored quote" title="Set the entry premium to the stored quote" onClick={() => update(l.id, { premium: mk, premiumSource: "market" })}>⟳</button>}
                              <button type="button" className="mr-2 text-xs text-info hover:underline" aria-label="Duplicate leg" title="Duplicate this leg" onClick={() => setLegs((ls) => { const i = ls.findIndex((x) => x.id === l.id); const c = [...ls]; c.splice(i + 1, 0, { ...l, id: newLegId() }); return c; })}>⧉</button>
                              <button type="button" className="text-xs text-down hover:underline" aria-label="Remove leg" title="Remove this leg" onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}>✕</button>
                              {exited && <div className="whitespace-nowrap text-[10px] font-semibold text-warn">EXITED</div>}
                              {issue.map((i) => <div key={i.field + i.message} role={i.level === "error" ? "alert" : undefined} className={`max-w-[28ch] whitespace-normal text-[11px] ${i.level === "error" ? "text-down" : "text-warn"}`}>{i.message}</div>)}
                            </td>
                          </tr>
                          <tr className={`legs-extra ${l.enabled === false ? "opacity-50" : ""}`} data-testid={`leg-extra-${l.id}`} style={{ boxShadow: `inset 3px 0 0 ${buy ? "var(--up)" : "var(--down)"}` }}>
                            <td colSpan={11} className="px-2 pb-2 pt-0">
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                                {!exited ? (
                                  <span className="flex items-center gap-1">
                                    <input aria-label="Exit price" className={`${field} w-[5.2rem] !px-1.5`} type="number" min={0} step="0.05" placeholder={mk == null ? "price" : mk.toFixed(2)}
                                      title="Price to close this leg at; leave empty to close at the live price" value={exitDraft[l.id] ?? ""} onChange={(e) => setExitDraft((d) => ({ ...d, [l.id]: e.target.value }))} />
                                    <button type="button" aria-label="Exit leg" onClick={() => exitNow(l)} disabled={l.premium == null}
                                      className="rounded-sm border border-down/60 bg-down/10 px-3 py-1 font-medium text-down hover:bg-down/20 disabled:opacity-40">Exit</button>
                                  </span>
                                ) : (
                                  <span className="flex flex-wrap items-center gap-2" data-testid="leg-exited">
                                    <span className="text-warn">Exited at {fmtPrice(l.exitPrice as number)} ({l.exitReason}) · booked <span className={`num ${tone(l.realised ?? 0)}`}>{money(l.realised ?? 0)}</span></span>
                                    <button type="button" aria-label="Enter leg again" onClick={() => enterAgain(l)} className="rounded-sm border border-info/60 px-3 py-1 text-info hover:bg-info/10">Enter again at live price</button>
                                  </span>
                                )}
                                <label className="flex items-center gap-1 text-muted" title="How many times a leg closed by its STOP is entered again at the live price once the premium comes back to its own entry premium: down to it for a sold option, up to it for a bought one. 0 = never.">
                                  Re-entry <Info term="Re-entry" />
                                  <input aria-label="Re-entries after a stop" className={`${field} w-12 !px-1 text-center`} type="number" min={0} step={1} value={l.reentry ?? 0}
                                    onChange={(e) => update(l.id, { reentry: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                                </label>
                                {exited && l.exitReason === "stop" && (l.reentry ?? 0) > 0 && l.reentryLevel != null && (
                                  <span className="text-info" data-testid="reentry-armed">re-entry armed: enters again when the premium is {buy ? "back at or above" : "back at or below"} {fmtPrice(l.reentryLevel)} ({l.reentry} left)</span>
                                )}
                                {(l.cycles ?? 0) > 0 && !exited && <span className="text-muted">entry no. {(l.cycles ?? 0) + 1}</span>}
                              </div>
                              {(l.log?.length ?? 0) > 0 && <div className="mt-1 text-[11px] text-muted" data-testid="leg-log">{l.log!.slice(-2).map((x, i) => <div key={i}>{x.text}</div>)}</div>}
                            </td>
                          </tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : tab === "greeks" ? (
                <div className="overflow-x-auto p-2" data-testid="greeks">
                  <table className="w-full text-sm" aria-label="Greeks">
                    <thead className="text-xs text-muted"><tr><th className="px-1 py-1 text-left font-normal">Leg</th><th className="px-1 py-1 text-right font-normal">IV <Info term="IV" /></th><th className="px-1 py-1 text-right font-normal">Δ per unit <Info term="Delta per unit" /></th><th className="px-1 py-1 text-right font-normal">Position Δ <Info term="Position delta" /></th><th className="px-1 py-1 text-right font-normal">Γ <Info term="Gamma" /></th><th className="px-1 py-1 text-right font-normal">Θ / day <Info term="Theta per day" /></th><th className="px-1 py-1 text-right font-normal">Vega / vol pt <Info term="Vega per vol point" /></th></tr></thead>
                    <tbody>
                      {mlegs.map((l) => {
                        const g = lotSize && spot ? legGreeks(l, lotSize, val0) : null;
                        const c = cg.get(l.strike)?.[l.type === "CE" ? "ce" : "pe"];
                        return <tr key={l.id} className="num border-t border-rule/50"><td className="px-1 py-1">{l.action} {l.lots}× {fmtInt(l.strike)} {l.type}</td><td className="px-1 text-right">{c ? `${(c.iv * 100).toFixed(1)}%` : "—"}</td>
                          {!g ? <td colSpan={5} className="px-1 text-right text-xs text-muted">unavailable: no volatility fits the premium</td> : <><td className="px-1 text-right text-muted">{c ? c.delta.toFixed(3) : "—"}</td><td className="px-1 text-right">{g.delta.toFixed(1)}</td><td className="px-1 text-right">{g.gamma.toFixed(4)}</td><td className={`px-1 text-right ${tone(g.thetaDay)}`}>{money(g.thetaDay)}</td><td className={`px-1 text-right ${tone(g.vegaPt)}`}>{money(g.vegaPt)}</td></>}</tr>;
                      })}
                      {greeks && <tr className="num border-t border-rule font-medium"><td className="px-1 py-1">Net</td><td /><td /><td className="px-1 text-right">{greeks.delta.toFixed(1)}</td><td className="px-1 text-right">{greeks.gamma.toFixed(4)}</td><td className={`px-1 text-right ${tone(greeks.thetaDay)}`}>{money(greeks.thetaDay)}</td><td className={`px-1 text-right ${tone(greeks.vegaPt)}`}>{money(greeks.vegaPt)}</td></tr>}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-muted">Black-76 model values. Each leg uses the volatility implied by the stored price of its own strike, forward {fwd ? `${fmtPrice(fwd.forward)} read from put-call parity` : `from the ${rate}% rate assumption (parity unavailable)`}. Position Δ is rupees of P&L per 1-point NIFTY move (lots × lot size × per-unit Δ); Γ is the change of that Δ per point; Θ is the P&L change from one calendar day passing; Vega is the P&L change per volatility point. Rho is not shown: the forward is read from the market, so the rate only discounts.</p>
                </div>
              ) : (
                <div className="overflow-x-auto p-2" data-testid="scenarios">
                  {grid ? (
                    <table className="w-full text-sm" aria-label="Scenario P&L">
                      <thead className="text-xs text-muted"><tr><th className="px-2 py-1 text-left font-normal">NIFTY at expiry distribution</th>{grid.dayOffsets.map((d) => <th key={d} className="px-2 py-1 text-right font-normal">{d >= dte ? "Expiry (exact)" : d === 0 ? "Snapshot" : `Day ${d}`}</th>)}</tr></thead>
                      <tbody>
                        {grid.spots.map((sp, i) => {
                          const peak = Math.max(1, ...grid.cells.flat().map((c) => Math.abs(c ?? 0)));
                          return (
                            <tr key={grid.ks[i]} className="num border-t border-rule/50">
                              <td className="px-2 py-1 text-left">{fmtInt(Math.round(sp))} <span className="text-[11px] text-muted">{grid.ks[i]! > 0 ? "+" : ""}{grid.ks[i]}σ · {(((sp / (spot as number)) - 1) * 100).toFixed(2)}%</span></td>
                              {grid.cells[i]!.map((c, j) => <td key={j} className={`px-2 py-1 text-right ${tone(c)}`} style={c == null ? undefined : { background: `color-mix(in srgb, ${c >= 0 ? "var(--up)" : "var(--down)"} ${Math.round((Math.abs(c) / peak) * 28)}%, transparent)` }}>{money(c)}</td>)}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-muted">{ready ? "Needs an at-the-money implied volatility from the stored chain." : "Enter the entry premium of every leg."}</p>}
                  <p className="mt-2 text-[11px] text-muted">Rows are NIFTY levels at -2σ to +2σ of the model distribution (ATM implied volatility {atmIv == null ? "—" : `${(atmIv * 100).toFixed(1)}%`}). Columns before expiry are Black-76 model estimates{ivPts ? ` with implied volatility ${ivPts > 0 ? "+" : ""}${ivPts} points` : ""}; the expiry column is the exact payoff. Entry premiums are yours; nothing here is a forecast.</p>
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
