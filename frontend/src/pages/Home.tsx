import { useQuery } from "@tanstack/react-query";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CommandStrip } from "../components/intelligence/Overview";
import { api } from "../lib/api";
import { loadRecent } from "../lib/recent";
import { MENU_ORDER, MENU_TITLES, TOOLS, menuGroups, toolPath, type Tool } from "../lib/tools";
import { Loading } from "../components/Loading";
import { PinnedStrategy } from "../components/PinnedStrategy";

function ToolLink({ t }: { t: Tool }) {
  const to = toolPath(t);
  const planned = t.status === "planned";
  const body = (
    <>
      <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-semibold text-paper">{t.label}</span>
        {planned && <span className="rounded-sm border border-rule px-1 text-[10px] text-muted">Planned</span>}</span>
      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{t.blurb}</span>
      {planned && t.needs && <span className="mt-0.5 block text-[11px] text-warn">{t.needs}</span>}
    </>
  );
  const cls = "block rounded-sm border border-rule bg-slate px-3 py-2.5 transition";
  return to ? <Link to={to} className={`${cls} tool-card hover:border-accent`}>{body}</Link> : <div className={`${cls} opacity-75`} aria-disabled="true">{body}</div>;
}

const icon = (d: ReactNode) => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
const START: { to: string; label: string; text: string; icon: ReactNode }[] = [
  { to: "/market-intelligence", label: "Market Intelligence", text: "Sentiment, regime, evidence and scenarios from every engine.", icon: icon(<><path d="M3 20V9" /><path d="M9 20V4" /><path d="M15 20v-8" /><path d="M21 20V7" /></>) },
  { to: "/option-chain", label: "Option Chain", text: "The live chain with OI, volume, IV and Greeks.", icon: icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16M15 4v16" /></>) },
  { to: "/strategy", label: "Strategy Builder", text: "Build options and futures strategies and track them on paper.", icon: icon(<><path d="M4 18 10 11l4 4 6-8" /><path d="M15 7h5v5" /></>) },
  { to: "/swing", label: "Swing trading", text: "Evening scan, paper book and live paper ledger.", icon: icon(<><path d="M3 12c3-8 6-8 9 0s6 8 9 0" /></>) },
];

const toolByPath = (path: string): { label: string; blurb: string } | null => {
  const s = START.find((x) => x.to === path);
  if (s) return { label: s.label, blurb: s.text };
  const t = TOOLS.find((x) => toolPath(x) === path);
  return t ? { label: t.label, blurb: t.blurb } : null;
};

/** Home: the market in one strip first, where you were last, the four places you go next, then every tool in one filterable list. */
export function Home() {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<string>("all");
  const search = useRef<HTMLInputElement>(null);
  const intel = useQuery({ queryKey: ["intelligence"], queryFn: () => api.intelligenceSummary(), refetchInterval: 10_000, retry: false });
  const ready = TOOLS.filter((t) => t.status === "ready").length;
  const recent = useMemo(() => loadRecent().map((p) => ({ path: p, ...toolByPath(p) })).filter((x): x is { path: string; label: string; blurb: string } => !!x.label), []);
  const match = (t: Tool) => !q.trim() || `${t.label} ${t.blurb} ${t.group}`.toLowerCase().includes(q.trim().toLowerCase());
  const menus = useMemo(() => MENU_ORDER.filter((m) => only === "all" || m === only).map((m) => ({ m, groups: menuGroups(m).map((g) => ({ ...g, tools: g.tools.filter(match) })).filter((g) => g.tools.length) })).filter((x) => x.groups.length), [q, only]); // eslint-disable-line react-hooks/exhaustive-deps
  // "/" jumps to the search box from anywhere on the page that is not a text field
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || el?.closest("input,textarea,select,[contenteditable=true]")) return;
      e.preventDefault(); search.current?.focus();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const chip = (on: boolean) => `min-h-9 rounded-full border px-3 text-sm font-medium ${on ? "border-accent bg-accent/15 text-paper" : "border-rule bg-slate text-muted hover:text-paper"}`;
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold md:text-3xl">NIFTY 50 command centre</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted md:text-base">Your own Kotak feed and the snapshots this server stores every minute. <span className="font-semibold text-paper">{ready}</span> tools ready.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><ChartInfoToggle /><Link to="/market-intelligence" className="inline-flex min-h-9 items-center rounded-sm border border-accent bg-accent/10 px-4 text-sm font-semibold text-paper hover:bg-accent/20">Open the full dashboard</Link></div>
      </header>
      {intel.isPending && <Loading label="Loading the market summary" />}
      {intel.data && <CommandStrip d={intel.data} compact />}
      {intel.isError && <p className="rounded-sm border border-rule bg-slate px-3 py-2 text-sm text-muted" data-testid="home-no-intel">The market summary is not available right now ({intel.error instanceof Error ? intel.error.message : "unknown error"}). The tools below still work.</p>}
      <PinnedStrategy />
      {recent.length > 0 && (
        <section aria-label="Jump back in" data-testid="home-recent" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Jump back in</h2>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => <Link key={r.path} to={r.path} title={r.blurb} className="inline-flex min-h-9 items-center rounded-full border border-rule bg-slate px-3.5 text-sm font-medium text-paper hover:border-accent">{r.label}</Link>)}
          </div>
        </section>
      )}
      <section aria-label="Start here" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {START.map((x) => (
          <Link key={x.to} to={x.to} className="tool-card group flex flex-col gap-2 rounded-[var(--radius-panel)] border border-rule bg-slate p-4 hover:border-accent">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent/12 text-accent">{x.icon}</span>
            <span className="text-base font-semibold text-paper">{x.label}</span>
            <span className="text-sm text-muted">{x.text}</span>
            <span className="mt-auto text-sm font-semibold text-accent opacity-80 group-hover:opacity-100">Open →</span>
          </Link>
        ))}
      </section>
      <section aria-label="All tools" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">All tools</h2>
          <label className="block w-full max-w-sm"><span className="sr-only">Search tools</span><input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools  ( / )" aria-label="Search tools" className="min-h-10 w-full rounded-sm border border-rule bg-slate px-3 text-sm text-paper placeholder:text-muted" /></label>
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={only === "all"} onClick={() => setOnly("all")} className={chip(only === "all")}>All</button>
          {MENU_ORDER.map((m) => <button key={m} type="button" aria-pressed={only === m} onClick={() => setOnly(m)} className={chip(only === m)}>{MENU_TITLES[m]}</button>)}
        </div>
        {menus.map(({ m, groups }) => (
          <div key={m} aria-label={MENU_TITLES[m]}>
            <h3 className="mb-1.5 text-base font-semibold text-paper">{MENU_TITLES[m]}</h3>
            {groups.map((g) => (
              <div key={g.group} className="mb-4">
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{g.group}</h4>
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
