import { MISSING } from "../../lib/format";
import { signed, toneOf, type VolDetail, type VolBucket } from "../../lib/intelligence";

const n = (v: number | null | undefined, d = 2) => (v == null ? MISSING : v.toFixed(d));
const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const VERDICT_TONE: Record<string, string> = { BULLISH: "text-up", BEARISH: "text-down", CONFLICTING: "text-warn", NEUTRAL: "text-muted", UNAVAILABLE: "text-warn" };

function Row({ label, b }: { label: string; b: VolBucket }) {
  return (
    <tr className="border-t border-rule/50" data-testid={`vol-row-${label}`}>
      <td className="py-1 text-paper">{label}</td>
      <td className="num py-1 text-right">{n(b.ce_iv)}</td><td className="num py-1 text-right">{n(b.pe_iv)}</td>
      <td className="num py-1 text-right">{sg(b.ce_change)}</td><td className="num py-1 text-right">{sg(b.pe_change)}</td>
      <td className="num py-1 text-right">{sg(b.risk_reversal)}</td><td className="num py-1 text-right">{sg(b.rr_previous_session)}</td>
      <td className="num py-1 text-right">{sg(b.skew)}</td><td className="num py-1 text-right">{sg(b.rr_change)}</td>
    </tr>
  );
}

/** The volatility group in full: separate call and put readings, risk reversal now and at the previous close, each component's contribution,
 *  the evidence for and against, and an interpretation that never reads expansion or contraction as a direction on its own. */
export function VolatilityEvidence({ det }: { det: VolDetail | undefined }) {
  if (!det) return <p className="text-muted" data-testid="vol-none">The volatility evidence is not available.</p>;
  return (
    <div className="mt-3 space-y-3 border-t border-rule pt-3" data-testid="vol-evidence">
      <p className="text-sm"><span className="text-muted">Volatility evidence: </span><span className={`font-semibold ${VERDICT_TONE[det.verdict] ?? ""}`} data-testid="vol-verdict">{det.verdict}</span>{det.total != null && <span className={`num ml-2 ${toneOf(det.total)}`}>score {signed(det.total)}</span>}<span className="ml-2 text-[11px] text-muted">scoring mode: {det.scoring.mode}</span></p>
      <p className="text-xs text-paper" data-testid="vol-explanation">{det.explanation}</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-xs" data-testid="vol-table">
        <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">{det.window} window</th><th className="py-1 text-right font-normal">CE IV</th><th className="py-1 text-right font-normal">PE IV</th><th className="py-1 text-right font-normal">CE IV chg</th><th className="py-1 text-right font-normal">PE IV chg</th><th className="py-1 text-right font-normal" title="CE IV − PE IV">Risk reversal</th><th className="py-1 text-right font-normal">RR prev. close</th><th className="py-1 text-right font-normal" title="PE IV − CE IV = −risk reversal">Skew</th><th className="py-1 text-right font-normal">RR change</th></tr></thead>
        <tbody><Row label="ATM" b={det.atm} /><Row label="25Δ" b={det.d25} /><Row label="10Δ" b={det.d10} /></tbody></table></div>
      <p className="text-[11px] text-muted">25Δ: {det.d25.mechanism ?? "mechanism unavailable"}. 10Δ: {det.d10.mechanism ?? "unavailable"}. ATM IV moves independently of the skew: ATM {det.atm.movement ?? MISSING} ({sg(det.atm.avg_change)} pts) while the 25Δ risk reversal moved {sg(det.d25.rr_change)}.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs" data-testid="vol-components">
        <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Component</th><th className="py-1 text-right font-normal">Score</th><th className="py-1 text-right font-normal">Contribution to the group</th><th className="py-1 pl-3 font-normal">Reading</th></tr></thead>
        <tbody>{det.components.map((c) => <tr key={c.key} className="border-t border-rule/50 align-top"><td className="py-1 text-paper">{c.name}</td><td className={`num py-1 text-right ${toneOf(c.score)}`}>{c.score == null ? MISSING : signed(c.score)}</td><td className={`num py-1 text-right ${toneOf(c.contribution)}`}>{c.contribution == null ? MISSING : signed(c.contribution, 1)}</td><td className="py-1 pl-3 text-muted">{c.reading ?? "unavailable"}</td></tr>)}</tbody></table></div>
      <div className="grid gap-2 text-xs sm:grid-cols-3" data-testid="vol-evidence-lists">
        <div><p className="text-up">Bullish evidence</p><ul className="list-disc pl-4 text-muted">{det.evidence.bullish.length ? det.evidence.bullish.map((x) => <li key={x}>{x}</li>) : <li>none</li>}</ul></div>
        <div><p className="text-down">Bearish evidence</p><ul className="list-disc pl-4 text-muted">{det.evidence.bearish.length ? det.evidence.bearish.map((x) => <li key={x}>{x}</li>) : <li>none</li>}</ul></div>
        <div><p className="text-warn">Conflicting</p><ul className="list-disc pl-4 text-muted">{det.evidence.conflicting.length ? det.evidence.conflicting.map((x) => <li key={x}>{x}</li>) : <li>none</li>}</ul></div>
      </div>
      <ul className="space-y-1 text-xs" data-testid="vol-interpretation">{det.interpretation.map((i) => <li key={i.id}><span className="text-paper">{i.title}:</span> <span className="text-muted">{i.reading}</span></li>)}</ul>
      {det.not_scored.length > 0 && <ul className="list-disc pl-4 text-[11px] text-muted">{det.not_scored.map((x) => <li key={x}>{x}</li>)}</ul>}
      <p className="text-[11px] text-muted" data-testid="vol-sign">Sign convention: {det.sign_convention}.{det.sign_consistent ? "" : " The stored table broke this identity; its numbers should not be trusted."} Expansion or contraction of implied volatility is a statement about the level of risk, not about direction.</p>
    </div>
  );
}
