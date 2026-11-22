import { useState } from "react";
import { EChart, useChartColors } from "../EChart";
import { Loading } from "../Loading";
import { type RiskSurface, volPct, versionLabel } from "../../lib/risk";
import { residualOption, smileOption } from "../../lib/riskCharts";

/** The implied-volatility surface, one expiry at a time: the smile with its SVI fit, the residuals, the fit quality and arbitrage checks, and every quote that was rejected or flagged with its reason. */
export function SurfaceViewer({ surface, busy, error }: { surface: RiskSurface | undefined; busy: boolean; error: string | null }) {
  const colors = useChartColors();
  const [pick, setPick] = useState<string | null>(null);
  if (error) return <section aria-label="Volatility surface" className="rounded-xl border border-rule bg-ink/40 p-3"><h2 className="text-sm font-semibold text-paper">Volatility surface</h2><p role="alert" className="mt-2 text-sm text-down">{error}</p></section>;
  if (!surface) return <section aria-label="Volatility surface" className="rounded-xl border border-rule bg-ink/40 p-3"><h2 className="text-sm font-semibold text-paper">Volatility surface</h2>{busy ? <Loading variant="inline" label="Building the surface…" className="mt-2" /> : <p className="mt-2 text-sm text-muted">No surface yet.</p>}</section>;
  const expiry = pick && surface.slices.some((s) => s.expiry === pick) ? pick : surface.slices[0]?.expiry ?? null;
  const slice = surface.slices.find((s) => s.expiry === expiry);
  const strikes = surface.strikes.filter((x) => x.expiry === expiry);
  const problems = strikes.filter((x) => x.status === "rejected" || x.status === "flagged");
  const dataRow = surface.data.find((d) => d.expiry === expiry);
  return (
    <section aria-label="Volatility surface" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-surface">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Volatility surface <span className="font-normal text-muted">· {surface.source === "live" ? "live books where available" : "stored chain"}, surface {versionLabel(surface.surface_version_id)}</span></h2>
        <div role="tablist" aria-label="Expiry" className="flex gap-1">
          {surface.slices.map((s) => (
            <button key={s.expiry} role="tab" type="button" aria-selected={s.expiry === expiry} onClick={() => setPick(s.expiry)} data-testid={`risk-expiry-${s.expiry}`}
              className={`min-h-9 rounded-sm border px-2.5 text-xs ${s.expiry === expiry ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`}>
              {s.expiry}{s.degraded && <span className="ml-1 text-warn" title={s.degraded_reason ?? "model degraded"}>⚠</span>}
            </button>
          ))}
        </div>
      </div>
      {slice && (
        <>
          {slice.degraded && <p className="mt-2 rounded-sm border border-warn/50 bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="risk-degraded">Model degraded: {slice.degraded_reason}. {slice.params == null ? "No smile could be fitted, so Greeks and scenarios for this expiry are unavailable." : "Treat the fitted volatilities with care."}</p>}
          {surface.stale && dataRow?.stale && <p className="mt-2 text-xs text-warn" data-testid="risk-surface-stale">The stored chain is {Math.round((dataRow.age_s ?? 0) / 60)} minutes old: prices are from the last capture, not the live market.</p>}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div><dt className="text-muted">Forward</dt><dd className="num">{slice.forward == null ? "—" : slice.forward.toFixed(2)} <span className="text-muted">({slice.forward_source})</span></dd></div>
            <div><dt className="text-muted">Quotes used / rejected / flagged</dt><dd className="num" data-testid="risk-counts">{slice.n_used} / {slice.n_rejected} / {slice.n_flagged}</dd></div>
            <div><dt className="text-muted">Fit residual (RMS, largest)</dt><dd className="num">{slice.rms_vol_pts == null ? "—" : `${slice.rms_vol_pts.toFixed(3)}`} , {slice.max_vol_pts == null ? "—" : `${slice.max_vol_pts.toFixed(3)}`} vol pts</dd></div>
            <div><dt className="text-muted">No-arbitrage</dt><dd data-testid="risk-arb">{slice.params == null ? "—" : `butterfly ${slice.butterfly_ok ? "ok" : "violated"}, calendar ${slice.calendar_ok ? "ok" : "violated"}`}</dd></div>
            <div><dt className="text-muted">ATM volatility (fit)</dt><dd className="num">{volPct(strikes.filter((x) => x.fit_iv != null).sort((a, b) => Math.abs(a.strike - (slice.forward ?? 0)) - Math.abs(b.strike - (slice.forward ?? 0)))[0]?.fit_iv)}</dd></div>
            <div><dt className="text-muted">Quotes priced from a live book</dt><dd className="num">{dataRow?.live_books ?? 0} of {dataRow?.quotes ?? 0}</dd></div>
            <div><dt className="text-muted">Lot size</dt><dd className="num">{dataRow?.lot_size ?? "—"}</dd></div>
            <div><dt className="text-muted">Expires</dt><dd className="num">{dataRow?.expiry_instant_ist ? dataRow.expiry_instant_ist.slice(0, 16).replace("T", " ") + " IST" : "—"}</dd></div>
          </dl>
          <p className="mt-2 text-[11px] text-muted">Implied volatility (%) by strike: the fitted smile and the market quotes behind it.</p>
          <div className="h-[300px]" data-testid="risk-smile"><EChart option={smileOption(strikes, slice.forward, colors)} ariaLabel={`Implied volatility smile for ${slice.expiry}`} /></div>
          <div className="h-[170px]" data-testid="risk-residuals"><EChart option={residualOption(strikes, surface.config.degraded_rms_vol_pts, colors)} ariaLabel={`Fit residuals for ${slice.expiry}`} /></div>
          {problems.length > 0 && (
            <details className="mt-2 rounded-sm border border-rule/60 bg-slate-2" data-testid="risk-problems">
              <summary className="cursor-pointer px-2.5 py-1.5 text-xs">{problems.length} quote{problems.length === 1 ? "" : "s"} not used in the fit</summary>
              <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="px-2.5 py-1 font-normal">Strike</th><th className="font-normal">Side</th><th className="font-normal">Status</th><th className="font-normal">Reason</th></tr></thead>
                <tbody>{problems.map((x, i) => <tr key={i} className="border-t border-rule/50"><td className="num px-2.5 py-1">{x.strike.toLocaleString("en-IN")}</td><td>{x.cp > 0 ? "CE" : "PE"}</td><td className={x.status === "flagged" ? "text-down" : "text-muted"}>{x.status}</td><td>{x.reason}</td></tr>)}</tbody></table></div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
