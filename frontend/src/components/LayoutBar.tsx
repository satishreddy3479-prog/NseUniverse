import type { ViewLayout } from "../lib/viewLayout";

/** Save layout and Reset for a page's view (see ``useViewLayout``). Save is amber while the view differs from the saved one; Reset returns to the standard view and forgets the saved one. */
export function LayoutBar({ layout, className = "" }: { layout: ViewLayout; className?: string }) {
  const { dirty, saved, resettable, save, reset } = layout;
  return (
    <div role="group" aria-label="Layout" className={`flex items-center gap-0.5 ${className}`} data-testid="layout-bar">
      <button type="button" onClick={save} disabled={!dirty} data-testid="layout-save"
        title={dirty ? "Save this view: what is chosen on this page and the graphs switched off come back the next time" : saved ? "This view is saved" : "The view is the standard one"}
        className={`widget-nodrag min-h-8 rounded-sm border px-2 text-xs disabled:opacity-60 ${dirty ? "border-warn bg-warn/20 font-semibold text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{dirty ? "Save layout ●" : saved ? "Layout saved ✓" : "Save layout"}</button>
      <button type="button" onClick={reset} disabled={!resettable} data-testid="layout-reset"
        title="Back to the standard view of this page, and forget the saved layout"
        className="widget-nodrag min-h-8 rounded-sm border border-rule bg-slate-2 px-2 text-xs text-muted hover:text-paper disabled:opacity-40">Reset</button>
    </div>
  );
}
