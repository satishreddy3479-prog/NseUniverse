import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { HOW_TO_USE, learnSections, type Entry } from "../lib/learn";
import { toolPath } from "../lib/tools";

const flat = (e: Entry): string => [e.title, e.lesson.idea, ...e.lesson.read, e.lesson.example.setup, e.lesson.example.reading, ...e.lesson.watch, e.tool?.group ?? ""].join(" ").toLowerCase();

function LessonCard({ e }: { e: Entry }) {
  const path = e.tool ? toolPath(e.tool) : null;
  return (
    <article id={e.id} className="scroll-mt-20 rounded-sm border border-rule bg-slate p-4" data-testid={`lesson-${e.id}`}>
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-paper">{e.title}</h3>
        {path && <Link to={path} className="text-xs text-accent hover:underline">Open this tool →</Link>}
      </header>
      <h4 className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">The idea</h4>
      <p className="text-sm text-paper">{e.lesson.idea}</p>
      <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">How to read it</h4>
      <ul className="ml-4 list-disc space-y-1 text-sm text-paper">{e.lesson.read.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="mt-3 rounded-sm border border-rule bg-paper/5 p-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Worked example <span className="font-normal normal-case">(round numbers to follow by hand, not market data)</span></h4>
        <p className="mt-1 text-sm text-paper"><b>Situation.</b> {e.lesson.example.setup}</p>
        <p className="mt-1 text-sm text-paper"><b>Reading.</b> {e.lesson.example.reading}</p>
      </div>
      <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Common mistakes</h4>
      <ul className="ml-4 list-disc space-y-1 text-sm text-muted">{e.lesson.watch.map((w) => <li key={w}>{w}</li>)}</ul>
    </article>
  );
}

export function Learn() {
  const [q, setQ] = useState("");
  const { hash } = useLocation();
  const sections = useMemo(() => learnSections(), []);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => sections.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, entries: needle ? g.entries.filter((e) => flat(e).includes(needle)) : g.entries })).filter((g) => g.entries.length > 0) })).filter((s) => s.groups.length > 0),
    [sections, needle],
  );
  const count = shown.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.entries.length, 0), 0);
  useEffect(() => {
    if (hash.length > 1) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4 lg:flex-row" data-testid="learn-page">
      <nav aria-label="Lessons" className="lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)] lg:w-64 lg:shrink-0 lg:self-start lg:overflow-y-auto">
        <label className="mb-2 block text-xs text-muted" htmlFor="learn-search">Search the lessons</label>
        <input id="learn-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. gamma, PCR, straddle" className="mb-3 min-h-10 w-full rounded-sm border border-rule bg-slate px-2 text-sm text-paper" />
        <div className="hidden lg:block">
          {shown.map((s) => (
            <div key={s.key} className="mb-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{s.title}</div>
              {s.groups.map((g) => (
                <div key={g.name} className="mt-1">
                  <div className="text-xs font-medium text-paper">{g.name}</div>
                  <ul>{g.entries.map((e) => <li key={e.id}><a href={`#${e.id}`} className="block truncate py-0.5 pl-2 text-xs text-muted hover:text-paper">{e.title}</a></li>)}</ul>
                </div>
              ))}
            </div>
          ))}
        </div>
        <select aria-label="Jump to a lesson" className="min-h-10 w-full rounded-sm border border-rule bg-slate px-2 text-sm text-paper lg:hidden" value="" onChange={(e) => { if (e.target.value) window.location.hash = e.target.value; }}>
          <option value="">Jump to a lesson…</option>
          {shown.map((s) => <optgroup key={s.key} label={s.title}>{s.groups.flatMap((g) => g.entries).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</optgroup>)}
        </select>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold">Learn</h1>
          <p className="text-sm text-muted">How to read every tool in the app, with a worked example for each. Start with the first seven lessons: they explain the ideas the tools share.</p>
          <p className="mt-2 rounded-sm border border-warn/40 p-2 text-xs text-warn">{HOW_TO_USE}</p>
        </div>
        {count === 0 && <p className="text-sm text-muted" role="status">No lesson matches “{q}”.</p>}
        {shown.map((s) => (
          <section key={s.key} aria-label={s.title} className="flex flex-col gap-3">
            <h2 className="mt-2 border-b border-rule pb-1 text-lg font-semibold text-paper">{s.title}</h2>
            {s.groups.map((g) => (
              <div key={g.name} className="flex flex-col gap-3">
                <div className="text-sm font-semibold text-muted">{g.name}</div>
                {g.entries.map((e) => <LessonCard key={e.id} e={e} />)}
              </div>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
