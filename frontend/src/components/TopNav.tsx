import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { MENU_ORDER, MENU_TITLES, menuGroups, toolPath, type MenuId, type Tool } from "../lib/tools";

/** Top-level links; the three tool menus open as drop-downs between them. */
const LEFT: { to: string; label: string }[] = [
  { to: "/strategy", label: "Strategy Builder" },
  { to: "/option-chain", label: "Option Chain" },
];
const RIGHT: { to: string; label: string }[] = [
  { to: "/prediction", label: "Prediction" },
];
export const SYSTEM: { to: string; label: string }[] = [
  { to: "/overview", label: "Platform status" },
  { to: "/portfolio", label: "Strategy portfolio" },
  { to: "/data", label: "Data & sessions" },
  { to: "/cleanup", label: "Data clean-up" },
  { to: "/diagnostics", label: "Connection diagnostics" },
  { to: "/settings", label: "Settings" },
];

const link = (active: boolean) =>
  `inline-flex min-h-10 items-center border-b-2 px-3 text-sm ${active ? "border-brass font-medium text-paper" : "border-transparent text-muted hover:text-paper"}`;

function ToolItem({ t, onPick }: { t: Tool; onPick: () => void }) {
  const to = toolPath(t);
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{t.label}</span>
      {t.isNew && t.status === "ready" && <span className="rounded-sm bg-up/20 px-1 text-[10px] font-semibold text-up">NEW</span>}
      {t.status === "planned" && <span className="rounded-sm border border-rule px-1 text-[10px] text-muted">Planned</span>}
    </>
  );
  if (!to) return <span className="flex min-h-9 cursor-not-allowed items-center gap-2 rounded-sm px-2 text-sm text-muted/70" title={t.needs} aria-disabled="true">{body}</span>;
  return (
    <NavLink to={to} onClick={onPick} className={({ isActive }) => `flex min-h-9 items-center gap-2 rounded-sm px-2 text-sm hover:bg-slate-2 ${isActive ? "bg-slate-2 font-medium text-paper" : "text-paper/90"}`}>
      {body}
    </NavLink>
  );
}

function Dropdown({ id, open, setOpen, children, label, wide }: { id: string; open: boolean; setOpen: (o: boolean) => void; children: React.ReactNode; label: string; wide?: boolean }) {
  // A menu opened by hovering stays open when the same pointer clicks the button; only a click-opened menu toggles shut.
  const byHover = useRef(false);
  return (
    <div className="relative" onPointerEnter={(e) => { if (e.pointerType === "mouse") { byHover.current = true; setOpen(true); } }} onPointerLeave={(e) => { if (e.pointerType === "mouse") { byHover.current = false; setOpen(false); } }}>
      <button type="button" className={`${link(open)} gap-1`} aria-expanded={open} aria-haspopup="true" aria-controls={`menu-${id}`}
        onClick={() => { if (byHover.current) { byHover.current = false; setOpen(true); } else setOpen(!open); }}>
        {label}<span aria-hidden className="text-[10px]">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div id={`menu-${id}`} className={`absolute left-0 top-full z-40 rounded-[var(--radius-panel)] border border-rule bg-slate p-3 shadow-xl ${wide ? "w-[min(62rem,92vw)]" : "w-72"}`}>
          {children}
        </div>
      )}
    </div>
  );
}

/** The desktop menu bar. Menus open on hover or click, close with Esc, a click elsewhere or a choice. */
export function TopNav() {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(null), [loc.pathname]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    const down = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); };
  }, []);
  const set = (id: string) => (o: boolean) => setOpen(o ? id : (cur) => (cur === id ? null : cur) as string | null);
  return (
    <nav ref={root} aria-label="Main" className="hidden items-center md:flex">
      {LEFT.map((n) => <NavLink key={n.to} to={n.to} className={({ isActive }) => link(isActive)}>{n.label}</NavLink>)}
      {MENU_ORDER.map((m: MenuId) => (
        <Dropdown key={m} id={m} label={MENU_TITLES[m]} open={open === m} setOpen={set(m)} wide>
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {menuGroups(m).map((g) => (
              <div key={g.group} className="min-w-0">
                <div className="mb-1 border-b border-rule pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{g.group}</div>
                {g.tools.map((t) => <ToolItem key={t.id} t={t} onPick={() => setOpen(null)} />)}
              </div>
            ))}
          </div>
        </Dropdown>
      ))}
      {RIGHT.map((n) => <NavLink key={n.to} to={n.to} className={({ isActive }) => link(isActive)}>{n.label}</NavLink>)}
      <Dropdown id="system" label="System" open={open === "system"} setOpen={set("system")}>
        {SYSTEM.map((n) => (
          <NavLink key={n.to} to={n.to} onClick={() => setOpen(null)} className={({ isActive }) => `flex min-h-9 items-center rounded-sm px-2 text-sm hover:bg-slate-2 ${isActive ? "bg-slate-2 font-medium text-paper" : "text-paper/90"}`}>{n.label}</NavLink>
        ))}
      </Dropdown>
    </nav>
  );
}

/** Phone menu: every destination in one scrolling list, tool groups as headings. */
export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  return (
    <nav aria-label="Main" className="max-h-[75vh] overflow-y-auto p-2">
      {[...LEFT, ...RIGHT].map((n) => (
        <NavLink key={n.to} to={n.to} onClick={onNavigate} className={({ isActive }) => `flex min-h-10 items-center rounded-sm px-2.5 text-sm ${isActive ? "bg-slate-2 font-medium text-paper" : "text-muted"}`}>{n.label}</NavLink>
      ))}
      <NavLink to="/" end onClick={onNavigate} className={({ isActive }) => `flex min-h-10 items-center rounded-sm px-2.5 text-sm ${isActive ? "bg-slate-2 font-medium text-paper" : "text-muted"}`}>All tools</NavLink>
      {MENU_ORDER.map((m) => (
        <details key={m} className="rounded-sm">
          <summary className="flex min-h-10 cursor-pointer items-center px-2.5 text-sm text-paper">{MENU_TITLES[m]}</summary>
          <div className="pb-2 pl-3">
            {menuGroups(m).map((g) => (
              <div key={g.group}>
                <div className="px-2 pt-2 text-[11px] uppercase tracking-wide text-muted">{g.group}</div>
                {g.tools.map((t) => <ToolItem key={t.id} t={t} onPick={onNavigate} />)}
              </div>
            ))}
          </div>
        </details>
      ))}
      <details>
        <summary className="flex min-h-10 cursor-pointer items-center px-2.5 text-sm text-paper">System</summary>
        <div className="pb-2 pl-3">{SYSTEM.map((n) => <NavLink key={n.to} to={n.to} onClick={onNavigate} className="flex min-h-9 items-center px-2 text-sm text-muted">{n.label}</NavLink>)}</div>
      </details>
    </nav>
  );
}
