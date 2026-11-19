import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EChart, useChartColors } from "../components/EChart";
import { api } from "../lib/api";
import { DEFAULT_RULE, type DayResult, type EntryLab as Lab, type EntryLabParams, type LabSummary, type SignalRow } from "../lib/entryLab";
import { MISSING } from "../lib/format";

const ENTRY_TIMES = ["09:20", "09:30", "09:45", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
const EXIT_TIMES = ["14:30", "15:00", "15:15", "15:30"];
const STOPS = [null, 20, 30, 50];
const TARGETS = [null, 20, 30, 50];
const ROLLS = [null, 50, 75, 100, 150];
const GAPS = [null, 0.2, 0.3, 0.5, 0.75];
const RANGES = [null, 0.3, 0.4, 0.5, 0.6, 0.8];
const EFFS = [null, 0.3, 0.5, 0.7];
const GIFTS = [null, 0.3, 0.5, 0.75];
const SIGNAL_NAME: Record<string, string> = { gap_pct_abs: "Opening gap (%, size)", gap_ratio: "Opening gap / premium", range_ratio: "Range so far / premium", range_so_far: "Range so far (points)", eff30: "30-minute efficiency (straightness)", acc: "Acceleration (last 15 min / the 15 before)", premium_pct: "Premium (% of the index)", gift_move_pct_abs: "GIFT Nifty overnight move (%, size)", es_move_pct_abs: "S&P 500 futures overnight move (%, size)", gap_surprise_abs: "Gap GIFT did not foresee (points, size)", events_overnight: "High-importance events overnight (count)", events_hold: "High-importance events in the hold (count)" };

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const inr = (v: number | null | undefined) => (v == null ? MISSING : `${v < 0 ? "−" : "+"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const opt = (v: number | null, unit: string) => (v == null ? "None" : `${v}${unit}`);

function Card({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return <section aria-label={title} data-testid={id} className="min-w-0 rounded-[var(--radius-panel)] border border-rule bg-slate p-3"><h2 className="text-sm font-semibold text-paper">{title}</h2><div className="mt-2">{children}</div></section>;
}

function Select<T extends string | number | null>({ label, value, options, onChange, fmt }: { label: string; value: T; options: T[]; onChange: (v: T) => void; fmt?: (v: T) => string }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-muted">{label}
      <select aria-label={label} value={String(value)} onChange={(e) => onChange((options.find((o) => String(o) === e.target.value) ?? value) as T)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper">
        {options.map((o) => <option key={String(o)} value={String(o)}>{fmt ? fmt(o) : String(o)}</option>)}
      </select>
    </label>
  );
}

function Stat({ label, value, sub, cls = "text-paper" }: { label: string; value: string; sub?: string; cls?: string }) {
  return <div className="rounded-sm border border-rule/60 bg-slate-2 px-2 py-1.5"><div className="text-[11px] text-muted">{label}</div><div className={`num text-lg font-semibold ${cls}`}>{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>;
}

function Sweep({ title, rows, label, current, apply }: { title: string; rows: LabSummary[]; label: (v: LabSummary["value"]) => string; current: LabSummary["value"]; apply: (v: LabSummary["value"]) => void }) {
  return (
    <Card title={title} id={`lab-sweep-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-xs">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Rule</th><th className="text-right font-normal">Days</th><th className="text-right font-normal">Mean</th><th className="text-right font-normal">Median</th><th className="text-right font-normal">Win %</th><th className="text-right font-normal">Worst</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.value)} className={`cursor-pointer border-t border-rule/50 hover:bg-slate-2 ${r.value === current ? "bg-brass/10" : ""}`} onClick={() => apply(r.value)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") apply(r.value); }}>
                <td className="py-1 text-paper">{label(r.value)}</td><td className="num text-right">{r.days}</td>
                <td className={`num text-right ${tone(r.mean)}`}>{sg(r.mean)}</td><td className={`num text-right ${tone(r.median)}`}>{sg(r.median)}</td>
                <td className="num text-right">{r.win_pct == null ? MISSING : r.win_pct.toFixed(0)}</td><td className={`num text-right ${tone(r.worst)}`}>{sg(r.worst, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function GateSweep({ title, rows, unit, apply }: { title: string; rows: LabSummary[]; unit: string; apply: (v: LabSummary["value"]) => void }) {
  return (
    <Card title={title} id={`lab-gate-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-xs">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Limit</th><th className="text-right font-normal">Traded</th><th className="text-right font-normal">Mean kept</th><th className="text-right font-normal">Skipped</th><th className="text-right font-normal">Skipped would have made (mean / worst)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.value)} className="cursor-pointer border-t border-rule/50 hover:bg-slate-2" onClick={() => apply(r.value)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") apply(r.value); }}>
                <td className="py-1 text-paper">{typeof r.value === "number" ? `${r.value}${unit}` : String(r.value)}</td><td className="num text-right">{r.days}</td><td className={`num text-right ${tone(r.mean)}`}>{sg(r.mean)}</td>
                <td className="num text-right">{r.gated_days ?? 0}</td><td className={`num text-right ${tone(r.avoided_mean)}`}>{r.avoided_mean == null ? MISSING : `${sg(r.avoided_mean)} / ${sg(r.avoided_worst, 0)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function EntryLab() {
  const c = useChartColors();
  const [p, setP] = useState<EntryLabParams>(DEFAULT_RULE);
  const set = (patch: Partial<EntryLabParams>) => setP((x) => ({ ...x, ...patch }));
  const q = useQuery({
    queryKey: ["entry-lab", p],
    queryFn: () => api.entryLab(p),
    placeholderData: keepPreviousData, retry: false,
    refetchInterval: (query) => { const s = (query.state.data as Lab | undefined)?.status; return s && (s.loading || s.days_loaded < s.days_total - Object.keys(s.failed).length) ? 3000 : false; },
  });
  const d: Lab | undefined = q.data;
  const used = useMemo(() => (d?.days ?? []).filter((r) => !r.skipped), [d?.days]);
  const chart = useMemo(() => {
    if (used.length === 0) return null;
    return {
      animation: false, grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => `${Number(v) >= 0 ? "+" : "−"}${Math.abs(Number(v)).toFixed(1)} points` },
      xAxis: { type: "category", data: used.map((r) => r.day.slice(5)), axisLabel: { color: c.muted, fontSize: 11 } },
      yAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11 }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      series: [{ type: "bar", name: "Net result", data: used.map((r) => ({ value: r.net, itemStyle: { color: (r.net ?? 0) >= 0 ? c.up : c.down } })) }],
    };
  }, [used, c]);

  if (q.isPending) return <div className="h-24 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="lab-loading" />;
  if (q.isError || !d) return <p role="alert" className="rounded-[var(--radius-panel)] border border-down/50 bg-slate p-4 text-sm text-down" data-testid="lab-error">The Entry Lab could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const s = d.summary, st = d.status;
  const failed = Object.keys(st.failed).length;
  const waiting = st.loading || st.days_loaded + failed < st.days_total;
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="lab-page">
      <header>
        <p className="text-xs text-muted"><Link to="/market-intelligence/straddle" className="text-info hover:underline">← Straddle intelligence</Link></p>
        <h1 className="text-xl font-semibold md:text-2xl">Entry Lab</h1>
        <p className="text-xs text-muted">What a short at-the-money straddle rule would have made on the days we recorded. Read-only, past days, booked from stored last traded prices with an assumed cost.</p>
      </header>

      <p role="note" className={`rounded-sm border px-2 py-1.5 text-xs text-paper ${s.sufficient ? "border-rule bg-slate-2" : "border-warn/50 bg-warn/10"}`} data-testid="lab-honesty">{s.message}</p>
      {waiting && <p role="status" className="text-xs text-muted" data-testid="lab-loading-days">Loading the recorded days: {st.days_loaded} of {st.days_total}{failed ? ` (${failed} could not be read)` : ""}. The numbers below use the days loaded so far.</p>}
      {failed > 0 && !waiting && <p className="text-xs text-warn" data-testid="lab-failed">{failed} recorded day(s) could not be read: {Object.entries(st.failed).map(([k, v]) => `${k} (${v})`).join(", ")}.</p>}

      <Card title="The rule" id="lab-controls">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Select label="Enter at" value={p.entry} options={ENTRY_TIMES} onChange={(v) => set({ entry: v })} />
          <Select label="Exit at" value={p.exit} options={EXIT_TIMES} onChange={(v) => set({ exit: v })} />
          <Select label="Stop (premium up)" value={p.stop} options={STOPS} onChange={(v) => set({ stop: v })} fmt={(v) => opt(v, "%")} />
          <Select label="Target (premium down)" value={p.target} options={TARGETS} onChange={(v) => set({ target: v })} fmt={(v) => opt(v, "%")} />
          <Select label="Re-strike when NIFTY is" value={p.roll} options={ROLLS} onChange={(v) => set({ roll: v })} fmt={(v) => (v == null ? "Never" : `${v} pts away`)} />
          <Select label="Cost per round trip" value={p.cost} options={[0, 1, 2, 3, 5]} onChange={(v) => set({ cost: v })} fmt={(v) => `${v} pts`} />
        </div>
        <h3 className="mt-3 text-xs font-semibold text-paper">Skip the day when (range-expansion gates, read at the entry minute)</h3>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="lab-gates">
          <Select label="Opening gap above" value={p.maxGap} options={GAPS} onChange={(v) => set({ maxGap: v })} fmt={(v) => (v == null ? "Do not skip" : `${v}%`)} />
          <Select label="Range so far above" value={p.maxRange} options={RANGES} onChange={(v) => set({ maxRange: v })} fmt={(v) => (v == null ? "Do not skip" : `${v} × premium`)} />
          <Select label="30-min efficiency above" value={p.maxEff} options={EFFS} onChange={(v) => set({ maxEff: v })} fmt={(v) => (v == null ? "Do not skip" : `${v}`)} />
          <label className="flex items-end gap-1.5 pb-1.5 text-xs text-paper"><input type="checkbox" aria-label="Skip when the opening range is broken" checked={p.skipBreak} onChange={(e) => set({ skipBreak: e.target.checked })} />Opening range broken</label>
        </div>
        <h3 className="mt-3 text-xs font-semibold text-paper">Skip the day when (overnight context and calendar, known before the open)</h3>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="lab-context-gates">
          <Select label="GIFT Nifty moved more than" value={p.maxGift} options={GIFTS} onChange={(v) => set({ maxGift: v })} fmt={(v) => (v == null ? "Do not skip" : `${v}% overnight`)} />
          <label className="flex items-end gap-1.5 pb-1.5 text-xs text-paper"><input type="checkbox" aria-label="Skip when a high-importance event is inside the hold" checked={p.skipEventsHold} onChange={(e) => set({ skipEventsHold: e.target.checked })} />Event inside the hold</label>
          <label className="flex items-end gap-1.5 pb-1.5 text-xs text-paper"><input type="checkbox" aria-label="Skip when a high-importance event came overnight" checked={p.skipEventsOvernight} onChange={(e) => set({ skipEventsOvernight: e.target.checked })} />Event overnight</label>
        </div>
        <p className="mt-2 text-[11px] text-muted" data-testid="lab-rule-label">{d.rule.label}. After a stop or a target the day is flat (no re-entry); a re-strike costs {d.rule.roll_cost} points.</p>
      </Card>

      {s.days === 0 ? (
        <p className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="lab-empty">{waiting ? "The recorded days are still loading." : "No recorded day could be replayed with this rule."}</p>
      ) : (
        <>
          <Card title={`Result over ${s.days} day${s.days === 1 ? "" : "s"} (net of costs, index points)`} id="lab-summary">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <Stat label="Days" value={String(s.days)} sub={s.skipped ? `${s.skipped} skipped` : undefined} />
              <Stat label="Median day" value={sg(s.median)} cls={tone(s.median)} sub={s.median_range95 ? `95% range ${sg(s.median_range95[0], 0)} to ${sg(s.median_range95[1], 0)}` : "range needs 5 days"} />
              <Stat label="Mean day" value={sg(s.mean)} cls={tone(s.mean)} sub={s.mean_range95 ? `95% range ${sg(s.mean_range95[0], 0)} to ${sg(s.mean_range95[1], 0)}` : "range needs 5 days"} />
              <Stat label="Winning days" value={s.win_pct == null ? MISSING : `${s.win_pct.toFixed(0)}%`} />
              <Stat label="Worst day" value={sg(s.worst, 0)} cls={tone(s.worst)} />
              <Stat label="Best day" value={sg(s.best, 0)} cls={tone(s.best)} />
              <Stat label="Mean worst dip" value={sg(s.mean_max_adverse == null ? null : -s.mean_max_adverse, 0)} sub="largest open loss in a day" />
              <Stat label="Total (₹ per lot)" value={inr(s.rupees_per_lot_total)} cls={tone(s.total)} sub={`${s.mean_restrikes ?? 0} re-strikes a day`} />
            </div>
            {s.leave_one_out && <p className="mt-2 text-xs text-muted" data-testid="lab-loo">Leave one day out: the mean moves between {sg(s.leave_one_out.mean_min)} and {sg(s.leave_one_out.mean_max)} (a swing of {s.leave_one_out.swing.toFixed(1)}); the most influential day is {s.leave_one_out.most_influential_day}. A big swing means a few days carry the result.</p>}
            {s.by_dte && (
              <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[22rem] text-xs" aria-label="By days to expiry" data-testid="lab-dte"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Days to expiry</th><th className="text-right font-normal">Days</th><th className="text-right font-normal">Mean</th><th className="text-right font-normal">Median</th><th className="text-right font-normal">Win %</th><th className="text-right font-normal">Worst</th></tr></thead>
                <tbody>{Object.entries(s.by_dte).map(([k, b]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{k}</td><td className="num text-right">{b.days}</td><td className={`num text-right ${tone(b.mean)}`}>{sg(b.mean)}</td><td className={`num text-right ${tone(b.median)}`}>{sg(b.median)}</td><td className="num text-right">{b.win_pct == null ? MISSING : b.win_pct.toFixed(0)}</td><td className={`num text-right ${tone(b.worst)}`}>{sg(b.worst, 0)}</td></tr>)}</tbody></table></div>
            )}
          </Card>

          {chart && <Card title="Each day's net result (points)" id="lab-chart"><div className="h-[220px]"><EChart option={chart as never} ariaLabel="Net result of the rule on each recorded day" /></div></Card>}

          <Card title="Day by day" id="lab-days">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs">
                <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Day</th><th className="text-right font-normal">Days to expiry</th><th className="text-right font-normal">Strike</th><th className="text-right font-normal">Premium sold</th><th className="text-right font-normal">NIFTY move</th><th className="text-right font-normal">Worst dip</th><th className="text-right font-normal">Gap %</th><th className="text-right font-normal">Range / premium</th><th className="text-right font-normal">Efficiency</th><th className="text-right font-normal">GIFT move %</th><th className="text-right font-normal">Events (night / hold)</th><th className="text-right font-normal">Net</th><th className="text-right font-normal">Exit</th><th className="text-right font-normal">Re-strikes</th></tr></thead>
                <tbody>
                  {d.days.map((r: DayResult) => r.skipped ? (
                    <tr key={r.day} className="border-t border-rule/50 text-muted"><td className="py-1">{r.day}</td><td className="num text-right">{r.dte}</td><td colSpan={12} className="text-right">{r.skipped.startsWith("gate:") ? "not traded" : "skipped"}: {r.skipped.replace(/^gate: /, "")}{r.signals ? ` (gap ${r.signals.gap_pct == null ? MISSING : r.signals.gap_pct.toFixed(2)}%, range ${r.signals.range_ratio == null ? MISSING : r.signals.range_ratio.toFixed(2)} × premium)` : ""}</td></tr>
                  ) : (
                    <tr key={r.day} className="border-t border-rule/50">
                      <td className="py-1 text-paper">{r.day}</td><td className="num text-right">{r.dte}</td><td className="num text-right">{r.strike}</td><td className="num text-right">{r.entry_premium?.toFixed(1)}</td>
                      <td className="num text-right">{sg(r.spot_move, 0)}</td><td className="num text-right text-down">{sg(r.max_adverse == null ? null : -r.max_adverse, 0)}</td>
                      <td className="num text-right">{r.signals?.gap_pct == null ? MISSING : sg(r.signals.gap_pct, 2)}</td><td className="num text-right">{r.signals?.range_ratio == null ? MISSING : r.signals.range_ratio.toFixed(2)}</td><td className="num text-right">{r.signals?.eff30 == null ? MISSING : r.signals.eff30.toFixed(2)}</td>
                      <td className="num text-right" data-testid="lab-gift-cell">{r.signals?.gift_move_pct == null ? MISSING : sg(r.signals.gift_move_pct, 2)}</td>
                      <td className="num text-right" title={[...(r.signals?.events_overnight_names ?? []), ...(r.signals?.events_hold_names ?? [])].join("; ")}>{r.signals?.events_overnight == null ? MISSING : `${r.signals.events_overnight} / ${r.signals.events_hold ?? 0}`}</td>
                      <td className={`num text-right font-semibold ${tone(r.net)}`}>{sg(r.net)}</td><td className="num text-right">{r.exit_at} {r.exit_reason === "time" ? "" : `(${r.exit_reason})`}</td><td className="num text-right">{r.restrikes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {d.presets && (
            <div className="grid gap-3 lg:grid-cols-3" data-testid="lab-presets">
              <Sweep title="Entry time" rows={d.presets.entry_time} label={(v) => String(v)} current={p.entry} apply={(v) => set({ entry: String(v) })} />
              <Sweep title="Re-strike distance" rows={d.presets.re_strike} label={(v) => (v == null ? "Never" : `${v} pts away`)} current={p.roll} apply={(v) => set({ roll: v == null ? null : Number(v) })} />
              <Sweep title="Stop" rows={d.presets.stop} label={(v) => (v == null ? "No stop" : `+${v}% premium`)} current={p.stop} apply={(v) => set({ stop: v == null ? null : Number(v) })} />
            </div>
          )}
          {d.presets && (
            <Card title="Do the range-expansion signals separate good days from bad ones?" id="lab-signal-study">
              <p className="text-xs text-muted" data-testid="lab-signal-note">{d.presets.signal_study.note}</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-xs" aria-label="Signal against the day's result">
                  <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Signal at the entry minute</th><th className="text-right font-normal">Days</th><th className="text-right font-normal">Rank correlation</th><th className="text-right font-normal">At or below its median: mean / worst</th><th className="text-right font-normal">Above: mean / worst</th><th className="text-right font-normal">Calm half better by</th></tr></thead>
                  <tbody>
                    {d.presets.signal_study.signals.map((r: SignalRow) => (
                      <tr key={r.signal} className="border-t border-rule/50">
                        <td className="py-1 text-paper">{SIGNAL_NAME[r.signal] ?? r.signal}</td><td className="num text-right">{r.days}</td>
                        <td className={`num text-right ${r.spearman == null ? "" : r.spearman <= -0.5 ? "text-up" : r.spearman >= 0.5 ? "text-down" : ""}`}>{r.spearman == null ? "needs 5 days" : sg(r.spearman, 2)}</td>
                        <td className="num text-right">{r.at_or_below_median ? `${sg(r.at_or_below_median.mean)} / ${sg(r.at_or_below_median.worst, 0)}` : MISSING}</td>
                        <td className="num text-right">{r.above_median ? `${sg(r.above_median.mean)} / ${sg(r.above_median.worst, 0)}` : MISSING}</td>
                        <td className={`num text-right ${tone(r.split_gap)}`}>{sg(r.split_gap)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">{d.presets.signal_study.sufficient ? "Enough days to read the correlations with some care." : `Only ${d.presets.signal_study.days} days: a correlation here is a description of those days. Do not trade on it.`}</p>
            </Card>
          )}
          {d.presets && (
            <div className="grid gap-3 lg:grid-cols-2" data-testid="lab-gate-sweeps">
              <GateSweep title="Skip on a large opening gap" rows={d.presets.gates.gap} unit="%" apply={(v) => set({ maxGap: Number(v) })} />
              <GateSweep title="Skip when the range so far is large" rows={d.presets.gates.range_so_far} unit=" × premium" apply={(v) => set({ maxRange: Number(v) })} />
              <GateSweep title="Skip when the last 30 minutes were a straight line" rows={d.presets.gates.efficiency} unit="" apply={(v) => set({ maxEff: Number(v) })} />
              <GateSweep title="Skip when the opening range is broken" rows={d.presets.gates.opening_range_break} unit="" apply={() => set({ skipBreak: true })} />
              <GateSweep title="Skip when GIFT Nifty moved a lot overnight" rows={d.presets.gates.gift_move} unit="%" apply={(v) => set({ maxGift: Number(v) })} />
              <GateSweep title="Skip when an event falls inside the hold" rows={d.presets.gates.events_hold} unit="" apply={() => set({ skipEventsHold: true })} />
              <GateSweep title="Skip when an event came overnight" rows={d.presets.gates.events_overnight} unit="" apply={() => set({ skipEventsOvernight: true })} />
            </div>
          )}
          {d.presets && <p className="text-xs text-muted" data-testid="lab-variants">{d.presets.variants_tried} variants are compared above on the same days. {d.presets.note} Click a row to apply it to the rule.</p>}
        </>
      )}

      <ul className="list-disc space-y-1 pl-5 text-[11px] text-muted" data-testid="lab-assumptions">{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
    </div>
  );
}
