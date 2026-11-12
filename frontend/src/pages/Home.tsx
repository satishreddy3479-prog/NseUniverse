import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CommandStrip } from "../components/intelligence/Overview";
import { api } from "../lib/api";
import { MENU_ORDER, MENU_TITLES, TOOLS, menuGroups, toolPath, type Tool } from "../lib/tools";

function ToolLink({ t }: { t: Tool }) {
  const to = toolPath(t);
  const planned = t.status === "planned";
  const body = (
    <>
      <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium text-paper">{t.label}</span>
        {planned && <span className="rounded-sm border border-rule px-1 text-[10px] text-muted">Planned</span>}</span>
      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{t.blurb}</span>
      {planned && t.needs && <span className="mt-0.5 block text-[11px] text-warn">{t.needs}</span>}
    </>
  );
  const cls = "block rounded-sm border border-rule bg-slate px-3 py-2 transition";
  return to ? <Link to={to} className={`${cls} hover:border-brass`}>{body}</Link> : <div className={`${cls} opacity-75`} aria-disabled="true">{body}</div>;
}

const START: { to: string; label: string; text: string }[] = [
  { to: "/market-intelligence", label: "Market Intelligence", text: "Sentiment, regime, evidence and scenarios from every engine." },
  { to: "/option-chain", label: "Option Chain", text: "The live chain with OI, volume, IV and Greeks." },
  { to: "/strategy", label: "Strategy Builder", text: "Build and track paper strategies." },
  { to: "/swing", label: "Swing trading", text: "Evening scan, paper book and live paper ledger." },
];

/** Home: the market in one strip first, then the places you go next, then every tool in one searchable list. */
export function Home() {
  const [q, setQ] = useState("");
  const intel = useQuery({ queryKey: ["intelligence"], queryFn: () => api.intelligenceSummary(), refetchInterval: 10_000, retry: false });
  const ready = TOOLS.filter((t) => t.status === "ready").length;
  const match = (t: Tool) => !q.trim() || `${t.label} ${t.blurb} ${t.group}`.toLowerCase().includes(q.trim().toLowerCase());
  const menus = useMemo(() => MENU_ORDER.map((m) => ({ m, groups: menuGroups(m).map((g) => ({ ...g, tools: g.tools.filter(match) })).filter((g) => g.tools.length) })).filter((x) => x.groups.length), [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div><h1 className="text-xl font-semibold md:text-2xl">NIFTY 50 command centre</h1><p className="text-xs text-muted md:text-sm">Your own Kotak feed and the snapshots this server stores every minute. {ready} tools are ready.</p></div>
        <Link to="/market-intelligence" className="rounded-sm border border-brass px-3 py-1.5 text-sm text-paper hover:bg-brass/15">Open the full dashboard →</Link>
      </header>
      {intel.isPending && <div className="h-28 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading the market summary" />}
      {intel.data && <CommandStrip d={intel.data} compact />}
      {intel.isError && <p className="rounded-sm border border-rule bg-slate px-3 py-2 text-sm text-muted" data-testid="home-no-intel">The market summary is not available right now ({intel.error instanceof Error ? intel.error.message : "error"}). The tools below still work.</p>}
      <section aria-label="Start here" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {START.map((x) => <Link key={x.to} to={x.to} className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 hover:border-brass"><div className="text-sm font-semibold text-paper">{x.label}</div><p className="mt-0.5 text-xs text-muted">{x.text}</p></Link>)}
      </section>
      <section aria-label="All tools" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">All tools</h2>
          <label className="block w-full max-w-sm"><span className="sr-only">Search tools</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="min-h-10 w-full rounded-full border border-rule bg-slate px-4 text-sm text-paper" /></label></div>
        {menus.map(({ m, groups }) => (
          <div key={m} aria-label={MENU_TITLES[m]}>
            <h3 className="mb-1 text-sm font-semibold text-paper">{MENU_TITLES[m]}</h3>
            {groups.map((g) => (
              <div key={g.group} className="mb-3">
                <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{g.group}</h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{g.tools.map((t) => <ToolLink key={t.id} t={t} />)}</div>
              </div>
            ))}
          </div>
        ))}
        {menus.length === 0 && <p className="text-sm text-muted">No tool matches “{q}”.</p>}
      </section>
    </div>
  );
}
