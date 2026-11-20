import type { RiskLeg } from "../../lib/risk";

const cell = "min-h-9 w-full rounded-sm border border-rule bg-slate-2 px-1.5 text-sm text-paper";

/** The position the page analyses: the Strategy Builder's legs, or legs typed here. Lot size comes from the chain, so it is not entered. */
export function LegsEditor({ legs, onChange, expiries, maxLegs, builderCount, onUseBuilder }: {
  legs: RiskLeg[];
  onChange: (legs: RiskLeg[]) => void;
  expiries: string[];
  maxLegs: number;
  builderCount: number;
  onUseBuilder: () => void;
}) {
  const set = (i: number, patch: Partial<RiskLeg>) => onChange(legs.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const add = () => onChange([...legs, { expiry: expiries[0] ?? "", strike: legs[legs.length - 1]?.strike ?? 25500, type: "CE", action: "SELL", lots: 1, entry_price: null }]);
  return (
    <section aria-label="Position" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="risk-legs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Position <span className="font-normal text-muted">· {legs.length} leg{legs.length === 1 ? "" : "s"}</span></h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onUseBuilder} disabled={builderCount === 0} className="min-h-9 rounded-sm border border-rule bg-slate px-2.5 text-xs text-paper hover:border-brass disabled:opacity-50" data-testid="risk-use-builder">
            Use my Strategy Builder legs ({builderCount})
          </button>
          <button type="button" onClick={add} disabled={legs.length >= maxLegs || expiries.length === 0} className="min-h-9 rounded-sm border border-rule bg-slate px-2.5 text-xs text-paper hover:border-brass disabled:opacity-50" data-testid="risk-add-leg">Add a leg</button>
          <button type="button" onClick={() => onChange([])} disabled={legs.length === 0} className="min-h-9 rounded-sm border border-rule bg-slate px-2.5 text-xs text-muted hover:text-paper disabled:opacity-50">Clear</button>
        </div>
      </div>
      {legs.length === 0 ? (
        <p className="mt-2 text-sm text-muted" data-testid="risk-no-legs">No legs yet. Use your Strategy Builder legs, or add legs here. The numbers on this page are for the legs you enter; nothing is placed or sent to a broker.</p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label="Legs">
          {legs.map((l, i) => (
            <li key={i} className="grid grid-cols-2 items-end gap-2 rounded-sm border border-rule/60 bg-slate-2 p-2 sm:grid-cols-[1.4fr_1fr_0.8fr_0.8fr_0.7fr_1fr_auto]" data-testid="risk-leg-row">
              <label className="col-span-2 text-[11px] text-muted sm:col-span-1">Expiry
                <select aria-label={`Leg ${i + 1} expiry`} className={cell} value={l.expiry} onChange={(e) => set(i, { expiry: e.target.value })}>
                  {!expiries.includes(l.expiry) && <option value={l.expiry}>{l.expiry} (no chain)</option>}
                  {expiries.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-muted">Strike
                <input aria-label={`Leg ${i + 1} strike`} className={cell} type="number" inputMode="decimal" min={1} step={50} value={l.strike} onChange={(e) => set(i, { strike: Number(e.target.value) })} />
              </label>
              <label className="text-[11px] text-muted">Type
                <select aria-label={`Leg ${i + 1} type`} className={cell} value={l.type} onChange={(e) => set(i, { type: e.target.value as "CE" | "PE" })}><option value="CE">Call</option><option value="PE">Put</option></select>
              </label>
              <label className="text-[11px] text-muted">Side
                <select aria-label={`Leg ${i + 1} side`} className={cell} value={l.action} onChange={(e) => set(i, { action: e.target.value as "BUY" | "SELL" })}><option value="BUY">Buy</option><option value="SELL">Sell</option></select>
              </label>
              <label className="text-[11px] text-muted">Lots
                <input aria-label={`Leg ${i + 1} lots`} className={cell} type="number" inputMode="numeric" min={1} step={1} value={l.lots} onChange={(e) => set(i, { lots: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
              </label>
              <label className="text-[11px] text-muted">Entry premium
                <input aria-label={`Leg ${i + 1} entry premium`} className={cell} type="number" inputMode="decimal" min={0} step={0.05} placeholder="optional" value={l.entry_price ?? ""} onChange={(e) => set(i, { entry_price: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
              <button type="button" aria-label={`Remove leg ${i + 1}`} onClick={() => onChange(legs.filter((_, k) => k !== i))} className="col-span-2 grid min-h-9 place-items-center rounded-sm border border-rule bg-slate px-3 text-muted hover:text-paper sm:col-span-1 sm:size-9 sm:px-0"><span aria-hidden>✕</span><span className="text-xs sm:hidden"> Remove</span></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
