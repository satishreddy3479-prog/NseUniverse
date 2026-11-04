import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { api } from "../lib/api";
import { setSessionClock } from "../lib/session";
import { useLiveConnection } from "../lib/useLive";
import { useSignals } from "../lib/useSignals";
import { Link } from "react-router-dom";
import { MobileNav, TopNav } from "./TopNav";
import { ThemeSwitch } from "./ThemeSwitch";
import { SpotBadge } from "./SpotBadge";
import { StatusPill } from "./StatusPill";


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
      <header className="relative z-30 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 md:flex-nowrap border-b border-rule bg-slate px-3 py-1">
        <button
          type="button"
          className="rounded-sm border border-rule px-2 py-1 text-sm md:hidden"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Menu
        </button>
        <Link to="/" className="flex min-w-0 shrink-0 items-center gap-2 leading-tight" aria-label="NSE Universe home">
          <img src="/logo.svg" alt="" width={34} height={34} className="h-[34px] w-[34px] shrink-0 rounded-[9px] ring-1 ring-black/10" />
          <span className="flex flex-col">
            <span className="text-[15px] font-semibold tracking-tight text-paper">NSE Universe</span>
            <span className="hidden text-xs text-muted sm:block">{underlying} 50 options</span>
          </span>
        </Link>
        <TopNav />
        <div className="ml-auto flex shrink-0 items-center justify-end gap-x-3 whitespace-nowrap">
          <SpotBadge latest={spotSnapshot ?? latest} className="md:flex-nowrap" />
          <StatusPill signals={signals} />
          <div className="hidden xl:block"><ThemeSwitch /></div>
        </div>
      </header>
      {menuOpen && (
        <div id="mobile-nav" className="z-20 border-b border-rule bg-slate md:hidden">
          <MobileNav onNavigate={() => setMenuOpen(false)} />
        </div>
      )}
      <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 md:p-4 lg:p-6">
        <Outlet key={clockKey} />
      </main>
    </div>
  );
}
