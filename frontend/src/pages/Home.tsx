import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MENU_ORDER, MENU_TITLES, TOOLS, menuGroups, toolPath, type Tool } from "../lib/tools";

function Card({ t }: { t: Tool }) {
  const to = toolPath(t);
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-paper">{t.label}</span>
        {t.isNew && t.status === "ready" && <span className="rounded-sm bg-up/20 px-1 text-[10px] font-semibold text-up">NEW</span>}
        {t.status === "planned" && <span className="rounded-sm border border-rule px-1 text-[10px] text-muted">Planned</span>}
      </div>
      <p className="mt-1 text-xs text-muted">{t.blurb}</p>
      {t.status === "planned" && t.needs && <p className="mt-1 text-[11px] text-warn">{t.needs}</p>}
    </>
  );
  const cls = "block rounded-[var(--radius-panel)] border border-rule bg-slate p-3";
  return to ? <Link to={to} className={`${cls} hover:border-brass`}>{inner}</Link> : <div className={`${cls} opacity-70`} aria-disabled="true">{inner}</div>;
}

/** Home: every tool in one place, popular ones first. Each card opens a page built from our own live or stored data; planned tools say what they need. */
export function Home() {
  const [q, setQ] = useState("");
  const ready = TOOLS.filter((t) => t.status === "ready").length;
  const match = (t: Tool) => !q.trim() || `${t.label} ${t.blurb} ${t.group}`.toLowerCase().includes(q.trim().toLowerCase());
  const popular = useMemo(() => TOOLS.filter((t) => t.popular && match(t)), [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">NIFTY 50 option and futures tools</h1>
        <p className="mt-1 max-w-[75ch] text-sm text-muted">
          Built from your own Kotak Neo feed and the snapshots this server stores every minute in market hours. Nothing here is sample data: a tool without data says so.
          {" "}{ready} tools are ready; the rest are marked Planned with what they still need.
        </p>
        <label className="mt-3 block max-w-md">
          <span className="sr-only">Search tools</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools" aria-label="Search tools"
            className="min-h-10 w-full rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper" />
        </label>
      </section>
      {popular.length > 0 && (
        <section aria-label="Popular tools">
          <h2 className="mb-2 text-base font-semibold">Popular tools</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{popular.map((t) => <Card key={t.id} t={t} />)}</div>
        </section>
      )}
      <section aria-label="Build and review" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[{ to: "/strategy", l: "Strategy Builder", d: "Build, adjust and track paper strategies; stops and targets run on the server." },
          { to: "/option-chain", l: "Option Chain", d: "The live chain with OI, volume, IV and Greeks." },
          { to: "/portfolio", l: "Strategy portfolio", d: "Live P&L of running and closed strategies." },
          { to: "/prediction", l: "Prediction", d: "T+1 and T+5 research forecasts and what they were built from." }].map((x) => (
          <Link key={x.to} to={x.to} className="block rounded-[var(--radius-panel)] border border-rule bg-slate p-3 hover:border-brass">
            <div className="text-sm font-semibold text-paper">{x.l}</div><p className="mt-1 text-xs text-muted">{x.d}</p>
          </Link>
        ))}
      </section>
      {MENU_ORDER.map((m) => {
        const groups = menuGroups(m).map((g) => ({ ...g, tools: g.tools.filter(match) })).filter((g) => g.tools.length);
        return groups.length === 0 ? null : (
          <section key={m} aria-label={MENU_TITLES[m]}>
            <h2 className="mb-2 text-base font-semibold">{MENU_TITLES[m]}</h2>
            {groups.map((g) => (
              <div key={g.group} className="mb-4">
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{g.group}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{g.tools.map((t) => <Card key={t.id} t={t} />)}</div>
              </div>
            ))}
          </section>
        );
      })}
      {q.trim() && TOOLS.every((t) => !match(t)) && <p className="text-sm text-muted">No tool matches “{q}”.</p>}
    </div>
  );
}
