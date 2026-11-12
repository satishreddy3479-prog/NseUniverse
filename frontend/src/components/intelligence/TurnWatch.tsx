import { MISSING } from "../../lib/format";
import type { Intelligence, TurnChange } from "../../lib/intelligence";

const ROWS: [string, string][] = [["score", "Fused score"], ["positioning", "Positioning (OI levels)"], ["orderflow", "Order flow"], ["structure", "Structure"], ["participation", "Participation"], ["volatility", "Volatility"]];
const sgn = (v: number | null | undefined, d = 0) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || Math.abs(v) < 5 ? "text-muted" : v > 0 ? "text-up" : "text-down");
const LEAN: Record<string, { label: string; cls: string }> = {
  bearish: { label: "Turning down", cls: "border-down/50 bg-down/10 text-down" }, bullish: { label: "Turning up", cls: "border-up/50 bg-up/10 text-up" },
  mixed: { label: "Mixed signals", cls: "border-warn/50 bg-warn/10 text-warn" }, none: { label: "No turn signal", cls: "border-rule bg-slate-2 text-muted" },
};

/** What changed in the last 20 minutes: the engines compared with their own reading 20 minutes ago. The fused score is a level; this shows the direction it is moving. */
export function TurnWatchPanel({ d }: { d: Intelligence }) {
  const t = d.turn_watch;
  if (!t) return <section aria-label="Turn watch" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="tw-panel">Turn watch: not available in this reading.</section>;
  if (!t.available) return <section aria-label="Turn watch" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="tw-panel"><b className="text-paper">Turn watch</b> · {t.reason ?? "not available yet"}. It compares each engine with its own reading 20 minutes earlier.</section>;
  const lean = LEAN[t.lean ?? "none"]!;
  const ch = (k: string) => (t.changes[k] as TurnChange | undefined) ?? null;
  const spot = ch("spot");
  return (
    <section aria-label="Turn watch" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="tw-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-paper">Turn watch <span className="font-normal text-muted">· what changed in the last 20 minutes</span></h2>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${lean.cls}`} data-testid="tw-lean">{lean.label}</span>
      </div>
      <p className="mt-0.5 text-[13px] leading-snug text-muted">The score above is a level; it can stay positive while flow turns. This compares each engine with its own reading 20 minutes ago, so a slow turn shows before the label changes. It describes evidence, not a forecast.</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div data-testid="tw-signals">
          {t.signals.length === 0 ? <p className="rounded-md bg-slate-2 px-3 py-2 text-sm text-muted">No sustained change right now: no flow turn, no score slide.</p> : (
            <ul className="space-y-2">{t.signals.map((s) => (
              <li key={s.id} className={`rounded-md border px-3 py-2 text-sm ${s.direction === "bearish" ? "border-down/40 bg-down/5" : "border-up/40 bg-up/5"}`} data-testid={`tw-sig-${s.id}`}>
                <div className="flex flex-wrap items-center gap-2"><b className="text-paper">{s.title}</b>{s.early && <span className="rounded-full bg-brass/20 px-2 py-0.5 text-[11px] text-brass" title="NIFTY has moved less than 0.15% over the same 20 minutes">price has not confirmed yet</span>}</div>
                {s.evidence.map((e) => <p key={e} className="text-[13px] leading-snug text-muted">{e}</p>)}
                <p className="text-[12px] leading-snug text-muted">Ends when: {s.invalidation}.</p>
              </li>))}
            </ul>)}
        </div>
        <div>
          <table className="w-full text-sm" data-testid="tw-changes"><caption className="sr-only">Change over the last 20 minutes</caption>
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Reading</th><th className="py-1 text-right font-normal">Now</th><th className="py-1 text-right font-normal">Change in 20 min</th></tr></thead>
            <tbody>{ROWS.map(([k, label]) => { const r = ch(k); return (
              <tr key={k} className="border-t border-rule/60"><td className="py-1 text-paper">{label}</td><td className="num py-1 text-right">{sgn(r?.now)}</td><td className={`num py-1 text-right font-medium ${tone(r?.change)}`}>{sgn(r?.change)}</td></tr>); })}
              <tr className="border-t border-rule/60"><td className="py-1 text-paper">NIFTY</td><td className="num py-1 text-right">{spot?.now == null ? MISSING : spot.now.toFixed(0)}</td><td className="num py-1 text-right text-muted">{spot?.change_pct == null ? MISSING : `${sgn(spot.change_pct, 2)}%`}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      {t.note && <p className="mt-2 text-[11px] leading-snug text-muted">{t.note} {t.persistence ? `A signal shows only when ${t.persistence}.` : ""} Thresholds are provisional: tuned on the two stored sessions (11 and 12 Nov 2026), so false alarms are expected and a longer record is needed before trusting them.</p>}
    </section>
  );
}
