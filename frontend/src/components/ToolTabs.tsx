import { Link, useLocation } from "react-router-dom";
import { TOOLS, toolPath } from "../lib/tools";

/** The tools of the section you are in (same menu and heading), as tabs above the page, so a section is browsed without going back to the menu. */
export function ToolTabs() {
  const { pathname } = useLocation();
  const here = TOOLS.find((t) => toolPath(t) === pathname);
  if (!here) return null;
  const siblings = TOOLS.filter((t) => t.menu === here.menu && t.group === here.group);
  if (siblings.length < 2) return null;
  return (
    <nav aria-label={here.group} className="mx-auto mb-3 flex max-w-[1700px] flex-wrap gap-1 rounded-[var(--radius-panel)] border border-rule bg-slate p-1">
      {siblings.map((t) => {
        const to = toolPath(t);
        const on = t.id === here.id;
        const cls = `inline-flex min-h-9 items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm ${on ? "bg-brass/15 text-paper" : to ? "text-muted hover:text-paper" : "cursor-not-allowed text-muted/50"}`;
        return to ? (
          <Link key={t.id} to={to} aria-current={on ? "page" : undefined} className={cls}>{t.label}</Link>
        ) : (
          <span key={t.id} className={cls} title={`Planned, not built yet. ${t.needs ?? ""}`}>{t.label}</span>
        );
      })}
    </nav>
  );
}
