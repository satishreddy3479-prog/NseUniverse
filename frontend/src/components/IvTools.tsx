import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtInt, fmtTimeIST, MISSING } from "../lib/format";
import type { HvReport, IvSeries } from "../lib/types";
import { EChart, useChartColors } from "./EChart";

const one = (v: number | null | undefined, unit = "%") => (v == null ? MISSING : `${v.toFixed(2)}${unit}`);
const pts = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} pts`);

function Loading() {
  return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
}
function Problem({ what, e }: { what: string; e: unknown }) {
  return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">{what} could not be loaded: {e instanceof Error ? e.message : "unknown error"}.</p>;
}

const HV_LINES = [
  { id: "10", label: "HV 10 d", color: "info" as const, on: true },
  { id: "20", label: "HV 20 d", color: "up" as const, on: true },
  { id: "30", label: "HV 30 d", color: "muted" as const, on: true },
  { id: "60", label: "HV 60 d", color: "down" as const, on: false },
];

/** Implied volatility (the command center's ATM IV for the chosen expiry) against historical volatility from stored daily closes. */
export function IvHvBody({ expiry }: { expiry: string | null }) {
  const colors = useChartColors();
  const hvq = useQuery({ queryKey: ["intradayHv"], queryFn: () => api.intradayHv(), refetchInterval: 300_000, retry: false });
  const ivq = useQuery({ queryKey: ["intradaySummary", expiry], queryFn: () => api.intradaySummary(expiry!), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  const sq = useQuery({ queryKey: ["ivSeries", expiry], queryFn: () => api.intradayIvSeries(expiry!), enabled: !!expiry, refetchInterval: 60_000, retry: false });
  if (hvq.isLoading || (expiry && ivq.isLoading)) return <Loading />;
  if (hvq.isError || !hvq.data) return <Problem what="Historical volatility" e={hvq.error} />;
  const h: HvReport = hvq.data;
  const vol = ivq.data?.volatility;
  const iv = vol?.status === "ok" ? vol.atm_iv ?? null : null;
  const ivNote = !expiry ? "Waiting for the expiry list from the broker." : ivq.isError ? "Implied volatility could not be computed." : iv == null ? (vol?.status ?? "Implied volatility is not available.") : null;
  const hvNow = (id: string) => h.windows[id]?.hv ?? null;

  // chart 1: ATM IV through the latest stored session, with the historical-volatility levels as dashed lines
  const today: IvSeries | undefined = sq.data && sq.data.points.length >= 2 ? sq.data : undefined;
  const todayOpt = today && {
    grid: { left: 46, right: 14, top: 54, bottom: 28 },
    legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: colors.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8,
      selected: Object.fromEntries(["ATM IV", ...HV_LINES.map((l) => l.label)].map((n) => [n, n === "ATM IV" || (HV_LINES.find((l) => l.label === n)?.on ?? true)])) },
    tooltip: { trigger: "axis", confine: true, backgroundColor: colors.slate, borderColor: colors.rule, textStyle: { color: colors.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: today.points.map((p) => fmtTimeIST(p.at)), axisLabel: { color: colors.muted, hideOverlap: true }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: colors.rule, opacity: 0.6 } } },
    series: [
      { name: "ATM IV", type: "line", showSymbol: today.points.length < 40, data: today.points.map((p) => p.atm_iv), connectNulls: false, lineStyle: { color: colors.brass, width: 2.4 }, itemStyle: { color: colors.brass } },
      ...HV_LINES.map((l) => ({
        name: l.label, type: "line", showSymbol: false, silent: true, lineStyle: { color: colors[l.color], width: 1.4, type: "dashed" }, itemStyle: { color: colors[l.color] },
        data: today.points.map(() => hvNow(l.id)),
        endLabel: { show: hvNow(l.id) != null, formatter: `${l.label.replace("HV ", "")} ${one(hvNow(l.id))}`, color: colors[l.color], fontSize: 10 },
      })),
    ],
  };

  // chart 2: the 20-day HV history, with ATM IV at the close of every stored session on the same axis
  const ivBy = h.iv_by_session ?? [];
  const dates = [...new Set([...h.series.dates, ...ivBy.map((x) => x.date)])].sort();
  const hvByDate = new Map(h.series.dates.map((d, i) => [d, h.series.hv[i] ?? null]));
  const ivByDate = new Map(ivBy.map((x) => [x.date, x.atm_iv]));
  const histOpt = {
    grid: { left: 46, right: 14, top: 54, bottom: 30 },
    legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: colors.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: colors.slate, borderColor: colors.rule, textStyle: { color: colors.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: dates, axisLabel: { color: colors.muted, hideOverlap: true, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: colors.rule, opacity: 0.6 } } },
    series: [
      { name: "HV (20 days)", type: "line", showSymbol: false, data: dates.map((d) => hvByDate.get(d) ?? null), connectNulls: false, lineStyle: { color: colors.info, width: 2 }, itemStyle: { color: colors.info } },
      ...(ivBy.length ? [{ name: "ATM IV at the close", type: "line", showSymbol: true, symbolSize: 8, connectNulls: true, data: dates.map((d) => ivByDate.get(d) ?? null), lineStyle: { color: colors.brass, width: 2 }, itemStyle: { color: colors.brass } }] : []),
      ...(iv == null ? [] : [{ name: "ATM IV now", type: "line", showSymbol: false, silent: true, data: dates.map(() => iv), lineStyle: { color: colors.brass, width: 1.2, type: "dashed" }, itemStyle: { color: colors.brass }, endLabel: { show: true, formatter: `now ${iv.toFixed(1)}%`, color: colors.brass, fontSize: 10 } }]),
    ],
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ivhv-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">NIFTY 50 daily closes through {h.as_of ?? MISSING} ({h.bars} bars){h.days_behind != null && h.days_behind > 3 ? ` · ${h.days_behind} days old` : ""} · implied volatility: {iv == null ? MISSING : `ATM ${iv.toFixed(2)}%`}{vol?.as_of ? ` at ${fmtTimeIST(vol.as_of)} IST` : ""}</div>
        {ivNote && <p className="mt-1 text-xs text-warn" data-testid="ivhv-iv-note">{ivNote}</p>}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[26rem] max-w-[40rem] text-xs" data-testid="ivhv-table">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window</th><th className="py-1 text-right font-normal">Historical volatility</th><th className="py-1 text-right font-normal">Implied (ATM)</th><th className="py-1 text-right font-normal">IV − HV</th><th className="py-1 text-right font-normal">IV / HV</th></tr></thead>
            <tbody>
              {Object.entries(h.windows).map(([w, r]) => (
                <tr key={w} className="border-t border-rule/50">
                  <td className="py-1 text-paper">{w} days{r.gap_returns > 0 ? <span className="ml-2 text-warn">{r.gap_returns} gap{r.gap_returns > 1 ? "s" : ""} in the data</span> : null}</td>
                  <td className="num py-1 text-right text-paper">{r.hv == null ? `${MISSING} (needs ${w} returns, has ${r.returns})` : one(r.hv)}</td>
                  <td className="num py-1 text-right text-muted">{one(iv)}</td>
                  <td className="num py-1 text-right text-paper">{iv == null || r.hv == null ? MISSING : pts(iv - r.hv)}</td>
                  <td className="num py-1 text-right text-muted">{iv == null || r.hv == null || r.hv === 0 ? MISSING : (iv / r.hv).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">Historical volatility = standard deviation of daily log returns × √252, in percent, from final daily closes. Implied volatility is the at-the-money value of the Black-76 model for the chosen expiry; the two use different time bases, so read the gap as context (options priced rich or cheap against what the index has actually done), not as a signal.</p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Implied vs historical volatility, latest session</h2>
        {todayOpt ? (
          <>
            <div style={{ height: 320 }} data-testid="ivhv-today"><EChart option={todayOpt} ariaLabel="At-the-money implied volatility through the latest session against historical volatility" /></div>
            <p className="mt-1 text-[11px] text-muted">Solid line: ATM IV from each stored snapshot of {sq.data?.session} (expiry {sq.data?.expiry}). Dashed lines: historical volatility over 10, 20, 30 and 60 days (the 60-day line is off until you click it in the legend). IV above a line means options cost more than the index has recently moved.</p>
          </>
        ) : (
          <p className="text-sm text-muted" data-testid="ivhv-today-empty">{sq.isLoading ? "Reading the stored snapshots…" : `${sq.data?.status ?? "No implied-volatility series is available for this expiry"}.`}</p>
        )}
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">20-day historical volatility and ATM implied volatility, by session</h2>
        <div style={{ height: 320 }} data-testid="ivhv-history"><EChart option={histOpt} ariaLabel="20-day historical volatility with the at-the-money implied volatility at the close of each stored session" /></div>
        <p className="mt-1 text-[11px] text-muted" data-testid="ivhv-history-note">
          {ivBy.length === 0 ? "No stored session has an implied-volatility figure yet. " : `Implied volatility is known only for the ${ivBy.length} session${ivBy.length === 1 ? "" : "s"} whose option chains were stored; earlier days have historical volatility only (nothing is filled in). `}
          {h.iv_by_session_note ?? ""}{ivBy.length > 0 && ` Expiries used: ${[...new Set(ivBy.map((x) => x.expiry))].join(", ")}.`}
        </p>
      </div>
    </div>
  );
}

/** At-the-money implied volatility through the latest stored session, one value per stored snapshot. */
export function IvIntradayBody({ expiry }: { expiry: string | null }) {
  const colors = useChartColors();
  const q = useQuery({ queryKey: ["ivSeries", expiry], queryFn: () => api.intradayIvSeries(expiry!), enabled: !!expiry, refetchInterval: 60_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The implied-volatility series" e={q.error} />;
  const s = q.data;
  if (s.points.length === 0) return <p className="text-sm text-muted" data-testid="ivintraday-empty">{s.status}.</p>;
  const valid = s.points.filter((p) => p.atm_iv != null);
  const first = valid[0]?.atm_iv ?? null;
  const last = valid[valid.length - 1]?.atm_iv ?? null;
  const stale = (s.age_seconds ?? 0) > 300 && s.is_today;
  const option = {
    grid: { left: 46, right: 14, top: 24, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: s.points.map((p) => fmtTimeIST(p.at)), axisLabel: { color: colors.muted, hideOverlap: true } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: colors.rule } } },
    series: [{ name: "ATM IV", type: "line", showSymbol: s.points.length < 40, data: s.points.map((p) => p.atm_iv), connectNulls: false, lineStyle: { color: colors.brass, width: 2 } }],
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ivintraday-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">Expiry {s.expiry} · session {s.session}{s.is_today ? "" : " (not today: the last stored session)"} · {s.samples_in_session} stored snapshots{s.thinned_every && s.thinned_every > 1 ? `, every ${s.thinned_every}th shown` : ""} · newest {s.latest_at ? fmtTimeIST(s.latest_at) : MISSING} IST</div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="ivintraday-stale">The newest snapshot is {Math.round((s.age_seconds ?? 0) / 60)} minutes old: the sampler may have stopped.</p>}
        <div className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4" data-testid="ivintraday-stats">
          <div><div className="text-[11px] text-muted">Latest ATM IV</div><div className="num text-lg font-semibold text-paper">{one(last)}</div></div>
          <div><div className="text-[11px] text-muted">Change since first</div><div className="num text-paper">{first == null || last == null ? MISSING : pts(last - first)}</div></div>
          <div><div className="text-[11px] text-muted">Session high</div><div className="num text-paper">{one(s.high)}</div></div>
          <div><div className="text-[11px] text-muted">Session low</div><div className="num text-paper">{one(s.low)}</div></div>
        </div>
        {valid.length < s.points.length && <p className="mt-1 text-[11px] text-muted">{s.points.length - valid.length} snapshot(s) had no computable IV (shown as gaps, never filled).</p>}
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">At-the-money implied volatility through the session</h2>
        <div style={{ height: 320 }}><EChart option={option} ariaLabel="At-the-money implied volatility through the session" /></div>
        <p className="mt-2 text-[11px] text-muted">{s.model}; assumed rate {s.rate_assumed == null ? MISSING : `${(s.rate_assumed * 100).toFixed(2)}%`}. Computed from the stored option-chain snapshots, the same way as the command center&apos;s IV. A change in IV is context, not a prediction.</p>
      </div>
    </div>
  );
}

/** Implied volatility by strike (rows) and time (columns) through the latest stored session. */
export function IvGridBody({ expiry }: { expiry: string | null }) {
  const colors = useChartColors();
  const q = useQuery({ queryKey: ["ivGrid", expiry], queryFn: () => api.intradayIvGrid(expiry!), enabled: !!expiry, refetchInterval: 60_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Problem what="The implied-volatility grid" e={q.error} />;
  const g = q.data;
  if (g.times.length === 0 || g.strikes.length === 0) return <p className="text-sm text-muted" data-testid="ivgrid-empty">{g.status}.</p>;
  const stale = (g.age_seconds ?? 0) > 300 && g.is_today;
  const labels = g.times.map((t) => fmtTimeIST(t));
  const strikeLabel = (k: number) => `${fmtInt(k)}${k === g.atm_strike ? " ATM" : ""}`;
  const cells: [number, number, number][] = [];
  g.iv.forEach((row, yi) => row.forEach((v, xi) => { if (v != null) cells.push([xi, yi, v]); }));
  const lo = g.min ?? 0, hi = g.max ?? 1;
  const option = {
    grid: { left: 82, right: 12, top: 8, bottom: 70 },
    tooltip: { confine: true, backgroundColor: colors.slate, borderColor: colors.rule, textStyle: { color: colors.paper, fontSize: 12 },
      formatter: (p: { value: [number, number, number] }) => `${labels[p.value[0]]} IST<br/>${strikeLabel(g.strikes[p.value[1]]!)}<br/><b>IV ${p.value[2].toFixed(2)}%</b>` },
    xAxis: { type: "category", data: labels, splitArea: { show: false }, axisLabel: { color: colors.muted, hideOverlap: true }, axisLine: { lineStyle: { color: colors.rule } } },
    yAxis: { type: "category", data: g.strikes.map(strikeLabel), axisLabel: { color: colors.paper, fontSize: 11 }, axisLine: { lineStyle: { color: colors.rule } }, splitArea: { show: false } },
    visualMap: { min: lo, max: hi > lo ? hi : lo + 1, calculable: false, orient: "horizontal", left: "center", bottom: 4, itemWidth: 12, itemHeight: 140,
      text: [`${hi.toFixed(1)}%`, `${lo.toFixed(1)}%`], textStyle: { color: colors.muted }, inRange: { color: [colors.info, colors.up, colors.brass, colors.down] } },
    series: [{ name: "IV", type: "heatmap", data: cells, itemStyle: { borderColor: colors.slate, borderWidth: 1 }, emphasis: { itemStyle: { borderColor: colors.paper, borderWidth: 1 } } }],
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ivgrid-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">Expiry {g.expiry} · session {g.session}{g.is_today ? "" : " (not today: the last stored session)"} · {g.samples_in_session} stored snapshots{g.thinned_every && g.thinned_every > 1 ? `, every ${g.thinned_every}th shown` : ""} · newest {g.latest_at ? fmtTimeIST(g.latest_at) : MISSING} IST · IV from {one(g.min)} to {one(g.max)}</div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="ivgrid-stale">The newest snapshot is {Math.round((g.age_seconds ?? 0) / 60)} minutes old: the sampler may have stopped.</p>}
        {g.status !== "ok" && <p className="mt-1 text-xs text-warn">{g.status}.</p>}
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Implied volatility by strike and time</h2>
        <div style={{ height: Math.max(340, g.strikes.length * 22 + 110) }} data-testid="ivgrid-chart"><EChart option={option} ariaLabel="Implied volatility by strike and time" /></div>
        <p className="mt-1 text-[11px] text-muted" data-testid="ivgrid-note">{g.note} Rows are the strikes around the newest at-the-money strike ({fmtInt(g.atm_strike)}), the same strikes all session; columns are stored snapshots. An empty cell means that price was missing or no IV could be solved; nothing is filled in. {g.model}; assumed rate {g.rate_assumed == null ? MISSING : `${(g.rate_assumed * 100).toFixed(2)}%`}.</p>
      </div>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Latest IV by strike</h2>
        <table className="w-full min-w-[22rem] max-w-[34rem] text-xs" data-testid="ivgrid-table">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Strike</th><th className="py-1 text-right font-normal">IV now</th><th className="py-1 text-right font-normal">Change since first snapshot</th></tr></thead>
          <tbody>
            {[...g.strikes.keys()].reverse().map((i) => {
              const row = g.iv[i]!;
              const now = [...row].reverse().find((v) => v != null) ?? null;
              const ch = g.change[i] ?? null;
              return (
                <tr key={g.strikes[i]} className={`border-t border-rule/50 ${g.strikes[i] === g.atm_strike ? "bg-brass/10" : ""}`}>
                  <td className="num py-1 text-paper">{strikeLabel(g.strikes[i]!)}</td>
                  <td className="num py-1 text-right text-paper">{one(now)}</td>
                  <td className={`num py-1 text-right ${ch == null ? "text-muted" : ch >= 0 ? "text-up" : "text-down"}`}>{pts(ch)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
