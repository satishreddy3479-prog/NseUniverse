import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST, MISSING } from "../lib/format";
import { EChart, useChartColors } from "./EChart";

const one = (v: number | null | undefined, unit = "%") => (v == null ? MISSING : `${v.toFixed(2)}${unit}`);
const pts = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} pts`);

function Loading() {
  return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
}
function Problem({ what, e }: { what: string; e: unknown }) {
  return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">{what} could not be loaded: {e instanceof Error ? e.message : "unknown error"}.</p>;
}

/** Implied volatility (command center's ATM IV for the chosen expiry) against historical volatility from stored daily closes. */
export function IvHvBody({ expiry }: { expiry: string | null }) {
  const colors = useChartColors();
  const hvq = useQuery({ queryKey: ["intradayHv"], queryFn: () => api.intradayHv(), refetchInterval: 300_000, retry: false });
  const ivq = useQuery({ queryKey: ["intradaySummary", expiry], queryFn: () => api.intradaySummary(expiry!), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  if (hvq.isLoading || (expiry && ivq.isLoading)) return <Loading />;
  if (hvq.isError || !hvq.data) return <Problem what="Historical volatility" e={hvq.error} />;
  const h = hvq.data;
  const vol = ivq.data?.volatility;
  const iv = vol?.status === "ok" ? vol.atm_iv ?? null : null;
  const ivNote = !expiry ? "Waiting for the expiry list from the broker." : ivq.isError ? "Implied volatility could not be computed." : iv == null ? (vol?.status ?? "Implied volatility is not available.") : null;
  const dates = h.series.dates;
  const option = {
    grid: { left: 48, right: 16, top: 24, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: dates, axisLabel: { color: colors.muted } },
    yAxis: { type: "value", scale: true, axisLabel: { color: colors.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: colors.rule } } },
    series: [{
      name: "HV (20 days)", type: "line", showSymbol: false, data: h.series.hv, connectNulls: false, lineStyle: { color: colors.info, width: 2 },
      markLine: iv == null ? undefined : { symbol: "none", label: { formatter: `ATM IV ${iv.toFixed(2)}%`, color: colors.brass }, lineStyle: { color: colors.brass, type: "dashed" }, data: [{ yAxis: iv }] },
    }],
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ivhv-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">NIFTY 50 daily closes through {h.as_of ?? MISSING} ({h.bars} bars){h.days_behind != null && h.days_behind > 3 ? ` · ${h.days_behind} days old` : ""} · implied volatility: {iv == null ? MISSING : `ATM ${iv.toFixed(2)}%`}{vol?.as_of ? ` at ${fmtTimeIST(vol.as_of)} IST` : ""}</div>
        {ivNote && <p className="mt-1 text-xs text-warn" data-testid="ivhv-iv-note">{ivNote}</p>}
        <table className="mt-2 w-full max-w-[40rem] text-xs" data-testid="ivhv-table">
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
        <p className="mt-2 text-[11px] text-muted">Historical volatility = standard deviation of daily log returns × √252, in percent, from final daily closes. Implied volatility is the at-the-money value of the Black-76 model for the chosen expiry; the two use different time bases, so read the gap as context (options priced rich or cheap against what the index has actually done), not as a signal.</p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">20-day historical volatility, last {dates.length} sessions</h2>
        <div style={{ height: 300 }}><EChart option={option} ariaLabel="20-day historical volatility with the current at-the-money implied volatility" /></div>
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
    grid: { left: 48, right: 16, top: 24, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: s.points.map((p) => fmtTimeIST(p.at)), axisLabel: { color: colors.muted } },
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
        <p className="mt-2 text-[11px] text-muted">{s.model}; assumed rate {s.rate_assumed == null ? MISSING : `${(s.rate_assumed * 100).toFixed(2)}%`}. Computed from the stored option-chain snapshots, the same way as the command center's IV. A change in IV is context, not a prediction.</p>
      </div>
    </div>
  );
}
