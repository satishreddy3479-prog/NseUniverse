import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { useDash } from "./DashContext";
import { rangeObservations } from "../../lib/analytics";
import { fmtExpiry, fmtInt, fmtTimeIST } from "../../lib/format";
import { strikeBoard, strikesAround, type StrikeBoard } from "../../lib/optionTools";
import { ratio, rupee, signedUnits, STRIKE_COLORS, timeLinesOption, units, type Line } from "../../lib/priceCharts";
import type { StrikeSeries } from "../../lib/types";

const GROUP = "price-tools";

/** The newest session day's stored samples: where the series starts and the axis bounds, from the same stored samples every chart uses. */
function useSessionWindow() {
  const d = useDash();
  const all = d.history.data?.observations;
  return useMemo(() => {
    const r = rangeObservations(all ?? [], "session");
    return { since: r.afterHoursOnly ? undefined : r.rows[0]?.retrieved_at, bounds: r.bounds, afterHoursOnly: r.afterHoursOnly, loaded: !!all };
  }, [all]);
}

function useStrikeSeries(strikes: string) {
  const d = useDash();
  const w = useSessionWindow();
  const q = useQuery({
    queryKey: ["strikeSeries", d.expiry, strikes, w.since],
    queryFn: () => api.strikeSeries(d.expiry!, strikes, w.since),
    enabled: !!d.expiry && !!w.since, refetchInterval: 30_000, retry: false,
  });
  return { q, w };
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-h-[300px] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <header className="flex min-h-9 items-center justify-between gap-2 border-b border-rule px-3">
        <h2 className="text-sm font-semibold text-paper">{title}</h2>{right}
      </header>
      <div className="min-h-0 flex-1 p-1.5">{children}</div>
    </section>
  );
}

const pill = (on: boolean) => `widget-nodrag min-h-7 rounded-sm border px-2 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;

/** Shared states and footer for the three boards. */
function Frame({ q, w, res, children, footer }: {
  q: { isPending: boolean; error: unknown }; w: ReturnType<typeof useSessionWindow>; res: StrikeSeries | undefined;
  children: ReactNode; footer: ReactNode;
}) {
  const d = useDash();
  if (!d.expiry) return <EmptyState title="No expiry">Choose an expiry above.</EmptyState>;
  if (d.chain.isPending) return <p className="p-3 text-sm text-muted">Loading the option chain…</p>;
  if (!d.snapshot) return <EmptyState title="No snapshot stored for this expiry yet">{d.noSnapshot ? "Refresh or start the stream to store one." : "No option-chain data to show."}</EmptyState>;
  if (!w.loaded || (q.isPending && w.since)) return <p className="p-3 text-sm text-muted">Loading stored samples…</p>;
  if (w.afterHoursOnly || !w.since)
    return <EmptyState title="No session samples stored yet">The sampler stores one sample a minute during the market session. Only after-hours samples exist for this expiry, and they would draw a flat line, so nothing is plotted.</EmptyState>;
  if (q.error) return <EmptyState title="Could not load the stored series">{String((q.error as Error).message)}</EmptyState>;
  if (!res || res.times.length < 2) return <EmptyState title="Not enough samples yet">A line needs at least two stored samples in the session ({res?.times.length ?? 0} so far).</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      {children}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span>Stored one-minute samples (not ticks), newest session only</span>
        <span>{fmtExpiry(d.expiry)}</span>
        <span>last sample {fmtTimeIST(res.times[res.times.length - 1])}</span>
        {footer}
        {res.warnings.map((x) => <span key={x} className="text-warn">{x}</span>)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- Price vs OI: one strike, six linked charts

function StrikeSelect({ strikes, atm, value, onChange }: { strikes: number[]; atm: number | null; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      Strike
      <select aria-label="Strike" value={value == null ? "atm" : String(value)} onChange={(e) => onChange(e.target.value === "atm" ? null : Number(e.target.value))}
        className="widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
        <option value="atm">ATM{atm != null ? ` (${fmtInt(atm)})` : ""}, latest</option>
        {strikes.map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}
      </select>
    </label>
  );
}

export function PriceOiBoard() {
  const d = useDash();
  const c = useChartColors();
  const [pick, setPick] = useState<number | null>(null);
  const { q, w } = useStrikeSeries(pick == null ? "atm" : String(pick));
  const res = q.data;
  const strike = res?.strikes[0] ?? null;
  const b: StrikeBoard | null = useMemo(() => (res && strike != null ? strikeBoard(res, strike) : null), [res, strike]);
  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((x, y) => x - y), [d.rows]);
  const bounds = w.bounds;
  const opts = useMemo(() => {
    if (!b) return null;
    const ce = (n: string, data: (number | null)[], fmt: Line["fmt"], axis: 0 | 1 = 0, dotted = false): Line => ({ name: n, color: c.up, data, fmt, axis, dotted });
    const pe = (n: string, data: (number | null)[], fmt: Line["fmt"], axis: 0 | 1 = 0, dotted = false): Line => ({ name: n, color: c.down, data, fmt, axis, dotted });
    const k = fmtInt(b.strike);
    const grey = (n: string, data: (number | null)[], fmt: Line["fmt"], hidden = false): Line => ({ name: n, color: c.muted, data, fmt, axis: 1, dotted: true, hidden });
    const t = b.times;
    return {
      price: timeLinesOption(t, [ce(`${k} CE Price`, b.cePrice, rupee), pe(`${k} PE Price`, b.pePrice, rupee), grey("PCR", b.pcr, ratio, true)], c, bounds, { leftFmt: rupee, rightFmt: ratio }),
      straddle: timeLinesOption(t, [{ name: "Straddle Price", color: c.info, data: b.straddle, fmt: rupee }, grey("PCR", b.pcr, ratio)], c, bounds, { leftFmt: rupee, rightFmt: ratio }),
      ceOi: timeLinesOption(t, [ce(`${k} CE Price`, b.cePrice, rupee), grey(`${k} CE OI`, b.ceOi, units), { name: "PCR", color: c.muted, data: b.pcr, fmt: ratio, axis: 1, dotted: true, hidden: true }], c, bounds, { leftFmt: rupee }),
      peOi: timeLinesOption(t, [pe(`${k} PE Price`, b.pePrice, rupee), grey(`${k} PE OI`, b.peOi, units), { name: "PCR", color: c.muted, data: b.pcr, fmt: ratio, axis: 1, dotted: true, hidden: true }], c, bounds, { leftFmt: rupee }),
      oi: timeLinesOption(t, [ce(`${k} CE OI`, b.ceOi, units), pe(`${k} PE OI`, b.peOi, units), { name: "PCR", color: c.muted, data: b.pcr, fmt: ratio, axis: 1, dotted: true, hidden: true }], c, bounds, { leftFmt: units }),
      change: timeLinesOption(t, [ce(`${k} CE OI Change`, b.ceChange, signedUnits), pe(`${k} PE OI Change`, b.peChange, signedUnits)], c, bounds, { leftFmt: signedUnits, zeroLine: true }),
    };
  }, [b, c, bounds]);
  const k = strike == null ? "" : fmtInt(strike);
  return (
    <div className="flex flex-col gap-3" data-testid="price-oi-board">
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
        <StrikeSelect strikes={listed} atm={d.atmStrike} value={pick} onChange={setPick} />
        <span className="text-xs text-muted">
          {pick == null ? `Following the ATM strike of the newest sample (${k || "—"}); the strike stays fixed for the whole session so each line is one contract.` : "Fixed strike. Pick ATM to follow the latest at-the-money strike."}
        </span>
      </div>
      <Frame q={q} w={w} res={res} footer={b && (
        <>
          <span>{b.times.length} samples</span>
          {b.straddleGaps > 0 && <span>{b.straddleGaps} point(s) have no straddle because a price was missing</span>}
          {b.outsideSession > 0 && <span>{b.outsideSession} after-hours sample(s) left out</span>}
          <span className="basis-full">
            Prices are last traded prices; OI is in units (lot size 65 contracts per lot); OI change = OI now minus previous-day OI. PCR here is this strike&apos;s put OI ÷ call OI (click “PCR” in a legend to show it).
            Straddle = call price + put price of the same strike. The charts are linked: hover one and the others mark the same minute.
          </span>
        </>
      )}>
        {b && opts ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Price (Call vs Put)"><EChart group={GROUP} option={opts.price} ariaLabel={`${k} call and put price through the session`} /></Panel>
            <Panel title={`${k} Straddle Price + PCR`}><EChart group={GROUP} option={opts.straddle} ariaLabel={`${k} straddle price and PCR`} /></Panel>
            <Panel title={`${k} CE Price vs OI`}><EChart group={GROUP} option={opts.ceOi} ariaLabel={`${k} call price against call OI`} /></Panel>
            <Panel title={`${k} PE Price vs OI`}><EChart group={GROUP} option={opts.peOi} ariaLabel={`${k} put price against put OI`} /></Panel>
            <Panel title="OI (Call vs Put)"><EChart group={GROUP} option={opts.oi} ariaLabel={`${k} call and put OI`} /></Panel>
            <Panel title="OI Change (Call vs Put)"><EChart group={GROUP} option={opts.change} ariaLabel={`${k} call and put OI change`} /></Panel>
          </div>
        ) : <EmptyState title="That strike has no stored values">Pick another strike.</EmptyState>}
      </Frame>
    </div>
  );
}

// ---------------------------------------------------------------- MultiStrike and Multi-Straddle

type Metric = "price" | "oi" | "change";
const METRICS: { id: Metric; label: string }[] = [{ id: "price", label: "Price" }, { id: "oi", label: "OI" }, { id: "change", label: "OI change" }];

function useStrikePick() {
  const d = useDash();
  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((x, y) => x - y), [d.rows]);
  const near = useMemo(() => strikesAround(listed, d.atmStrike, 9), [listed, d.atmStrike]);
  const [picked, setPicked] = useState<number[] | null>(null);
  const atmIdx = near.findIndex((x) => x === d.atmStrike);
  const def = atmIdx < 0 ? near.slice(0, 3) : near.slice(Math.max(0, atmIdx - 1), atmIdx + 2);
  const chosen = (picked ?? def).filter((x) => near.includes(x) || picked != null);
  const toggle = (k: number) => {
    const cur = picked ?? def;
    setPicked(cur.includes(k) ? cur.filter((x) => x !== k) : cur.length >= 6 ? cur : [...cur, k].sort((a, b) => a - b));
  };
  return { near, chosen, toggle };
}

function StrikeChips({ near, chosen, toggle, atm }: { near: number[]; chosen: number[]; toggle: (k: number) => void; atm: number | null }) {
  return (
    <div role="group" aria-label="Strikes" className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
      <span className="mr-1 text-sm text-muted">Strikes (up to 6)</span>
      {near.map((k) => (
        <button key={k} type="button" aria-pressed={chosen.includes(k)} onClick={() => toggle(k)} className={pill(chosen.includes(k))}>
          {fmtInt(k)}{k === atm ? " · ATM" : ""}
        </button>
      ))}
    </div>
  );
}

export function MultiStrikeBoard({ straddle }: { straddle: boolean }) {
  const d = useDash();
  const c = useChartColors();
  const { near, chosen, toggle } = useStrikePick();
  const [metric, setMetric] = useState<Metric>("price");
  const key = chosen.join(",");
  const { q, w } = useStrikeSeries(key || "atm");
  const res = q.data;
  const boards = useMemo(() => (res ? chosen.map((k) => strikeBoard(res, k)).filter((x): x is StrikeBoard => x != null) : []), [res, chosen]);
  const col = (i: number) => STRIKE_COLORS[i % STRIKE_COLORS.length]!;
  const pickM = (b: StrikeBoard, side: "ce" | "pe") => (metric === "price" ? (side === "ce" ? b.cePrice : b.pePrice) : metric === "oi" ? (side === "ce" ? b.ceOi : b.peOi) : side === "ce" ? b.ceChange : b.peChange);
  const f = metric === "price" ? rupee : metric === "oi" ? units : signedUnits;
  const opts = useMemo(() => {
    if (boards.length === 0) return null;
    const t = boards[0]!.times;
    if (straddle) return { ce: null, pe: null, straddle: timeLinesOption(t, boards.map((b, i) => ({ name: `${fmtInt(b.strike)} Straddle`, color: col(i), data: b.straddle, fmt: rupee })), c, w.bounds, { leftFmt: rupee }) };
    const lines = (side: "ce" | "pe"): Line[] => boards.map((b, i) => ({ name: `${fmtInt(b.strike)} ${side === "ce" ? "CE" : "PE"}`, color: col(i), data: pickM(b, side), fmt: f }));
    return { straddle: null, ce: timeLinesOption(t, lines("ce"), c, w.bounds, { leftFmt: f, zeroLine: metric === "change" }), pe: timeLinesOption(t, lines("pe"), c, w.bounds, { leftFmt: f, zeroLine: metric === "change" }) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, c, w.bounds, metric, straddle]);
  return (
    <div className="flex flex-col gap-3" data-testid={straddle ? "multi-straddle-board" : "multistrike-board"}>
      <StrikeChips near={near} chosen={chosen} toggle={toggle} atm={d.atmStrike} />
      {!straddle && (
        <div role="group" aria-label="What to plot" className="flex items-center gap-1.5">
          {METRICS.map((m) => <button key={m.id} type="button" aria-pressed={metric === m.id} onClick={() => setMetric(m.id)} className={pill(metric === m.id)}>{m.label}</button>)}
        </div>
      )}
      {chosen.length === 0 ? <EmptyState title="Pick at least one strike">Choose strikes above.</EmptyState> : (
        <Frame q={q} w={w} res={res} footer={
          <span className="basis-full">
            {straddle ? "Straddle = call price + put price of the same strike, drawn only where both prices were observed." : metric === "price" ? "Last traded price of each contract." : metric === "oi" ? "Open interest in units." : "OI now minus previous-day OI, in units."}
            {" "}Each line is one fixed contract for the whole session. Click a name in the legend to hide it.
          </span>
        }>
          {opts && opts.straddle ? (
            <Panel title="Multi-Straddle"><div className="h-[380px]"><EChart group={GROUP} option={opts.straddle} ariaLabel="Straddle price of the chosen strikes" /></div></Panel>
          ) : opts?.ce && opts.pe ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <Panel title={`Calls · ${METRICS.find((m) => m.id === metric)!.label}`}><div className="h-[340px]"><EChart group={GROUP} option={opts.ce} ariaLabel="Call contracts of the chosen strikes" /></div></Panel>
              <Panel title={`Puts · ${METRICS.find((m) => m.id === metric)!.label}`}><div className="h-[340px]"><EChart group={GROUP} option={opts.pe} ariaLabel="Put contracts of the chosen strikes" /></div></Panel>
            </div>
          ) : null}
        </Frame>
      )}
    </div>
  );
}
