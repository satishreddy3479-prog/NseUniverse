import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useViewLayout } from "../../lib/viewLayout";
import { barsOption, cumulativeOption, priceOption, strikePartColors } from "../../lib/strikePremiumCharts";
import { type Contract, driverText, hhmm, type LadderSide, readout, rupee, sg, STRIKE_PARTS, type StrikePremiumData } from "../../lib/strikePremium";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { Loading } from "../Loading";
import { NoExpiry } from "./NoExpiry";
import { useDash } from "./DashContext";
import { useReplay } from "./ReplayContext";
import { useSessionWindow } from "./PriceBoards";
import { PremiumChangeBoard } from "./PremiumChange";
import { Section } from "./VegaAnalysis";

const GROUP = "strike-premium";
const WINDOWS = [{ k: "5", t: "5 min" }, { k: "15", t: "15 min" }, { k: "30", t: "30 min" }, { k: "60", t: "1 hour" }, { k: "open", t: "Since open" }] as const;
const CONTRACTS: { k: Contract; t: string }[] = [{ k: "straddle", t: "Straddle" }, { k: "call", t: "Call" }, { k: "put", t: "Put" }];
const EACH = [3, 5, 8, 10] as const;
const pill = (on: boolean) => `widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const field = "widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const CHIP: Record<string, string> = { time: "bg-slate-2 text-muted", volatility: "bg-warn/15 text-warn", NIFTY: "bg-info/15 text-info", other: "bg-slate-2 text-muted" };

function Side({ s }: { s: LadderSide }) {
  return (
    <>
      <td className="num py-1 pr-2">{s.price == null ? "—" : s.price.toFixed(1)} · <span className={tone(s.change)}>{sg(s.change)}</span></td>
      <td className="py-1 pr-2">{s.driver ? <span className={`rounded-sm px-1.5 py-0.5 ${CHIP[s.driver.name]}`}>{driverText(s.driver)}</span> : <span className="text-muted">—</span>}</td>
    </>
  );
}

function StrikeView() {
  const d = useDash();
  const c = useChartColors();
  const w = useSessionWindow();
  const rp = useReplay();
  const L = useViewLayout("premium-change");
  const [contract, setContract] = L.use<Contract>("contract", "straddle");
  const [windowKey, setWindowKey] = L.use<string>("window", "30");
  const [each, setEach] = L.use<number>("each", 5);
  const [strike, setStrike] = useState<number | null>(null); // null: the at-the-money strike now, held fixed
  const [mode, setMode] = useState<"fixed" | "atm">("fixed");
  const asOf = rp.on && rp.cutMs != null ? new Date(rp.cutMs).toISOString() : null;
  const isLiveDay = !rp.on && (!w.day || w.day === new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  const q = useQuery({
    queryKey: ["strikePremium", d.expiry, w.day, strike, mode, contract, windowKey, each, asOf],
    queryFn: () => api.strikePremium({ expiry: d.expiry!, session: w.day ?? undefined, strike: mode === "fixed" ? strike : null, mode, contract, window: windowKey, each, asOf }),
    enabled: !!d.expiry, refetchInterval: isLiveDay ? 30_000 : false, retry: false, placeholderData: keepPreviousData,
  });
  const data: StrikePremiumData | undefined = q.data;
  const sentence = data?.status === "ok" ? readout(data) : null;

  if (!d.expiry) return <NoExpiry />;
  if (q.isPending) return <Loading label="Loading stored samples…" className="m-3" />;
  if (q.error) return <EmptyState title="Could not load the strike premium">{String((q.error as Error).message)}</EmptyState>;
  if (!data || data.status !== "ok" || !data.summary || !data.series) return <EmptyState title="Nothing to split yet">{data?.message ?? "No stored samples for this expiry yet."}</EmptyState>;

  const cols = strikePartColors();
  const lot = data.lot_size ?? 65;
  const parts = data.summary.parts;
  const bucket = data.bucket ?? 5;
  return (
    <div className="flex flex-col gap-3" data-testid="strike-premium">
      <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
        {w.controls}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div role="group" aria-label="Strike" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Strike</span>
            <button type="button" aria-pressed={mode === "fixed" && strike == null} onClick={() => { setMode("fixed"); setStrike(null); }} className={pill(mode === "fixed" && strike == null)}>ATM now{data.strike_now != null ? ` (${data.strike_now})` : ""}</button>
            <select aria-label="Choose a strike" value={mode === "fixed" ? String(data.strike ?? "") : ""} disabled={mode === "atm"} onChange={(e) => { setMode("fixed"); setStrike(Number(e.target.value)); }} className={field}>
              {mode === "atm" && <option value="">following the ATM</option>}
              {(data.strikes ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button type="button" aria-pressed={mode === "atm"} onClick={() => setMode(mode === "atm" ? "fixed" : "atm")} className={pill(mode === "atm")} title="Follow the at-the-money strike as NIFTY moves; each step is measured on one contract, so a change of strike adds no jump">Follow ATM</button>
          </div>
          <div role="group" aria-label="Contract" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Contract</span>
            {CONTRACTS.map((x) => <button key={x.k} type="button" aria-pressed={contract === x.k} onClick={() => setContract(x.k)} className={pill(contract === x.k)}>{x.t}</button>)}
          </div>
          <div role="group" aria-label="Window" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Window</span>
            {WINDOWS.map((x) => <button key={x.k} type="button" aria-pressed={windowKey === x.k} onClick={() => setWindowKey(x.k)} className={pill(windowKey === x.k)}>{x.t}</button>)}
          </div>
        </div>
      </div>

      <p role="status" className="rounded-[var(--radius-panel)] border border-rule bg-slate-2 px-3 py-2.5 text-sm leading-relaxed text-paper" data-testid="sp-readout">{sentence ?? "The contract could not be split: a price or an implied volatility was missing in this window."}</p>

      {parts && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="sp-tiles">
          {STRIKE_PARTS.map((p, k) => (
            <div key={p.key} className="rounded-sm bg-slate-2 px-3 py-2" data-testid={`sp-tile-${p.key}`}>
              <div className="flex items-center gap-1.5 text-[11px] text-muted"><span className="inline-block size-2.5 rounded-[2px]" style={{ background: cols[k] }} aria-hidden="true" />{p.name}</div>
              <div className={`num text-lg font-semibold ${tone(parts[p.key])}`}>{sg(parts[p.key])}</div>
              <div className="text-[11px] text-muted">{rupee(parts[p.key] * lot)} per lot</div>
            </div>
          ))}
        </div>
      )}

      <Section title={data.mode === "atm" ? "At-the-money price, with NIFTY" : `Price of the ${data.strike} ${data.contract}, with NIFTY`}>
        <div style={{ height: 220 }}><EChart group={GROUP} option={priceOption(data, c)} ariaLabel="Price of the followed contract and NIFTY" /></div>
        <p className="px-3 pb-2 text-[11px] text-muted">{data.mode === "atm" ? "The at-the-money price jumps when the strike changes; the parts below are measured on one contract at a time, so they do not." : "One contract all session, so this is a real price. Dotted: NIFTY, right axis."}</p>
      </Section>
      <Section title="What moved it, added up from the first sample">
        <div style={{ height: 260 }}><EChart group={GROUP} option={cumulativeOption(data, c)} ariaLabel="Parts added up from the first sample, and the real change" /></div>
        <p className="px-3 pb-2 text-[11px] text-muted">The parts add up to the dashed line: the real change of this contract.</p>
      </Section>
      <Section title={`The parts of every ${bucket}-minute bucket`}>
        <div style={{ height: 220 }}><EChart group={GROUP} option={barsOption(data, c)} ariaLabel={`Parts of every ${bucket}-minute bucket`} /></div>
      </Section>

      <Section title={`Every strike, ${windowKey === "open" ? "since the open" : `last ${windowKey} minutes`}: which part drove it`}>
        <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted">
          <label className="flex items-center gap-2">Strikes each side
            <select aria-label="Strikes each side" value={each} onChange={(e) => setEach(Number(e.target.value))} className={field}>{EACH.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
          <span>NIFTY {data.summary.nifty_start != null && data.summary.nifty_end != null ? `${sg(data.summary.nifty_end - data.summary.nifty_start, 0)} points` : "—"} over the window. Click a row to follow that strike.</span>
        </div>
        <div className="overflow-x-auto px-3 pb-2">
          <table className="w-full min-w-[34rem] text-xs" data-testid="sp-ladder">
            <thead><tr className="text-left text-muted"><th className="py-1 pr-2 font-normal">Strike</th><th className="pr-2 font-normal">Call now · change</th><th className="pr-2 font-normal">Driver</th><th className="pr-2 font-normal">Put now · change</th><th className="font-normal">Driver</th></tr></thead>
            <tbody>
              {(data.ladder ?? []).map((r) => {
                const on = data.mode === "fixed" && r.strike === data.strike;
                return (
                  <tr key={r.strike} data-testid={`sp-row-${r.strike}`} aria-selected={on} onClick={() => { setMode("fixed"); setStrike(r.strike); }} className={`cursor-pointer border-t border-rule/50 hover:bg-slate-2 ${on ? "bg-brass/10" : ""}`}>
                    <td className="py-1 pr-2"><button type="button" className="text-left text-paper underline-offset-2 hover:underline" aria-label={`Follow the ${r.strike} strike`} onClick={(e) => { e.stopPropagation(); setMode("fixed"); setStrike(r.strike); }}>{r.strike}</button>{r.atm && <span className="ml-1 rounded-sm bg-slate-2 px-1 text-[10px] text-muted">ATM</span>}</td>
                    <Side s={r.call} /><Side s={r.put} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {data.greeks_now && (
        <p className="rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2 text-xs text-muted" data-testid="sp-greeks">
          <span className="text-paper">{data.greeks_now.strike} {data.contract} now ({hhmm(data.summary.to)}):</span> delta {sg(data.greeks_now.delta, 2)} · gamma {data.greeks_now.gamma.toFixed(4)} · theta {rupee(data.greeks_now.theta_day * lot)}/day · vega {(data.greeks_now.vega_pt * lot).toFixed(0)} rupees per vol point · IV {data.greeks_now.iv_pct.toFixed(1)}%
        </p>
      )}

      <details className="rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2 text-sm text-muted" data-testid="sp-notes">
        <summary className="cursor-pointer text-info">How to read this, and its limits</summary>
        <div className="mt-2 flex flex-col gap-2 leading-relaxed">
          <p>Every stored minute, the price change of the one contract you follow is repriced and split into <b className="text-paper">time</b> (theta), <b className="text-paper">volatility</b> (vega), <b className="text-paper">NIFTY moving</b> as delta (the straight-line part) and gamma (the curve), the <b className="text-paper">vanna and volga</b> cross terms, and <b className="text-paper">other</b>. They are summed, so over any stretch they add up to the contract's real price change; up means the premium rose.</p>
          <p>{data.note} The assumed interest rate is {(data.rate_assumed * 100).toFixed(0)}%.</p>
          <p>This describes what happened. It does not say which way premiums will go next.{(data.skipped_steps ?? 0) > 0 ? ` ${data.skipped_steps} minute${data.skipped_steps === 1 ? "" : "s"} could not be split (a price or volatility was missing) and are left out.` : ""}</p>
        </div>
      </details>
    </div>
  );
}

/** Premium Change: pick a strike (or follow the ATM), a contract and a window, and see what moved that contract's price: time, volatility, NIFTY moving, and the rest. The classic ATM-windows view stays one click away. */
export function StrikePremiumBoard() {
  const L = useViewLayout("premium-change");
  const [view, setView] = L.use<"strike" | "classic">("view", "strike");
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="View" className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" aria-pressed={view === "strike"} onClick={() => setView("strike")} className={pill(view === "strike")}>Strike view</button>
        <button type="button" aria-pressed={view === "classic"} onClick={() => setView("classic")} className={pill(view === "classic")}>ATM windows (classic)</button>
      </div>
      {view === "classic" ? <PremiumChangeBoard /> : <StrikeView />}
    </div>
  );
}
