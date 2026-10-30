// Small visual primitives for the intraday page: gauges, range bars, diverging bars, split bars, tiles.
// Pure presentation of numbers the caller already has: a missing value draws an empty track, never a zero.
import type { ReactNode } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Half-circle gauge. `zones` colour the arc from min to max; the needle sits at `value` (hidden when null). */
export function Gauge({ value, min, max, zones, label, text, sub }: {
  value: number | null; min: number; max: number; zones: { to: number; color: string }[]; label: string; text: ReactNode; sub?: ReactNode;
}) {
  const R = 52, CX = 64, CY = 62;
  const ang = (v: number) => Math.PI * (1 - (clamp(v, min, max) - min) / (max - min));
  const pt = (v: number, r = R) => `${(CX + r * Math.cos(ang(v))).toFixed(2)} ${(CY - r * Math.sin(ang(v))).toFixed(2)}`;
  let from = min;
  const arcs = zones.map((z) => {
    const d = `M ${pt(from)} A ${R} ${R} 0 0 1 ${pt(z.to)}`;
    from = z.to;
    return <path key={z.to} d={d} stroke={z.color} strokeWidth="9" fill="none" opacity="0.85" />;
  });
  return (
    <div className="flex flex-col items-center" role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-valuetext={value == null ? "not available" : String(value)}>
      <svg viewBox="0 0 128 76" className="w-full max-w-[150px]" aria-hidden="true">
        {arcs}
        {value != null && <><line x1={CX} y1={CY} x2={pt(value, R - 8).split(" ")[0]} y2={pt(value, R - 8).split(" ")[1]} stroke="var(--paper)" strokeWidth="2.5" strokeLinecap="round" /><circle cx={CX} cy={CY} r="4" fill="var(--paper)" /></>}
      </svg>
      <div className="-mt-3 text-center"><div className="num text-lg font-semibold text-paper">{text}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>
    </div>
  );
}

/** Inline bar for a signed value inside a table cell: grows right (up) or left (down) from a centre line. */
export function MiniBar({ value, scale, className = "" }: { value: number | null | undefined; scale: number; className?: string }) {
  const w = value == null || scale <= 0 ? 0 : clamp(Math.abs(value) / scale, 0, 1) * 50;
  return (
    <span aria-hidden="true" className={`relative inline-block h-2 w-20 rounded-sm bg-slate-2 align-middle ${className}`}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-muted/50" />
      {value != null && <span className={`absolute inset-y-0 rounded-sm ${value >= 0 ? "bg-up/80" : "bg-down/80"}`} style={value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />}
    </span>
  );
}

/** Unsigned bar from the left, 0..max. */
export function FillBar({ value, max, color = "bg-info", className = "" }: { value: number | null | undefined; max: number; color?: string; className?: string }) {
  const w = value == null || max <= 0 ? 0 : clamp(value / max, 0, 1) * 100;
  return <span aria-hidden="true" className={`relative inline-block h-2 w-20 overflow-hidden rounded-sm bg-slate-2 align-middle ${className}`}><span className={`absolute inset-y-0 left-0 rounded-sm ${color}`} style={{ width: `${w}%` }} /></span>;
}

/** A price range with markers: the bar spans lo..hi of the data, `low`/`high` are the shaded range, marks are points on it. */
export function RangeBar({ low, high, marks, label }: { low: number | null; high: number | null; marks: { v: number | null; label: string; cls: string }[]; label: string }) {
  const vals = [low, high, ...marks.map((m) => m.v)].filter((x): x is number => x != null);
  if (low == null || high == null || vals.length < 2) return <div className="h-8 rounded-sm bg-slate-2" role="img" aria-label={`${label}: not available`} />;
  const pad = (high - low) * 0.6 || 1, lo = Math.min(...vals) - pad * 0.2, hi = Math.max(...vals) + pad * 0.2;
  const x = (v: number) => `${clamp(((v - lo) / (hi - lo)) * 100, 0, 100)}%`;
  return (
    <div className="relative h-10" role="img" aria-label={label}>
      <div className="absolute inset-x-0 top-5 h-1.5 rounded-sm bg-slate-2" />
      <div className="absolute top-4 h-3.5 rounded-sm border border-info/60 bg-info/20" style={{ left: x(low), width: `calc(${x(high)} - ${x(low)})` }} />
      {marks.filter((m) => m.v != null).map((m) => (
        <div key={m.label} className="absolute top-0 -translate-x-1/2 text-center" style={{ left: x(m.v as number) }}>
          <div className={`whitespace-nowrap text-[10px] font-medium ${m.cls}`}>{m.label}</div>
          <div className={`mx-auto h-5 w-0.5 ${m.cls.replace("text-", "bg-")}`} />
        </div>
      ))}
    </div>
  );
}

/** Two-part proportion bar (for example call versus put, buy versus sell). Null or zero totals draw an empty track. */
export function SplitBar({ a, b, aCls = "bg-up", bCls = "bg-down", label }: { a: number | null; b: number | null; aCls?: string; bCls?: string; label: string }) {
  const t = (a ?? 0) + (b ?? 0);
  if (a == null || b == null || t <= 0) return <div className="h-2.5 rounded-sm bg-slate-2" role="img" aria-label={`${label}: not available`} />;
  return (
    <div className="flex h-2.5 overflow-hidden rounded-sm bg-slate-2" role="img" aria-label={`${label}: ${Math.round((a / t) * 100)}% / ${Math.round((b / t) * 100)}%`}>
      <div className={aCls} style={{ width: `${(a / t) * 100}%` }} /><div className={bCls} style={{ width: `${(b / t) * 100}%` }} />
    </div>
  );
}

/** KPI tile with a coloured left edge. */
export function Tile({ label, value, sub, accent = "border-rule", valueCls = "text-paper", children, title }: {
  label: string; value: ReactNode; sub?: ReactNode; accent?: string; valueCls?: string; children?: ReactNode; title?: string;
}) {
  return (
    <div title={title} className={`min-w-0 rounded-sm border border-rule border-l-2 bg-slate-2/60 px-3 py-2 ${accent}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num truncate text-base font-semibold ${valueCls}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
      {children}
    </div>
  );
}
