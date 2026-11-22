import { MISSING } from "../../lib/format";
import { Loading } from "../Loading";
import { num, PRESET_LABELS, PRESET_ORDER, type RiskPresets, rupees, type ScenarioParams, type ScenarioResult, STICKY_RULES, type StickyRule, volPct } from "../../lib/risk";

export const ZERO_SCENARIO = (rule: StickyRule): ScenarioParams => ({ spot_shock: 0, iv_shock: 0, time_elapsed_hours: 0, sticky_rule: rule, rate_shock: 0 });
const input = "min-h-9 w-full rounded-sm border border-rule bg-slate-2 px-1.5 text-sm text-paper";
const tone = (v: number | null) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-paper");
const sameScenario = (a: ScenarioParams, b: ScenarioParams) =>
  Math.abs(a.spot_shock - b.spot_shock) < 1e-6 && a.iv_shock === b.iv_shock && Math.abs(a.time_elapsed_hours - b.time_elapsed_hours) < 1e-6 && a.sticky_rule === b.sticky_rule && a.rate_shock === b.rate_shock;

/** The scenario controls (spot, volatility, time, sticky rule, rate), the preset buttons with their P&L, and the result of the scenario in rupees in total and by leg. */
export function ScenarioPanel({ scenario, onChange, presets, result, defaultRule, busy, error }: {
  scenario: ScenarioParams;
  onChange: (s: ScenarioParams) => void;
  presets: RiskPresets | undefined;
  result: ScenarioResult | undefined;
  defaultRule: StickyRule;
  busy: boolean;
  error: string | null;
}) {
  const set = (patch: Partial<ScenarioParams>) => onChange({ ...scenario, ...patch });
  const rule = STICKY_RULES.find((r) => r.id === scenario.sticky_rule)!;
  return (
    <section aria-label="What-if scenario" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-scenario">
      <h2 className="text-sm font-semibold text-paper">What if…</h2>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Scenario presets" data-testid="risk-presets">
        {PRESET_ORDER.filter((k) => presets?.presets[k]).map((k) => {
          const p = presets!.presets[k]!;
          const active = sameScenario(scenario, p.scenario);
          return (
            <button key={k} type="button" aria-pressed={active} onClick={() => onChange(p.scenario)} data-testid={`risk-preset-${k}`}
              className={`min-h-9 rounded-sm border px-2.5 text-xs ${active ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`}>
              {PRESET_LABELS[k] ?? k} <span className={`num ${tone(p.pnl)}`}>{rupees(p.pnl)}</span>
            </button>
          );
        })}
        <button type="button" onClick={() => onChange(ZERO_SCENARIO(defaultRule))} className="min-h-9 rounded-sm border border-rule bg-slate px-2.5 text-xs text-muted hover:text-paper" data-testid="risk-reset">Reset</button>
      </div>
      {presets == null && <p className="mt-1 text-[11px] text-muted">Presets appear once the surface is ready.</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs text-muted">Spot move (points)<input className={input} type="number" inputMode="decimal" step={25} value={scenario.spot_shock} onChange={(e) => set({ spot_shock: Number(e.target.value) || 0 })} data-testid="risk-spot" /></label>
        <label className="text-xs text-muted">Volatility move (vol points)<input className={input} type="number" inputMode="decimal" step={0.5} value={scenario.iv_shock} onChange={(e) => set({ iv_shock: Number(e.target.value) || 0 })} data-testid="risk-iv" /></label>
        <label className="text-xs text-muted">Time passing (hours)<input className={input} type="number" inputMode="decimal" min={0} step={1} value={scenario.time_elapsed_hours} onChange={(e) => set({ time_elapsed_hours: Math.max(0, Number(e.target.value) || 0) })} data-testid="risk-hours" /></label>
        <label className="text-xs text-muted">Rate move (percentage points)<input className={input} type="number" inputMode="decimal" step={0.25} value={+(scenario.rate_shock * 100).toFixed(4)} onChange={(e) => set({ rate_shock: (Number(e.target.value) || 0) / 100 })} data-testid="risk-rate" /></label>
        <label className="text-xs text-muted">Volatility follows<select className={input} value={scenario.sticky_rule} onChange={(e) => set({ sticky_rule: e.target.value as StickyRule })} data-testid="risk-rule">
          {STICKY_RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select></label>
      </div>
      <p className="mt-1 text-[11px] text-muted" data-testid="risk-rule-hint">{rule.hint}</p>
      <div className="mt-3 border-t border-rule/60 pt-3" aria-live="polite" data-testid="risk-result">
        {error ? (
          <p role="alert" className="text-sm text-down">{error}</p>
        ) : result == null ? (
          busy ? <Loading variant="inline" label="Calculating…" /> : <p className="text-sm text-muted">Add legs to see what a scenario would do to them.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-muted">Change in the position's value</span>
              <span className={`num text-2xl font-semibold ${tone(result.pnl)}`} data-testid="risk-total">{rupees(result.pnl)}</span>
              {result.pnl == null && result.partial_pnl != null && <span className="text-xs text-muted">legs that could be valued: <span className="num">{rupees(result.partial_pnl)}</span></span>}
            </div>
            <p className="text-[11px] text-muted">Theoretical value now against the scenario, from the fitted surface. Not a forecast, and not your P&L since entry.</p>
            {result.warnings.length > 0 && <ul className="mt-1 list-disc pl-4 text-xs text-warn" data-testid="risk-warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs" data-testid="risk-leg-results">
                <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Leg</th><th className="font-normal">Volatility</th><th className="font-normal">Value per unit</th><th className="text-right font-normal">Change (₹)</th><th className="text-right font-normal">Against entry (₹)</th></tr></thead>
                <tbody>
                  {result.legs.map((l, i) => (
                    <tr key={i} className="border-t border-rule/50">
                      <td className="py-1">{l.expiry.slice(5)} · {l.strike.toLocaleString("en-IN")} {l.cp > 0 ? "CE" : "PE"} · {l.quantity < 0 ? "Sell" : "Buy"} {Math.abs(l.quantity)}{l.status !== "ok" && <span className="ml-1 text-warn">({l.status})</span>}</td>
                      <td className="num">{volPct(l.base_iv)} → {volPct(l.new_iv)}</td>
                      <td className="num">{num(l.base_value)} → {num(l.new_value)}</td>
                      <td className={`num text-right ${tone(l.pnl)}`}>{rupees(l.pnl)}</td>
                      <td className={`num text-right ${tone(l.pnl_vs_entry)}`}>{l.pnl_vs_entry == null ? MISSING : rupees(l.pnl_vs_entry)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
