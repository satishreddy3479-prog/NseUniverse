// Visuals and plain-language reading for the Prediction page. Everything is drawn from numbers the page already has.
import { fmtPct } from "../lib/format";

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const rupee = (close: number, r: number) => `₹${Math.round(close * (1 + r)).toLocaleString("en-IN")}`;
const lab = (m: string) => m.replace("-", " ");
void fmtPct;

export interface ReadingInput {
  horizon: "T1" | "T5";
  model: string;
  p: number; base: number;
  models: { name: string; p: number }[];
  target: string | null;
  call: { call: string | null; reason: string | null } | null;
  close: number;
  q: Record<string, number> | null;
  events: string[];
}

/** The statement under a forecast, written from its own numbers: nothing here is fixed text about the market. */
export function readingLines(i: ReadingInput): string[] {
  const out: string[] = [];
  const diff = (i.p - i.base) * 100;
  const side = diff >= 0 ? "above" : "below";
  const when = i.target ? `a higher close on ${i.target}` : "a higher close";
  let first = `${lab(i.model)} puts the chance of ${when} at ${pct(i.p)}, ${Math.abs(diff).toFixed(1)} points ${side} the historical up-frequency of ${pct(i.base)}.`;
  if (Math.abs(diff) < 3) first += " That is inside the band where it says almost nothing beyond history.";
  else first += diff > 0 ? " That is a lean towards up." : " That is a lean towards down.";
  out.push(first);
  if (i.models.length > 1) {
    const ps = i.models.map((m) => m.p), lo = Math.min(...ps), hi = Math.max(...ps);
    const allUp = ps.every((p) => p > i.base), allDown = ps.every((p) => p < i.base);
    out.push(`The ${i.models.length} models range from ${pct(lo)} to ${pct(hi)}: ${allUp ? "all of them sit above the base rate" : allDown ? "all of them sit below the base rate" : "they fall on both sides of the base rate, so they disagree on direction"}.`);
  }
  if (i.call) out.push(i.call.call === "up" || i.call.call === "down" ? `A confident call was issued: ${i.call.call.toUpperCase()} (${i.call.reason}).` : `No call is made${i.call.reason ? `: ${i.call.reason}` : ""}.`);
  if (i.q && i.q["0.25"] != null && i.q["0.75"] != null && i.q["0.05"] != null && i.q["0.95"] != null) {
    out.push(`From the last 750 ${i.horizon === "T1" ? "1-day" : "5-day"} returns, half of outcomes land between ${rupee(i.close, i.q["0.25"])} and ${rupee(i.close, i.q["0.75"])}, and nine in ten between ${rupee(i.close, i.q["0.05"])} and ${rupee(i.close, i.q["0.95"])}.`);
  }
  if (i.events.length) out.push(`Event risk before the target close: ${i.events.join(", ")}.`);
  return out;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** One dot per model on a probability scale, with the base rate and 50% marked. */
export function ModelDots({ models, base, head }: { models: { name: string; p: number | null }[]; base: number; head: string | undefined }) {
  const have = models.filter((m): m is { name: string; p: number } => m.p != null);
  if (have.length === 0) return null;
  const lo = Math.min(0.35, ...have.map((m) => m.p - 0.04), base - 0.04), hi = Math.max(0.65, ...have.map((m) => m.p + 0.04), base + 0.04);
  const L = 92, W = 300, H = 24 * have.length + 34;
  const x = (v: number) => L + ((clamp(v, lo, hi) - lo) / (hi - lo)) * (W - L - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Each model's probability of closing up against the historical base rate" data-testid="model-dots">
      <line x1={x(0.5)} x2={x(0.5)} y1="6" y2={H - 18} stroke="var(--rule)" strokeDasharray="2 3" />
      <line x1={x(base)} x2={x(base)} y1="6" y2={H - 18} stroke="var(--paper)" strokeWidth="1.5" />
      {have.map((m, i) => (
        <g key={m.name} transform={`translate(0 ${22 + i * 24})`}>
          <text x="0" y="4" fontSize="10" fill={m.name === head ? "var(--paper)" : "var(--muted)"} fontWeight={m.name === head ? 600 : 400}>{lab(m.name)}</text>
          <line x1={L} x2={W - 8} y1="0" y2="0" stroke="var(--rule)" opacity="0.5" />
          <line x1={x(base)} x2={x(m.p)} y1="0" y2="0" stroke={m.p >= base ? "var(--up)" : "var(--down)"} strokeWidth="3" strokeLinecap="round" />
          <circle cx={x(m.p)} cy="0" r={m.name === head ? 5.5 : 4.5} fill={m.p >= base ? "var(--up)" : "var(--down)"} stroke="var(--slate)" strokeWidth="1.5" />
          <text x={x(m.p)} y="-8" fontSize="9.5" textAnchor="middle" fill="var(--paper)">{pct(m.p)}</text>
        </g>
      ))}
      <text x={x(base)} y={H - 6} fontSize="9" textAnchor="middle" fill="var(--paper)">base {pct(base)}</text>
      <text x={x(lo)} y={H - 6} fontSize="9" fill="var(--muted)">{pct(lo, 0)}</text>
      <text x={x(hi)} y={H - 6} fontSize="9" textAnchor="end" fill="var(--muted)">{pct(hi, 0)}</text>
    </svg>
  );
}

/** The historical return ranges drawn as prices around the last close. */
export function ConeBar({ close, q }: { close: number; q: Record<string, number> }) {
  const a = q["0.05"], b = q["0.25"], c = q["0.75"], d = q["0.95"];
  if (a == null || b == null || c == null || d == null) return null;
  const lo = close * (1 + a), hi = close * (1 + d), W = 300, pad = 6;
  const x = (v: number) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const price = (r: number) => Math.round(close * (1 + r)).toLocaleString("en-IN");
  return (
    <svg viewBox={`0 0 ${W} 54`} className="w-full" role="img" aria-label="Historical 50% and 90% ranges around the last close" data-testid="cone-bar">
      <rect x={x(lo)} y="18" width={x(hi) - x(lo)} height="14" rx="3" fill="var(--info)" opacity="0.18" />
      <rect x={x(close * (1 + b))} y="18" width={x(close * (1 + c)) - x(close * (1 + b))} height="14" rx="3" fill="var(--info)" opacity="0.55" />
      <line x1={x(close)} x2={x(close)} y1="10" y2="40" stroke="var(--brass)" strokeWidth="2" />
      <text x={x(close)} y="8" fontSize="9.5" textAnchor="middle" fill="var(--brass)">last close {Math.round(close).toLocaleString("en-IN")}</text>
      <text x={x(lo)} y="50" fontSize="9.5" fill="var(--muted)">{price(a)}</text>
      <text x={x(close * (1 + b))} y="50" fontSize="9.5" textAnchor="middle" fill="var(--paper)">{price(b)}</text>
      <text x={x(close * (1 + c))} y="50" fontSize="9.5" textAnchor="middle" fill="var(--paper)">{price(c)}</text>
      <text x={x(hi)} y="50" fontSize="9.5" textAnchor="end" fill="var(--muted)">{price(d)}</text>
    </svg>
  );
}

/** Holdout gain over the base rate for each model with its 95% interval: right of the line beats the base rate. */
export function GainBars({ rows }: { rows: { name: string; gain: number; lo: number; hi: number; head: boolean }[] }) {
  if (rows.length === 0) return null;
  const m = Math.max(...rows.map((r) => Math.max(Math.abs(r.lo), Math.abs(r.hi), Math.abs(r.gain)))) * 1.15 || 1;
  const L = 96, W = 360, H = 22 * rows.length + 22;
  const x = (v: number) => L + ((v + m) / (2 * m)) * (W - L - 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" role="img" aria-label="Gain over the base rate on the holdout, with 95% intervals" data-testid="gain-bars">
      <line x1={x(0)} x2={x(0)} y1="2" y2={H - 16} stroke="var(--paper)" strokeWidth="1.5" />
      {rows.map((r, i) => {
        const col = r.lo > 0 ? "var(--up)" : r.hi < 0 ? "var(--down)" : "var(--muted)";
        return (
          <g key={r.name} transform={`translate(0 ${12 + i * 22})`}>
            <text x="0" y="4" fontSize="10.5" fill="var(--paper)" fontWeight={r.head ? 600 : 400}>{lab(r.name)}</text>
            <line x1={x(r.lo)} x2={x(r.hi)} y1="0" y2="0" stroke={col} strokeWidth="2" opacity="0.7" />
            <line x1={x(r.lo)} x2={x(r.lo)} y1="-4" y2="4" stroke={col} /><line x1={x(r.hi)} x2={x(r.hi)} y1="-4" y2="4" stroke={col} />
            <circle cx={x(r.gain)} cy="0" r="4.5" fill={col} />
          </g>
        );
      })}
      <text x={x(0)} y={H - 4} fontSize="9" textAnchor="middle" fill="var(--paper)">base rate</text>
      <text x={L} y={H - 4} fontSize="9" fill="var(--muted)">worse</text>
      <text x={W - 10} y={H - 4} fontSize="9" textAnchor="end" fill="var(--muted)">better</text>
    </svg>
  );
}

/** Reliability: when the model said X, how often was it up. Dots on the diagonal are well calibrated. */
export function ReliabilityPlot({ bins }: { bins: { n: number; predicted: number; observed: number }[] }) {
  if (bins.length === 0) return null;
  const S = 170, P = 22, v = (t: number) => P + t * (S - P - 6), y = (t: number) => S - P - t * (S - P - 6) + 6;
  const maxN = Math.max(...bins.map((b) => b.n));
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-44" role="img" aria-label="Reliability on the holdout: said versus observed" data-testid="reliability">
      <rect x={v(0)} y={y(1)} width={v(1) - v(0)} height={y(0) - y(1)} fill="none" stroke="var(--rule)" />
      <line x1={v(0)} y1={y(0)} x2={v(1)} y2={y(1)} stroke="var(--muted)" strokeDasharray="3 3" />
      {bins.map((b) => <circle key={b.predicted} cx={v(clamp(b.predicted, 0, 1))} cy={y(clamp(b.observed, 0, 1))} r={3 + (b.n / maxN) * 5} fill="var(--info)" opacity="0.75"><title>{`said ${pct(b.predicted)}, up ${pct(b.observed)} (${b.n} cases)`}</title></circle>)}
      <text x={S / 2} y={S - 4} fontSize="9" textAnchor="middle" fill="var(--muted)">model said →</text>
      <text x="8" y={S / 2} fontSize="9" fill="var(--muted)" transform={`rotate(-90 8 ${S / 2})`} textAnchor="middle">actually up →</text>
    </svg>
  );
}

/** A hit rate with its 95% interval on a 0–100% track, with the 50% line. */
export function HitInterval({ hit, ci }: { hit: number; ci: [number, number] }) {
  return (
    <svg viewBox="0 0 120 12" className="ml-2 inline-block h-3 w-28 align-middle" aria-hidden="true">
      <rect x="0" y="5" width="120" height="2" rx="1" fill="var(--rule)" />
      <line x1="60" x2="60" y1="1" y2="11" stroke="var(--muted)" />
      <line x1={ci[0] * 120} x2={ci[1] * 120} y1="6" y2="6" stroke={ci[0] > 0.5 ? "var(--up)" : ci[1] < 0.5 ? "var(--down)" : "var(--info)"} strokeWidth="3" />
      <circle cx={hit * 120} cy="6" r="3.5" fill="var(--paper)" />
    </svg>
  );
}
