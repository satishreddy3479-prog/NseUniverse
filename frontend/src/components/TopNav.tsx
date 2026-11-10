import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { MENU_ORDER, MENU_TITLES, menuGroups, toolPath, type MenuId, type Tool } from "../lib/tools";

/** Top-level links; the tool menus open as drop-downs between them. */
const LEFT: { to: string; label: string }[] = [
  { to: "/market-intelligence", label: "Market Intelligence" },
  { to: "/swing", label: "Swing trading" },
];
const RIGHT: { to: string; label: string }[] = [
  { to: "/prediction", label: "Prediction" },
];
export const STRATEGY: { to: string; label: string }[] = [
  { to: "/strategy", label: "Strategy builder" },
  { to: "/portfolio", label: "Strategy portfolio" },
];
export const SYSTEM: { to: string; label: string }[] = [
  { to: "/overview", label: "Platform status" },
  { to: "/data", label: "Data & sessions" },
  { to: "/server", label: "Server Management Centre" },
  { to: "/diagnostics", label: "Connection diagnostics" },
  { to: "/settings", label: "Settings" },
];

const link = (active: boolean) =>
  `inline-flex min-h-10 items-center whitespace-nowrap border-b-2 px-2 text-[13px] xl:px-2.5 xl:text-sm ${active ? "border-brass font-medium text-paper" : "border-transparent text-muted hover:text-paper"}`;

function ToolItem({ t, onPick }: { t: Tool; onPick: () => void }) {
  const to = toolPath(t);
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{t.label}</span>
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
        <div id={`menu-${id}`} className={`absolute left-0 top-full z-40 max-h-[78vh] overflow-y-auto rounded-[var(--radius-panel)] border border-rule bg-slate p-3 shadow-xl ${wide ? "w-[min(62rem,92vw)]" : "w-72"}`}>
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
      <Dropdown id="strategy" label="Strategy Builder" open={open === "strategy"} setOpen={set("strategy")}>
        {STRATEGY.map((n) => (
          <NavLink key={n.to} to={n.to} onClick={() => setOpen(null)} className={({ isActive }) => `flex min-h-9 items-center rounded-sm px-2 text-sm hover:bg-slate-2 ${isActive ? "bg-slate-2 font-medium text-paper" : "text-paper/90"}`}>{n.label}</NavLink>
        ))}
      </Dropdown>
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

const row = (active: boolean) => `flex min-h-11 items-center rounded-sm px-3 text-[15px] ${active ? "bg-slate-2 font-medium text-paper" : "text-paper/90"}`;

function Section({ id, title, open, setOpen, children }: { id: string; title: string; open: boolean; setOpen: (o: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-rule/60">
      <button type="button" aria-expanded={open} aria-controls={`m-${id}`} onClick={() => setOpen(!open)}
        className="flex min-h-12 w-full items-center justify-between px-3 text-left text-[15px] font-medium text-paper">
        {title}<span aria-hidden className={`text-xs text-muted transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && <div id={`m-${id}`} className="pb-2">{children}</div>}
    </div>
  );
}

/** Phone menu. Plain destinations are one tap; the sections (Strategy Builder, FNO Tools, Analyse, System) open to show their tools,
 *  one section at a time, and the tool groups inside FNO Tools and Analyse open the same way. */
export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  const [sec, setSec] = useState<string | null>(null);
  const [grp, setGrp] = useState<string | null>(null);
  const loc = useLocation();
  const toggle = (id: string) => (o: boolean) => { setSec(o ? id : null); setGrp(null); };
  const direct = (n: { to: string; label: string }, end = false) => (
    <NavLink key={n.to} to={n.to} end={end} onClick={onNavigate} className={({ isActive }) => `${row(isActive)} border-t border-rule/60 font-medium`}>{n.label}</NavLink>
  );
  return (
    <nav aria-label="Main" className="max-h-[80vh] overflow-y-auto pb-2" data-path={loc.pathname}>
      {direct({ to: "/", label: "Home · all tools" }, true)}
      {LEFT.map((n) => direct(n))}
      <Section id="strategy" title="Strategy Builder" open={sec === "strategy"} setOpen={toggle("strategy")}>
        {STRATEGY.map((n) => <NavLink key={n.to} to={n.to} onClick={onNavigate} className={({ isActive }) => `${row(isActive)} pl-6`}>{n.label}</NavLink>)}
      </Section>
      {MENU_ORDER.map((m) => (
        <Section key={m} id={m} title={MENU_TITLES[m]} open={sec === m} setOpen={toggle(m)}>
          {menuGroups(m).map((g) => {
            const key = `${m}:${g.group}`;
            const on = grp === key;
            return (
              <div key={key}>
                <button type="button" aria-expanded={on} onClick={() => setGrp(on ? null : key)} className="flex min-h-10 w-full items-center justify-between px-3 pl-6 text-left text-xs font-medium uppercase tracking-wide text-muted">
                  <span>{g.group} <span className="font-normal normal-case">· {g.tools.length}</span></span><span aria-hidden>{on ? "−" : "+"}</span>
                </button>
                {on && <div className="pb-1 pl-4">{g.tools.map((t) => <ToolItem key={t.id} t={t} onPick={onNavigate} />)}</div>}
              </div>
            );
          })}
        </Section>
      ))}
      {RIGHT.map((n) => direct(n))}
      <Section id="system" title="System" open={sec === "system"} setOpen={toggle("system")}>
        {SYSTEM.map((n) => <NavLink key={n.to} to={n.to} onClick={onNavigate} className={({ isActive }) => `${row(isActive)} pl-6`}>{n.label}</NavLink>)}
      </Section>
    </nav>
  );
}
