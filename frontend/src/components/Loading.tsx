const BARS = [38, 55, 44, 70, 52, 80, 62, 48, 74, 58, 84, 66, 50, 60];

/**
 * The one loading state of the product. It always says in words what is loading (the label), is announced to screen readers (role="status"), and shows motion that
 * means "working", not decoration: a spinner for a line of text, a shimmering skeleton of a panel (heading, tiles, a chart of rising bars) for a block.
 * Motion is switched off by the global prefers-reduced-motion rule, leaving the static skeleton and the label.
 */
export function Loading({ label = "Loading…", variant = "block", className = "" }: { label?: string; variant?: "block" | "inline"; className?: string }) {
  if (variant === "inline") {
    return (
      <div role="status" className={`flex items-center gap-2 text-sm text-muted ${className}`}>
        <span aria-hidden className="spinner" />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className={`loading-block rounded-[var(--radius-panel)] border border-rule bg-slate p-3 ${className}`}>
      <div aria-hidden className="space-y-3">
        <span className="skeleton block h-3.5 w-40 max-w-[55%]" />
        <div className="grid grid-cols-3 gap-2">
          <span className="skeleton block h-10" />
          <span className="skeleton block h-10" />
          <span className="skeleton block h-10" />
        </div>
        <div className="loading-bars">
          {BARS.map((h, i) => <i key={i} style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }} />)}
        </div>
      </div>
      <p className="mt-2 flex items-center gap-2 text-xs text-muted"><span aria-hidden className="spinner" />{label}</p>
    </div>
  );
}
