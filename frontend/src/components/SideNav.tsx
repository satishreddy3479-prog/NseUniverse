import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";

export const NAV: { to: string; label: string; short: string; planned?: string }[] = [
  { to: "/", label: "Overview", short: "O" },
  { to: "/option-chain", label: "Live option chain", short: "L" },
  { to: "/expiry-comparison", label: "Expiry comparison", short: "E", planned: "Checkpoint 3" },
  { to: "/analysis", label: "Analysis", short: "A" },
  { to: "/prediction", label: "Prediction", short: "P" },
  { to: "/data", label: "Data & sessions", short: "D" },
  { to: "/diagnostics", label: "Connection diagnostics", short: "C" },
  { to: "/settings", label: "Settings", short: "S" },
];

// Stroke icons (24x24), one per destination.
const ICONS: Record<string, string> = {
  "/": "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  "/option-chain": "M4 6h16M4 12h16M4 18h16M9 6v12M15 6v12",
  "/expiry-comparison": "M7 4v16M17 4v16M3 8h8M13 16h8",
  "/analysis": "M4 20V10M10 20V4M16 20v-8M22 20H2",
  "/prediction": "M12 3l2.2 5.3L20 9l-4.3 3.8L17 19l-5-3-5 3 1.3-6.2L4 9l5.8-.7z",
  "/data": "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  "/diagnostics": "M2 12h4l3-8 4 16 3-8h6",
  "/settings": "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3.9a7 7 0 00-2-1.2L14 3h-4l-.6 2.5a7 7 0 00-2 1.2l-2.3-.9-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-.9a7 7 0 002 1.2L10 21h4l.6-2.5a7 7 0 002-1.2l2.3.9 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z",
};

// One colour per destination so the rail reads at a glance.
const TINT: Record<string, string> = {
  "/": "var(--info)", "/option-chain": "var(--up)", "/expiry-comparison": "var(--warn)", "/analysis": "var(--brass)",
  "/prediction": "var(--accent)", "/data": "var(--info)", "/diagnostics": "var(--down)", "/settings": "var(--muted)",
};

const PIN_KEY = "nse.nav.pinned";

function loadPinned(): boolean {
  try { return localStorage.getItem(PIN_KEY) === "1"; } catch { return false; }
}

/** Link list shared by the desktop rail and the mobile drop-down. */
export function NavLinks({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === "/"}
          onClick={onNavigate}
          title={compact ? n.label : undefined}
          className={({ isActive }) =>
            `flex min-h-10 items-center gap-3 rounded-sm border-l-2 px-2.5 text-sm ${
              isActive
                ? "border-brass bg-slate-2 font-medium text-paper"
                : "border-transparent text-muted hover:bg-slate-2 hover:text-paper"
            }`
          }
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-sm" style={{ color: TINT[n.to], background: `color-mix(in srgb, ${TINT[n.to]} 18%, transparent)` }}>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[n.to]} /></svg>
          </span>
          <span className={`min-w-0 flex-1 truncate ${compact ? "sr-only" : ""}`}>{n.label}</span>
          {n.planned && !compact && <span className="text-[11px] text-muted">Planned</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** Desktop menu: a thin rail that opens over the page on hover, touch or keyboard focus, and closes
 *  after a choice, so the page keeps its full width. "Keep open" pins it beside the page. */
export function SideNav() {
  const [pinned, setPinned] = useState(loadPinned);
  const [open, setOpen] = useState(false);
  const [suppressed, setSuppressed] = useState(false); // after a choice, stay closed until the pointer leaves
  useEffect(() => {
    try { localStorage.setItem(PIN_KEY, pinned ? "1" : "0"); } catch { /* not saved */ }
  }, [pinned]);

  const expanded = pinned || (open && !suppressed);
  const enter = () => { if (!suppressed) setOpen(true); };
  const leave = () => { setOpen(false); setSuppressed(false); };

  return (
    <aside
      aria-label="Menu"
      data-expanded={expanded}
      className={`relative hidden shrink-0 border-r border-rule bg-slate md:block ${pinned ? "w-56" : "w-14"}`}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onFocus={enter}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <div
        className={`${pinned ? "" : "absolute inset-y-0 left-0 z-30"} flex flex-col overflow-hidden border-rule bg-slate transition-[width] duration-150 ${
          expanded ? "w-56" : "w-14"
        } ${expanded && !pinned ? "border-r shadow-xl" : ""}`}
      >
        <NavLinks
          compact={!expanded}
          onNavigate={() => {
            setSuppressed(true);
            setOpen(false);
            (document.activeElement as HTMLElement | null)?.blur?.();
          }}
        />
        <button
          type="button"
          aria-pressed={pinned}
          onClick={() => setPinned((p) => !p)}
          title={pinned ? "Let the menu collapse after each choice" : "Keep the menu open beside the page"}
          className="mx-2 mt-auto mb-2 flex min-h-9 items-center gap-3 rounded-sm px-2.5 text-xs text-muted hover:bg-slate-2 hover:text-paper"
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center">{pinned ? "◀" : "▶"}</span>
          <span className={expanded ? "" : "sr-only"}>{pinned ? "Collapse menu" : "Keep menu open"}</span>
        </button>
      </div>
    </aside>
  );
}
