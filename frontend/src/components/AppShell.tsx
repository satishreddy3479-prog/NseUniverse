import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { api } from "../lib/api";
import { setSessionClock } from "../lib/session";
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
  // The session's open, close and holidays come from the backend, which follows the exchange feed; pages are
  // redrawn once when they differ from the defaults.
  const clock = useQuery({ queryKey: ["market-session"], queryFn: api.marketSession, refetchInterval: 30 * 60_000, staleTime: 10 * 60_000, retry: false });
  if (clock.data) setSessionClock(clock.data);
  const clockKey = clock.data ? `${clock.data.close}|${clock.data.holidays.length}` : "15:40|0";
  const { signals, latest, spotSnapshot, underlying } = useSignals();

  return (
    <div className="flex h-full flex-col">
      <header className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-rule bg-slate px-3 py-1.5 md:flex md:flex-wrap">
        <button
          type="button"
          className="rounded-sm border border-rule px-2 py-1 text-sm md:hidden"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Menu
        </button>
        <div className="flex min-w-0 shrink-0 flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-paper">NSE Universe</span>
          <span className="hidden text-xs text-muted sm:block md:block">{underlying} 50 options</span>
        </div>
        <SpotBadge latest={spotSnapshot ?? latest} className="col-span-3 row-start-2 md:col-auto md:row-auto" />
        <div className="col-start-3 row-start-1 justify-self-end md:ml-auto">
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
        <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 md:p-4 lg:p-6">
          <Outlet key={clockKey} />
        </main>
      </div>
    </div>
  );
}
