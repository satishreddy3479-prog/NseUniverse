import { useState } from "react";
import { Outlet } from "react-router-dom";
import { useLiveConnection } from "../lib/useLive";
import { useSignals } from "../lib/useSignals";
import { NavLinks, SideNav } from "./SideNav";
import { SpotBadge } from "./SpotBadge";
import { StatusPill } from "./StatusPill";

export { NAV } from "./SideNav";

/** Top bar keeps only what matters at a glance: the product, the NIFTY level and one status.
 *  Everything else (full signal list, expiries, last update, refresh, theme) is in Settings. */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  useLiveConnection();
  const { signals, latest, underlying } = useSignals();

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-14 items-center gap-3 border-b border-rule bg-slate px-3">
        <button
          type="button"
          className="rounded-sm border border-rule px-2 py-1 text-sm md:hidden"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Menu
        </button>
        <div className="flex shrink-0 flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-paper">NSE Universe</span>
          <span className="text-xs text-muted">{underlying} 50 options</span>
        </div>
        <SpotBadge latest={latest} />
        <div className="ml-auto">
          <StatusPill signals={signals} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <SideNav />
        {menuOpen && (
          <div id="mobile-nav" className="fixed inset-x-0 top-14 z-20 border-b border-rule bg-slate md:hidden">
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
