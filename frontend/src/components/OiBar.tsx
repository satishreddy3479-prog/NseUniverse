import { compactIN } from "../lib/analytics";

/**
 * One side's open interest at a strike: the number above a bar on a faint track. The bar grows away from the strike column (calls toward the left, puts toward the
 * right) and its length is the share of the largest OI on that side in the strikes shown, so the bars of one column compare. The strike holding the most OI on the
 * side (the wall) is drawn solid and marked. A missing OI is a dash and an empty track, never a bar of zero length that looks like "no open interest".
 */
export function OiBar({ value, max, color, side, wall, label }: { value: number | null; max: number; color: string; side: "call" | "put"; wall?: boolean; label?: string }) {
  const pct = value == null || max <= 0 ? 0 : value <= 0 ? 0 : Math.max(3, Math.min(100, (value / max) * 100));
  const right = side === "call"; // calls are the left column: their bars sit against the strike on the right
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${right ? "items-end" : "items-start"}`} data-testid={`oibar-${side}`} data-wall={wall ? "true" : undefined}>
      <span className={`num text-[11px] leading-none ${value == null ? "text-muted" : wall ? "font-semibold text-paper" : "text-muted"}`}>{value == null ? "—" : compactIN(value)}{wall ? " ▪" : ""}</span>
      <div className={`flex h-1.5 w-full overflow-hidden rounded-full bg-rule/40 ${right ? "justify-end" : ""}`} role="img" aria-label={label ?? (value == null ? "no open interest stored" : `Open interest ${compactIN(value)}`)} title={value == null ? "no OI" : `OI ${compactIN(value)}${wall ? " · the most on this side" : ""}`}>
        {pct > 0 && <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color, opacity: wall ? 1 : 0.8 }} />}
      </div>
    </div>
  );
}
