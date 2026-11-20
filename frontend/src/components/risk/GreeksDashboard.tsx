import { useState } from "react";
import { MISSING } from "../../lib/format";
import { type Breach, type Greeks, num, type Num, type PortfolioRisk, rupees, versionLabel } from "../../lib/risk";

type Unit = "rupee" | "raw";

/** Names, units and decimals of each Greek in rupee terms and in raw model units (per year, per 1.00 of volatility). */
const ROWS: { key: string; label: string; rupee: string; raw: string; rawKey?: string; d: number }[] = [
  { key: "delta", label: "Delta", rupee: "₹ per index point", raw: "units of the index", d: 2 },
  { key: "gamma", label: "Gamma", rupee: "₹ per point, per point", raw: "units per point", d: 4 },
  { key: "vega", label: "Vega", rupee: "₹ per volatility point", raw: "₹ per 1.00 of volatility", d: 0 },
  { key: "theta_day", label: "Theta (per day)", rupee: "₹ per calendar day", raw: "₹ per year", rawKey: "theta", d: 0 },
  { key: "theta_hour", label: "Theta (per hour)", rupee: "₹ per calendar hour", raw: "—", d: 1 },
  { key: "theta_trading_hour", label: "Theta (per trading hour)", rupee: "₹ per session hour", raw: "—", d: 1 },
  { key: "rho", label: "Rho", rupee: "₹ per 1% of rate", raw: "₹ per 1.00 of rate", d: 1 },
  { key: "vanna", label: "Vanna", rupee: "delta (₹/pt) per vol point", raw: "per 1.00 of volatility", d: 2 },
  { key: "charm", label: "Charm", rupee: "delta (₹/pt) per day", raw: "per year", d: 2 },
  { key: "vomma", label: "Vomma", rupee: "vega (₹) per vol point", raw: "per 1.00², volatility", d: 1 },
  { key: "veta", label: "Veta", rupee: "vega (₹) per day", raw: "per year", d: 1 },
  { key: "speed", label: "Speed", rupee: "gamma per point", raw: "per point", d: 6 },
  { key: "color", label: "Color", rupee: "gamma per day", raw: "per year", d: 4 },
  { key: "zomma", label: "Zomma", rupee: "gamma per vol point", raw: "per 1.00 of volatility", d: 5 },
  { key: "ultima", label: "Ultima", rupee: "vomma per vol point", raw: "per 1.00³, volatility", d: 2 },
];
const tone = (v: Num | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-paper");
const metricLabel: Record<string, string> = { delta: "delta", gamma: "gamma", vega: "vega", theta_day: "decay paid per day", quantity: "lots", beta_weighted_delta: "beta-weighted delta" };

function value(g: Greeks, key: string, unit: Unit, d: number, rawKey?: string): string {
  const v = g[unit === "raw" && rawKey ? rawKey : key];
  if (v == null) return MISSING;
  return key.startsWith("theta") || key === "vega" || key === "rho" || key === "delta" ? (unit === "rupee" ? rupees(v) : num(v, d, true)) : num(v, d, true);
}

function BreachRow({ b }: { b: Breach }) {
  return (
    <li className={`flex flex-wrap items-baseline gap-x-2 rounded-sm border px-2 py-1 text-xs ${b.level === "breach" ? "border-down bg-down/10" : "border-brass bg-brass/10"}`} data-testid="risk-breach" data-level={b.level}>
      <span className={`font-semibold ${b.level === "breach" ? "text-down" : "text-brass"}`}>{b.level === "breach" ? "Over limit" : "Near limit"}</span>
      <span>{b.scope === "portfolio" ? "Portfolio" : b.scope === "bucket" ? `Expiry ${b.scope_id}` : `Leg ${b.scope_id}`} · {metricLabel[b.metric] ?? b.metric}</span>
      <span className="num text-muted">{num(b.value, b.metric === "quantity" ? 0 : 1, true)} of {num(b.limit, b.metric === "quantity" ? 0 : 1)} ({Math.round(b.utilisation * 100)}%)</span>
      {b.partial && <span className="text-muted">· on the legs that could be valued</span>}
    </li>
  );
}

/** Net Greeks in rupees (or raw units), by expiry bucket and by leg (each collapsible), the beta-weighted delta and the configured limits with their flags. */
export function GreeksDashboard({ risk, version, asOf, busy, error }: { risk: PortfolioRisk | undefined; version: string | null; asOf: string; busy: boolean; error: string | null }) {
  const [unit, setUnit] = useState<Unit>("rupee");
  const [more, setMore] = useState(false);
  return (
    <section aria-label="Greeks" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-greeks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Greeks of the position <span className="font-normal text-muted" data-testid="risk-greeks-stamp">· {asOf}, surface {versionLabel(version)}</span></h2>
        <div role="group" aria-label="Units" className="flex gap-1">
          {([["rupee", "Rupees"], ["raw", "Raw units"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={unit === k} onClick={() => setUnit(k)} data-testid={`risk-unit-${k}`} className={`min-h-9 rounded-sm border px-2.5 text-xs ${unit === k ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`}>{label}</button>
          ))}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-down">{error}</p> : risk == null ? (
        <p className="mt-2 text-sm text-muted">{busy ? "Calculating…" : "Add legs to see their Greeks."}</p>
      ) : (
        <>
          {!risk.complete && <p className="mt-2 rounded-sm border border-warn/50 bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="risk-incomplete">Totals are unavailable because some legs could not be valued ({risk.warnings.join("; ")}). The figures shown are for the legs that could be valued.</p>}
          {risk.breaches.length > 0 && <ul className="mt-2 space-y-1" aria-label="Limits" data-testid="risk-breaches">{risk.breaches.map((b, i) => <BreachRow key={i} b={b} />)}</ul>}
          <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="risk-net">
            {(["delta", "gamma", "vega", "theta_day"] as const).map((k) => {
              const row = ROWS.find((r) => r.key === k)!;
              const g = risk.complete ? risk.net : risk.partial_net;
              const v = (unit === "raw" && row.rawKey ? g.raw[row.rawKey] : unit === "raw" ? g.raw[k] : g.rupee[k]) ?? null;
              return (
                <div key={k} className="rounded-sm border border-rule/60 bg-slate-2 px-2.5 py-2" data-testid={`risk-net-${k}`}>
                  <dt className="text-[11px] text-muted">{row.label} <span className="text-[10px]">· {unit === "rupee" ? row.rupee : row.raw}</span></dt>
                  <dd className={`num mt-0.5 text-lg font-semibold ${tone(v)}`}>{unit === "rupee" && k !== "gamma" ? rupees(v) : num(v, row.d, true)}</dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-2 text-xs text-muted" data-testid="risk-beta">
            Beta-weighted delta to NIFTY: <span className={`num ${tone(risk.beta_weighted_delta_rupees)}`}>{rupees(risk.beta_weighted_delta_rupees)} per point</span> (beta {num(risk.beta, 2)}, {risk.beta_source}).
            A 1% move in the index is about <span className={`num ${tone(risk.delta_rupees_per_1pct)}`}>{rupees(risk.delta_rupees_per_1pct)}</span> on the delta alone.
          </p>
          <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="mt-2 min-h-9 text-xs font-semibold text-info hover:underline" data-testid="risk-more-greeks">{more ? "Hide the other Greeks" : "Show all Greeks (second and third order)"}</button>
          {more && (
            <div className="mt-1 overflow-x-auto">
              <table className="w-full min-w-[30rem] text-xs" data-testid="risk-all-greeks">
                <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Greek</th><th className="text-right font-normal">Position</th><th className="pl-3 font-normal">Unit</th></tr></thead>
                <tbody>{ROWS.map((r) => {
                  const g = risk.complete ? risk.net : risk.partial_net;
                  return <tr key={r.key} className="border-t border-rule/50"><td className="py-1">{r.label}</td><td className="num text-right">{value(unit === "rupee" ? g.rupee : g.raw, r.key, unit, r.d, r.rawKey)}</td><td className="pl-3 text-muted">{unit === "rupee" ? r.rupee : r.raw}</td></tr>;
                })}</tbody>
              </table>
            </div>
          )}
          <h3 className="mt-3 text-xs font-semibold text-paper">By expiry</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs" data-testid="risk-buckets">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Expiry</th><th className="font-normal">Legs</th><th className="font-normal">Time left</th><th className="text-right font-normal">Delta (₹/pt)</th><th className="text-right font-normal">Vega (₹/vol)</th><th className="text-right font-normal">Theta (₹/day)</th></tr></thead>
              <tbody>{risk.buckets.map((b) => (
                <tr key={b.expiry} className="border-t border-rule/50" data-testid="risk-bucket"><td className="py-1">{b.expiry} <span className="text-muted">({b.label})</span></td><td>{b.n_legs}</td><td className="num">{b.hours_to_expiry < 48 ? `${b.hours_to_expiry.toFixed(1)} h` : `${(b.hours_to_expiry / 24).toFixed(1)} d`}</td>
                  <td className={`num text-right ${tone(b.net.rupee.delta)}`}>{rupees(b.net.rupee.delta)}</td><td className={`num text-right ${tone(b.net.rupee.vega)}`}>{rupees(b.net.rupee.vega)}</td><td className={`num text-right ${tone(b.net.rupee.theta_day)}`}>{rupees(b.net.rupee.theta_day)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <h3 className="mt-3 text-xs font-semibold text-paper">By leg</h3>
          <div className="mt-1 space-y-1" data-testid="risk-legs-greeks">
            {risk.legs.map((l, i) => (
              <details key={i} className="rounded-sm border border-rule/60 bg-slate-2" data-testid="risk-leg-details">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 px-2.5 py-1.5 text-xs">
                  <span className="font-medium text-paper">{l.expiry.slice(5)} · {l.strike.toLocaleString("en-IN")} {l.cp > 0 ? "CE" : "PE"} · {l.quantity < 0 ? "Sell" : "Buy"} {Math.abs(l.quantity)} × {l.lot_size}</span>
                  {l.status !== "ok" ? <span className="text-warn">{l.status}</span> : <><span className={`num ${tone(l.rupee.delta)}`}>Δ {rupees(l.rupee.delta)}</span><span className={`num ${tone(l.rupee.vega)}`}>ν {rupees(l.rupee.vega)}</span><span className={`num ${tone(l.rupee.theta_day)}`}>Θ {rupees(l.rupee.theta_day)}/day</span></>}
                </summary>
                {l.status === "ok" && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule/50 px-2.5 py-2 text-xs sm:grid-cols-3">
                    <div><dt className="text-muted">Volatility used</dt><dd className="num">{l.iv == null ? MISSING : `${(l.iv * 100).toFixed(2)}%`}</dd></div>
                    <div><dt className="text-muted">Model value per unit</dt><dd className="num">{num(l.value)}</dd></div>
                    <div><dt className="text-muted">Time to expiry</dt><dd className="num">{l.t_years == null ? MISSING : `${(l.t_years * 365).toFixed(2)} days`}</dd></div>
                    {ROWS.filter((r) => r.key !== "theta_hour" && r.key !== "theta_trading_hour").map((r) => (
                      <div key={r.key}><dt className="text-muted">{r.label}</dt><dd className={`num ${tone(l.rupee[r.key])}`}>{["delta", "vega", "theta_day", "rho"].includes(r.key) ? rupees(l.rupee[r.key]) : num(l.rupee[r.key], r.d, true)}</dd></div>
                    ))}
                    {l.intrinsic && <p className="col-span-full text-muted">Priced at intrinsic value (at or past expiry).</p>}
                    {!l.third_order_ok && <p className="col-span-full text-muted">Third-order Greeks are not available for this leg.</p>}
                  </dl>
                )}
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
