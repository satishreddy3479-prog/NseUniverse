import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ForwardCell, type ForwardOverview, type ForwardVariant } from "../lib/api";
import { fmtAge, MISSING } from "../lib/format";
import { EChart, useChartColors } from "./EChart";

const IST = "Asia/Kolkata";
const inr = (v: number | null | undefined, signed = false) => (v == null ? MISSING : `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");
const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));
const clock = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(iso));

const Loading = () => <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
const Panel = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section aria-label={title} className="rounded-[var(--radius-panel)] border border-rule bg-slate">
    <header className="border-b border-rule px-3 py-2"><h2 className="text-sm font-semibold">{title}</h2>{hint && <p className="text-xs text-muted">{hint}</p>}</header>
    <div className="p-2">{children}</div>
  </section>
);
const Seg = <T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) => (
  <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
    <span className="mr-1 text-xs uppercase tracking-wide text-muted">{label}</span>
    {options.map(([v, text]) => (
      <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
        className={`min-h-9 rounded-sm border px-3 text-sm ${value === v ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{text}</button>
    ))}
  </div>
);
const Kpi = ({ label, value, sub, cls = "" }: { label: string; value: string; sub?: string; cls?: string }) => (
  <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
    <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
    <div className={`mt-0.5 text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
    {sub && <div className="text-xs text-muted">{sub}</div>}
  </div>
);

const PALETTE = ["#ffb02e", "#2bd99f", "#5aa9ff", "#ff5a64", "#b388ff", "#ff9f3d", "#4dd0e1", "#9ccc65", "#f06292", "#9aabc4", "#ffd54f"];

function Equity({ o, min }: { o: ForwardOverview; min: number }) {
  const colors = useChartColors();
  const ids = Object.keys(o.equity.curves);
  const n = o.equity.times.length;
  if (n < 2) return <p className="p-4 text-sm text-muted">The equity curves start when two positions have settled. Each line is one exit rule: the running total of net P&L after every position.</p>;
  const label = Object.fromEntries(o.variants.map((v) => [v.variant, v.label]));
  const option = {
    animation: false, grid: { left: 64, right: 12, top: 40, bottom: 28 },
    legend: { top: 0, type: "scroll", textStyle: { color: colors.muted } },
    tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (typeof v === "number" ? inr(v, true) : String(v)) },
    xAxis: { type: "category", data: o.equity.times.map((t) => when(t)), axisLabel: { color: colors.muted, hideOverlap: true }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "value", axisLabel: { color: colors.muted, formatter: (v: number) => inr(v) }, splitLine: { lineStyle: { color: colors.rule, opacity: 0.5 } } },
    series: ids.map((id, i) => ({ name: label[id] ?? id, type: "line", showSymbol: n < 40, data: o.equity.curves[id], lineStyle: { width: id === "hold" ? 3 : 1.6, color: PALETTE[i % PALETTE.length] }, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
  };
  return (
    <>
      <EChart option={option} ariaLabel="Cumulative net profit and loss of each exit rule after every position" className="h-[min(60vh,380px)] w-full" />
      {n < min && <p className="px-2 pb-1 text-xs text-warn">Only {n} positions so far: curves this short say little about what an exit rule does over time.</p>}
    </>
  );
}

function Scorecard({ rows, min }: { rows: ForwardVariant[]; min: number }) {
  const best = Math.max(1, ...rows.map((r) => Math.abs(r.total ?? 0)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr><th className="px-2 py-1.5">Exit rule</th><th className="px-2 text-right">Positions</th><th className="px-2 text-right">Win %</th><th className="px-2 text-right">Total net</th><th className="px-2 text-right">Average</th><th className="px-2 text-right">Worst</th><th className="px-2 text-right">Max drawdown</th><th className="px-2 text-right">Profit factor</th><th className="px-2 text-right">Stopped %</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.variant} className="border-t border-rule">
              <td className="px-2 py-1.5 font-medium">{r.label}{r.n > 0 && r.n < min && <span className="ml-2 rounded-full border border-rule px-1.5 text-[10px] text-warn">too few</span>}</td>
              <td className="px-2 text-right tabular-nums">{r.n}</td>
              <td className="px-2 text-right tabular-nums">{r.n ? `${r.win_rate}%` : MISSING}</td>
              <td className="relative px-2 text-right tabular-nums">
                {r.n > 0 && <span aria-hidden className={`absolute inset-y-1 right-0 rounded-sm opacity-20 ${(r.total ?? 0) >= 0 ? "bg-up" : "bg-down"}`} style={{ width: `${Math.min(100, (Math.abs(r.total ?? 0) / best) * 100)}%` }} />}
                <span className={`relative font-semibold ${tone(r.total)}`}>{inr(r.total, true)}</span>
              </td>
              <td className={`px-2 text-right tabular-nums ${tone(r.avg)}`}>{inr(r.avg, true)}</td>
              <td className={`px-2 text-right tabular-nums ${tone(r.worst)}`}>{inr(r.worst, true)}</td>
              <td className={`px-2 text-right tabular-nums ${tone(r.max_drawdown)}`}>{inr(r.max_drawdown)}</td>
              <td className="px-2 text-right tabular-nums">{r.profit_factor == null ? MISSING : r.profit_factor}</td>
              <td className="px-2 text-right tabular-nums">{r.n ? `${r.stop_rate}%` : MISSING}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heat({ o, dim, setDim }: { o: ForwardOverview; dim: string; setDim: (d: string) => void }) {
  const b = o.breakdown;
  const ids = o.variants.map((v) => v.variant);
  const max = Math.max(1, ...b.rows.flatMap((r) => ids.map((id) => Math.abs(r.cells[id]?.avg ?? 0))));
  const cell = (id: string, c: ForwardCell | undefined) => {
    if (!c || c.n === 0 || c.avg == null) return <td key={id} className="px-2 py-1.5 text-right text-muted">{MISSING}</td>;
    const pct = Math.round((Math.abs(c.avg) / max) * 60);
    const faint = c.n < 5 ? "opacity-60" : "";
    return (
      <td key={id} className={`px-2 py-1.5 text-right tabular-nums ${faint}`} style={{ background: `color-mix(in srgb, var(${c.avg >= 0 ? "--up" : "--down"}) ${pct}%, transparent)` }} title={`${c.n} positions, win rate ${c.win_rate}%, total ${inr(c.total, true)}`}>
        <div className="font-semibold">{inr(c.avg, true)}</div><div className="text-[10px] text-muted">n={c.n}</div>
      </td>
    );
  };
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
        <label className="flex items-center gap-2 text-sm text-muted">Break down by
          <select aria-label="Break down by" value={dim} onChange={(e) => setDim(e.target.value)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
            {Object.entries(b.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <span className="text-xs text-muted">Average net P&L per position. Cells with fewer than 5 positions are faded; a row with fewer than {b.min_trades} is marked too few.</span>
      </div>
      {b.rows.length === 0 ? <p className="p-3 text-sm text-muted">Nothing to break down yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-2 py-1.5 text-left">{b.title}</th>{o.variants.map((v) => <th key={v.variant} className="px-2 text-right normal-case">{v.label.replace("Leg stop ", "Leg ").replace("Combined stop ", "Comb ").replace("No stop (hold to 15:20)", "Hold").replace(", other leg to cost", " + cost")}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.bucket} className="border-t border-rule">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">{r.bucket}<div className="text-[11px] font-normal text-muted">{r.n} positions{r.n < b.min_trades && <span className="ml-1 text-warn">· too few</span>}</div></th>
                  {ids.map((id) => cell(id, r.cells[id]))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OpenNow({ o }: { o: ForwardOverview }) {
  if (o.open.length === 0) return <p className="p-3 text-sm text-muted">No open position. One opens the first time the seller score of the weekly or monthly expiry reaches 60 between 09:30 and 14:30; it closes at 15:20.</p>;
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {o.open.map((t) => (
        <div key={t.id} className="rounded-sm border border-rule bg-slate-2 p-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <span className="font-semibold capitalize">{t.structure} · {t.cohort} · #{t.n}</span>
            <span className="text-xs text-muted">opened {clock(t.trigger_at)} · seller {t.seller ?? MISSING} · {t.regime ?? "no regime"}</span>
          </div>
          <div className="text-xs text-muted">Sold {t.ce_strike === t.pe_strike ? `${t.ce_strike} CE + PE` : `${t.ce_strike} CE + ${t.pe_strike} PE`} at {t.ce0} + {t.pe0} = {(t.ce0 + t.pe0).toFixed(2)} · NIFTY {t.spot0.toFixed(0)} → {t.spot == null ? MISSING : t.spot.toFixed(0)}</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-3">
            {Object.entries(t.variants).map(([v, m]) => (
              <div key={v} className="flex justify-between gap-1"><span className="truncate text-muted">{o.variants.find((x) => x.variant === v)?.label.replace("Leg stop ", "Leg ").replace("Combined stop ", "Comb ").replace("No stop (hold to 15:20)", "Hold").replace(", other leg to cost", " + cost")}</span><span className={`tabular-nums ${tone(m.pnl)}`}>{m.stopped_at ? "✕ " : ""}{inr(m.pnl, true)}</span></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Trades({ o }: { o: ForwardOverview }) {
  if (o.trades.length === 0) return <p className="p-3 text-sm text-muted">No settled position yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-2 py-1.5">Opened</th><th className="px-2">Cohort</th><th className="px-2">Structure</th><th className="px-2">Strikes</th><th className="px-2 text-right">Premium</th><th className="px-2">Regime</th><th className="px-2 text-right">Seller</th><th className="px-2 text-right">NIFTY move</th><th className="px-2 text-right">No stop</th><th className="px-2">Best / worst rule</th></tr></thead>
        <tbody>
          {o.trades.map((t) => (
            <tr key={t.id} className="border-t border-rule">
              <td className="px-2 py-1.5 whitespace-nowrap">{when(t.trigger_at)}</td>
              <td className="px-2 capitalize">{t.cohort} #{t.n}</td>
              <td className="px-2 capitalize">{t.structure}</td>
              <td className="px-2 tabular-nums">{t.ce_strike === t.pe_strike ? t.ce_strike : `${t.ce_strike} / ${t.pe_strike}`}</td>
              <td className="px-2 text-right tabular-nums">{(t.ce0 + t.pe0).toFixed(1)}</td>
              <td className="px-2">{t.regime ?? MISSING}</td>
              <td className="px-2 text-right tabular-nums">{t.seller ?? MISSING}</td>
              <td className="px-2 text-right tabular-nums">{t.eod?.net_move_pts == null ? MISSING : `${t.eod.net_move_pts > 0 ? "+" : ""}${t.eod.net_move_pts.toFixed(0)}`}</td>
              <td className={`px-2 text-right tabular-nums ${tone(t.nets.hold)}`}>{inr(t.nets.hold, true)}</td>
              <td className="px-2 text-xs">{t.best && t.worst ? <><span className="text-up">{t.best.variant} {inr(t.best.net, true)}</span> / <span className="text-down">{t.worst.variant} {inr(t.worst.net, true)}</span></> : MISSING}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Paper forward test of short straddles and strangles opened whenever the seller score reaches 60, with every exit rule tracked: dashboards by exit rule and by market regime. */
export function ForwardBody() {
  const [structure, setStructure] = useState<"all" | "straddle" | "strangle">("all");
  const [cohort, setCohort] = useState<"all" | "weekly" | "monthly">("all");
  const [dim, setDim] = useState("regime");
  const q = useQuery({ queryKey: ["forward", structure, cohort, dim], queryFn: () => api.forward(structure, cohort, dim), refetchInterval: 60_000, retry: false, placeholderData: (p) => p });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The forward test could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const o = q.data;
  const c = o.meta.counts;
  const withData = o.variants.filter((v) => v.n > 0);
  const bestTotal = withData.length ? withData.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a)) : null;
  const leastDd = withData.length ? withData.reduce((a, b) => ((b.max_drawdown ?? 0) > (a.max_drawdown ?? 0) ? b : a)) : null;
  const hold = o.variants.find((v) => v.variant === "hold");
  const min = o.meta.min_trades;
  return (
    <div className="flex flex-col gap-3">
      <div role="note" className="rounded-sm border border-rule bg-slate p-3 text-sm">
        <div className="font-semibold">Paper test, nothing is sent to a broker</div>
        <p className="mt-0.5 text-muted">Whenever the seller score of an expiry reaches {o.meta.rules.trigger.match(/\d+/)?.[0] ?? "60"} ({o.meta.rules.entry_window} IST), a short at-the-money straddle and a short strangle (call 50 above, put 50 below) are opened at the last traded prices of the newest stored sample, for the weekly and the monthly expiry. Every exit rule runs on the same entry, so a difference between them is the exit rule alone. All close at {o.meta.rules.exit.replace(" IST the same day", " IST")}. A new position opens after the score has been below 60 for 30 minutes, at most 3 a day per expiry. P&L is for one lot of {o.meta.rules.lot} after estimated charges.</p>
        <p className="mt-1 text-xs text-muted">
          {c.settled} settled · {c.open} open · {c.days} days · last check {o.meta.last_tick ? clock(o.meta.last_tick) + " IST" : "not yet"}{o.meta.last_error ? ` · last error: ${o.meta.last_error}` : ""}{!o.meta.enabled && " · switched off in the settings"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Seg label="Structure" value={structure} onChange={setStructure} options={[["all", "All"], ["straddle", "Straddle"], ["strangle", "Strangle ±50"]]} />
        <Seg label="Expiry" value={cohort} onChange={setCohort} options={[["all", "All"], ["weekly", "Weekly"], ["monthly", "Monthly"]]} />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label="Settled positions" value={String(withData[0]?.n ?? 0)} sub={`${c.open} open now`} />
        <Kpi label="Best total (so far)" value={bestTotal ? inr(bestTotal.total, true) : MISSING} sub={bestTotal ? bestTotal.label : "no result yet"} cls={tone(bestTotal?.total)} />
        <Kpi label="Shallowest drawdown" value={leastDd ? inr(leastDd.max_drawdown) : MISSING} sub={leastDd ? leastDd.label : "no result yet"} cls={tone(leastDd?.max_drawdown)} />
        <Kpi label="No-stop win rate" value={hold && hold.n ? `${hold.win_rate}%` : MISSING} sub={hold && hold.n ? `average ${inr(hold.avg, true)} per position` : "no result yet"} />
      </div>
      {withData.length > 0 && (withData[0]?.n ?? 0) < min && (
        <p role="status" className="rounded-sm border border-warn/50 p-2 text-sm text-warn">Only {withData[0]?.n} settled positions in this view: below about {min} the averages swing on single days and say little about a rule. This builds up by itself, about 4 to 12 positions a day when the score reaches 60.</p>
      )}
      <Panel title="Open now" hint="Marked at the last stored prices, before charges; ✕ means that exit rule has stopped a leg."><OpenNow o={o} /></Panel>
      <Panel title="Exit rules compared" hint="Same entries, different exits. Net of estimated charges, one lot."><Scorecard rows={o.variants} min={min} /></Panel>
      <Panel title="Running total of each exit rule"><Equity o={o} min={min} /></Panel>
      <Panel title="By market regime and other conditions" hint="Where each exit rule works and where it does not."><Heat o={o} dim={dim} setDim={setDim} /></Panel>
      <Panel title="Recent positions" hint="Newest first, the last 60 settled positions of this view."><Trades o={o} /></Panel>
      <p className="text-xs text-muted">
        Prices are the last traded prices of the stored one-minute samples (no bid or ask), and a stop is checked on each sample, so a touch between two samples is not seen. Charges are an estimate. Positions are intraday: they say nothing about holding overnight, gaps or expiry-day gamma. Nothing here is validated until the positions per row are enough to read. Generated {fmtAge((Date.now() - new Date(o.generated_at).getTime()) / 1000)}.
      </p>
    </div>
  );
}
