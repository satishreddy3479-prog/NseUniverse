import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { DEFAULT_DECAY, type DecayCalibration, type DecayOdds as Odds, type DecayParams } from "../../lib/decayProbability";
import { MISSING } from "../../lib/format";

const STOPS = [null, 15, 20, 30, 50];
const TARGETS = [null, 10, 20, 30];
const EXITS = ["13:00", "14:00", "15:00", "15:15"];
const sg = (v: number | null | undefined, d = 0) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-paper");
const lot = (pts: number) => `₹${Math.abs(Math.round(pts * 65)).toLocaleString("en-IN")} a lot`;

function Pick<T extends string | number | null>({ label, value, options, onChange, fmt }: { label: string; value: T; options: T[]; onChange: (v: T) => void; fmt: (v: T) => string }) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-muted">{label}
      <select aria-label={label} value={String(value)} onChange={(e) => onChange((options.find((o) => String(o) === e.target.value) ?? value) as T)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper">
        {options.map((o) => <option key={String(o)} value={String(o)}>{fmt(o)}</option>)}
      </select>
    </label>
  );
}

function Tile({ label, value, sub, testid, cls }: { label: string; value: string; sub?: string; testid: string; cls?: string }) {
  return <div className="rounded-sm border border-rule/60 bg-slate-2 px-2 py-1.5" data-testid={testid}><div className="text-[11px] text-muted">{label}</div><div className={`num text-sm font-semibold ${cls ?? "text-paper"}`}>{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>;
}

/** How often the model's probability was right on the recorded days, for the band the live probability falls in. */
function Reliability({ cal, p }: { cal: DecayCalibration | undefined; p: number }) {
  if (!cal) return null;
  if (cal.status === "computing") return <p className="mt-2 text-[11px] text-muted" data-testid="decay-cal-computing">Checking the model against the recorded days ({cal.days_loaded} loaded)…</p>;
  const s = cal.scales["1"];
  if (!s || !s.entries) return <p className="mt-2 text-[11px] text-muted" data-testid="decay-cal-none">The model has not been checked against recorded days yet.</p>;
  const band = s.reliability?.find((b) => p >= b.from && p < (b.to >= 1 ? 1.0001 : b.to));
  return (
    <div className="mt-2 text-[11px] text-muted" data-testid="decay-cal">
      <p data-testid="decay-cal-band">{band && band.entries > 0 && band.actual != null && band.predicted != null
        ? `On the recorded days, when the model said ${pct(band.from)}–${pct(band.to)} (it averaged ${pct(band.predicted)}), the sale paid ${pct(band.actual)} of the time (${band.entries} entries over ${band.days} days).`
        : "No recorded entry fell in this probability band."}</p>
      <p data-testid="decay-cal-score">Over all {s.entries} entries on {s.days} days the model {s.beats_base_rate ? "beat" : "did not beat"} simply quoting the base rate (Brier {s.brier?.toFixed(3)} against {s.brier_base_rate?.toFixed(3)}); on average it predicted {sg(s.mean_predicted_pnl, 1)} points and the straddle made {sg(s.mean_actual_pnl, 1)}. {cal.note}</p>
    </div>
  );
}

/** The model's odds that selling the at-the-money straddle now pays, with the typical and the bad outcome and the odds of a stop or a target. A model probability checked against the recorded days, not a forecast. */
export function DecayOddsCard() {
  const [p, setP] = useState<DecayParams>(DEFAULT_DECAY);
  const q = useQuery({ queryKey: ["decay-odds", p], queryFn: () => api.decayProbability(p), refetchInterval: 30_000, retry: false, placeholderData: keepPreviousData });
  const cal = useQuery({ queryKey: ["decay-cal"], queryFn: api.decayCalibration, refetchInterval: (c) => (c.state.data?.status === "ready" ? 600_000 : 15_000), retry: false });
  const shell = (body: React.ReactNode) => (
    <section aria-label="Decay odds" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="decay-odds">
      <h2 className="text-sm font-semibold text-paper">Decay odds <span className="font-normal text-muted">· will selling the at-the-money straddle now pay?</span></h2>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:max-w-md" data-testid="decay-controls">
        <Pick label="Stop (premium up)" value={p.stop} options={STOPS} onChange={(v) => setP({ ...p, stop: v })} fmt={(v) => (v == null ? "None" : `+${v}%`)} />
        <Pick label="Target (premium down)" value={p.target} options={TARGETS} onChange={(v) => setP({ ...p, target: v })} fmt={(v) => (v == null ? "None" : `−${v}%`)} />
        <Pick label="Exit at" value={p.exit} options={EXITS} onChange={(v) => setP({ ...p, exit: v })} fmt={(v) => v} />
      </div>
      {body}
    </section>
  );
  if (q.isPending) return <div className="h-24 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="decay-loading" />;
  if (q.isError || !q.data || typeof q.data.available !== "boolean") return shell(<p role="alert" className="mt-2 text-xs text-down" data-testid="decay-error">The decay odds could not be loaded.</p>);
  const d = q.data;
  if (!d.available) return shell(<p className="mt-2 text-xs text-muted" data-testid="decay-unavailable">Not available: {d.reason}.{d.as_of ? ` The newest stored chain is ${d.age_minutes != null ? `${Math.round(d.age_minutes)} minutes old` : "from an earlier session"}.` : ""}</p>);
  const o: Odds = d;
  return shell(
    <>
      <p className="mt-2 text-[11px] text-muted" data-testid="decay-asof">Strike {o.strike}, premium {o.premium.toFixed(1)} points, implied volatility {o.implied_vol_pct.toFixed(1)}%. Sold on the chain stored {Math.round(o.age_minutes)} minutes ago{o.stale ? " (stale: the numbers describe that chain)" : ""}, left at {o.exit}; net of {o.cost} points.</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile testid="decay-p" label="Pays at the exit" value={pct(o.p_profit)} sub="ends below the premium sold" cls={o.p_profit >= 0.5 ? "text-up" : "text-down"} />
        <Tile testid="decay-typical" label="Typical day (median)" value={`${sg(o.quantiles.p50, 1)} pts`} sub={`${lot(o.quantiles.p50)}${o.quantiles.p50 < 0 ? " lost" : ""}`} cls={tone(o.quantiles.p50)} />
        <Tile testid="decay-bad" label="One day in twenty" value={`${sg(o.quantiles.p5, 0)} pts or worse`} sub={lot(o.quantiles.p5)} cls={tone(o.quantiles.p5)} />
        <Tile testid="decay-be" label="Break-evens" value={`${o.breakeven.down.toFixed(0)} · ${o.breakeven.up.toFixed(0)}`} sub={`index touches one in ${pct(o.p_touch_breakeven)} of paths`} />
        <Tile testid="decay-move" label="Expected move to the exit" value={`±${o.expected_move_pts.toFixed(0)} pts`} sub="one standard deviation" />
        {(o.stop_pct != null || o.target_pct != null)
          ? <Tile testid="decay-rule" label="Stop / target / exit" value={`${pct(o.p_stop)} · ${pct(o.p_target)} · ${pct(o.p_exit_time)}`} sub={`expected ${sg(o.mean, 1)} points`} />
          : <Tile testid="decay-rule" label="Expected result" value={`${sg(o.mean, 1)} pts`} sub={lot(o.mean)} cls={tone(o.mean)} />}
      </div>
      <ul className="mt-2 list-disc pl-4 text-[11px] text-muted" data-testid="decay-lines">{o.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      <Reliability cal={cal.data} p={o.p_profit} />
      <p className="mt-2 text-[11px] text-muted" data-testid="decay-caution">A model probability, not a forecast: the volatility is the market's own, constant, with no jumps or events, and the premium is a last traded price. Stops are checked every 10 minutes and booked at their level.</p>
    </>,
  );
}
