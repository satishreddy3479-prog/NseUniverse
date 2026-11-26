import { MISSING } from "../../lib/format";
import { Loading } from "../Loading";
import { num, PRESET_LABELS, PRESET_ORDER, type RiskPresets, rupees, type ScenarioParams, type ScenarioResult, STICKY_RULES, type StickyRule, volPct } from "../../lib/risk";

export const ZERO_SCENARIO = (rule: StickyRule): ScenarioParams => ({ spot_shock: 0, iv_shock: 0, time_elapsed_hours: 0, sticky_rule: rule, rate_shock: 0 });
const input = "min-h-9 w-full rounded-sm border border-rule bg-slate-2 px-1.5 text-sm text-paper";

/**
 * One scenario value as a slider with a readout and exact step buttons (a slider alone is hard to set precisely on a phone). The slider covers ``base`` either side of the starting point; a value
 * beyond it (a preset such as a 2 sigma move) widens the track just enough to hold it, and the track does not change while the thumb is dragged inside it.
 */
function SliderField({ label, value, onChange, unit, step, base, min, signed = true, testid, digits = 0 }: {
  label: string; value: number; onChange: (v: number) => void; unit: string; step: number; base: number; min?: number; signed?: boolean; testid: string; digits?: number;
}) {
  const lo = min ?? -Math.max(base, Math.ceil((Math.abs(Math.min(0, value)) * 1.2) / step) * step);
  const hi = Math.max(base, Math.ceil((Math.max(0, value) * 1.2) / step) * step);
  const clamp = (v: number) => Math.min(hi, Math.max(lo, +v.toFixed(4)));
  const text = `${signed && value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)} ${unit}`;
  const stepBtn = "inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-rule bg-slate-2 text-base text-paper hover:border-brass disabled:opacity-40";
  return (
    <div className="text-xs text-muted" data-testid={`${testid}-field`}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={testid}>{label}</label>
        <output htmlFor={testid} className={`num text-sm font-medium ${signed ? tone(value) : "text-paper"}`} data-testid={`${testid}-value`}>{text}</output>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <button type="button" className={stepBtn} aria-label={`${label}: one step down`} disabled={value <= lo} onClick={() => onChange(clamp(value - step))}>−</button>
        <input id={testid} type="range" min={lo} max={hi} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid}
          className="h-9 min-w-0 flex-1 cursor-pointer accent-[var(--brass)]" />
        <button type="button" className={stepBtn} aria-label={`${label}: one step up`} disabled={value >= hi} onClick={() => onChange(clamp(value + step))}>＋</button>
      </div>
    </div>
  );
}

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
      <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <SliderField label="Spot move (points)" unit="pts" step={5} base={1000} value={scenario.spot_shock} onChange={(v) => set({ spot_shock: v })} testid="risk-spot" />
        <SliderField label="Volatility move (vol points)" unit="vol pts" step={0.5} base={15} digits={1} value={scenario.iv_shock} onChange={(v) => set({ iv_shock: v })} testid="risk-iv" />
        <SliderField label="Time passing (hours)" unit="h" step={1} base={72} min={0} signed={false} value={scenario.time_elapsed_hours} onChange={(v) => set({ time_elapsed_hours: Math.max(0, v) })} testid="risk-hours" />
        <SliderField label="Rate move (percentage points)" unit="pp" step={0.25} base={2} digits={2} value={+(scenario.rate_shock * 100).toFixed(4)} onChange={(v) => set({ rate_shock: v / 100 })} testid="risk-rate" />
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
