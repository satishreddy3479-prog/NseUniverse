import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { useRecentTools } from "../lib/recentTools";
import { TOOLS, toolPath, type MenuId, type Tool } from "../lib/tools";

export function ToolItem({ t, onPick, big }: { t: Tool; onPick: () => void; big?: boolean }) {
  const to = toolPath(t);
  const size = big ? "min-h-11 text-[15px]" : "min-h-9 text-sm";
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{t.label}</span>
      {t.status === "planned" && <span className="rounded-sm border border-rule px-1 text-[10px] text-muted">Planned</span>}
    </>
  );
  if (!to) return <span className={`flex ${size} cursor-not-allowed items-center gap-2 rounded-sm px-2 text-muted/70`} title={t.needs} aria-disabled="true">{body}</span>;
  return (
    <NavLink to={to} onClick={onPick} className={({ isActive }) => `flex ${size} items-center gap-2 rounded-sm px-2 hover:bg-slate-2 ${isActive ? "bg-slate-2 font-medium text-paper" : "text-paper/90"}`}>
      {body}
    </NavLink>
  );
}

/** The tools of one menu as a single list in alphabetical order, with the three most recently used on top and a filter box.
 *  No groups: the same list works as a wide drop-down (the list flows down columns) and on a phone (one column). */
export function ToolMenu({ menu, onPick, phone }: { menu: MenuId; onPick: () => void; phone?: boolean }) {
  const [q, setQ] = useState("");
  const recent = useRecentTools(3);
  const all = useMemo(() => TOOLS.filter((t) => t.menu === menu).sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base", numeric: true })), [menu]);
  const needle = q.trim().toLowerCase();
  const list = needle ? all.filter((t) => `${t.label} ${t.blurb}`.toLowerCase().includes(needle)) : all;
  return (
    <div className="min-w-0" data-testid={`toolmenu-${menu}`}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a tool (${all.length})`} aria-label="Find a tool"
        className={`mb-2 w-full rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper ${phone ? "min-h-11" : "min-h-9"}`} />
      {!needle && recent.length > 0 && (
        <div className="mb-2 border-b border-rule pb-2" data-testid="recent-tools">
          <div className="mb-0.5 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">Recently used</div>
          <div className={phone ? "" : "grid gap-x-4 sm:grid-cols-3"}>
            {recent.map((t) => <ToolItem key={t.id} t={t} onPick={onPick} big={phone} />)}
          </div>
        </div>
      )}
      {!needle && <div className="mb-0.5 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">All tools · A to Z</div>}
      {list.length === 0 ? <p className="px-2 py-2 text-sm text-muted">No tool matches “{q}”.</p> : (
        <ul className={phone ? "" : "gap-x-4 sm:columns-2 lg:columns-3"}>
          {list.map((t) => <li key={t.id} className="break-inside-avoid"><ToolItem t={t} onPick={onPick} big={phone} /></li>)}
        </ul>
      )}
    </div>
  );
}
