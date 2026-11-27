import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { HOW_TO_USE, learnSections, type Entry } from "../lib/learn";
import { GUIDES, guideText, type Block, type Guide } from "../lib/learnGuides";
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

function BlockView({ b }: { b: Block }) {
  switch (b.k) {
    case "p": return <p className="text-sm text-paper">{b.t}</p>;
    case "h": return <h5 className="text-sm font-semibold text-paper">{b.t}</h5>;
    case "note": return <p className="rounded-sm border border-warn/40 p-2 text-xs text-warn">{b.t}</p>;
    case "steps": return <ol className="ml-5 list-decimal space-y-1 text-sm text-paper">{b.items.map((i) => <li key={i}>{i}</li>)}</ol>;
    case "list": return <ul className="ml-4 list-disc space-y-1 text-sm text-paper">{b.items.map((i) => <li key={i}>{i}</li>)}</ul>;
    case "formula": return <pre className="overflow-x-auto rounded-sm border border-rule bg-paper/5 p-3 font-mono text-xs leading-relaxed text-paper" data-testid="guide-formula">{b.lines.join("\n")}</pre>;
    case "worked":
      return (
        <div className="rounded-sm border border-accent/40 bg-paper/5 p-3" data-testid="guide-worked">
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{b.title}</h5>
          <ul className="mt-1 space-y-1 text-sm text-paper">{b.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-xs text-paper">
            <thead><tr>{b.head.map((h) => <th key={h} className="border-b border-rule px-2 py-1 font-semibold text-muted">{h}</th>)}</tr></thead>
            <tbody>{b.rows.map((r) => <tr key={r.join("|")} className="align-top">{r.map((c, i) => <td key={i} className="border-b border-rule/50 px-2 py-1.5">{c}</td>)}</tr>)}</tbody>
          </table>
          {b.cap && <p className="mt-1 text-xs text-muted">{b.cap}</p>}
        </div>
      );
  }
}

function GuideCard({ g }: { g: Guide }) {
  return (
    <article id={g.id} className="scroll-mt-20 rounded-sm border border-rule bg-slate p-4" data-testid={`guide-${g.id}`}>
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-paper">{g.title}</h3>
        {g.tool && <Link to={g.tool} className="text-xs text-accent hover:underline">Open the page →</Link>}
      </header>
      <p className="text-sm text-muted">{g.summary}</p>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{g.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} className="text-accent hover:underline">{s.title}</a></li>)}</ul>
      {g.sections.map((s) => (
        <section key={s.id} id={s.id} className="mt-4 scroll-mt-20 flex flex-col gap-2">
          <h4 className="border-b border-rule pb-1 text-sm font-semibold text-paper">{s.title}</h4>
          {s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
        </section>
      ))}
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
  const guides = useMemo(() => (needle ? GUIDES.filter((g) => guideText(g).includes(needle)) : GUIDES), [needle]);
  const count = guides.length + shown.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.entries.length, 0), 0);
  useEffect(() => {
    if (hash.length > 1) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4 lg:flex-row" data-testid="learn-page">
      <nav aria-label="Lessons" className="lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)] lg:w-64 lg:shrink-0 lg:self-start lg:overflow-y-auto">
        <label className="mb-2 block text-xs text-muted" htmlFor="learn-search">Search the lessons</label>
        <input id="learn-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. gamma, PCR, straddle" className="mb-3 min-h-10 w-full rounded-sm border border-rule bg-slate px-2 text-sm text-paper" />
        <div className="hidden lg:block">
          {guides.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">How it works</div>
              <ul>{guides.map((g) => <li key={g.id}><a href={`#${g.id}`} className="block truncate py-0.5 pl-2 text-xs text-muted hover:text-paper">{g.title.split(":")[0]}</a></li>)}</ul>
            </div>
          )}
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
          {guides.length > 0 && <optgroup label="How it works">{guides.map((g) => <option key={g.id} value={g.id}>{g.title.split(":")[0]}</option>)}</optgroup>}
          {shown.map((s) => <optgroup key={s.key} label={s.title}>{s.groups.flatMap((g) => g.entries).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</optgroup>)}
        </select>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold">Learn</h1>
          <p className="text-sm text-muted">How to read every tool in the app, with a worked example for each. The first section, How it works, shows exactly how the three main engines (Market Intelligence, the Straddle engine, Trend & Regime) are calculated; after it, the first lessons explain the ideas the tools share.</p>
          <p className="mt-2 rounded-sm border border-warn/40 p-2 text-xs text-warn">{HOW_TO_USE}</p>
        </div>
        {count === 0 && <p className="text-sm text-muted" role="status">No lesson matches “{q}”.</p>}
        {guides.length > 0 && (
          <section aria-label="How it works" className="flex flex-col gap-3" data-testid="learn-guides">
            <h2 className="mt-2 border-b border-rule pb-1 text-lg font-semibold text-paper">How it works: the engines, step by step</h2>
            <p className="text-sm text-muted">The three engines behind the verdicts: what goes in, the exact arithmetic, a worked example you can check by hand, and how the pieces are combined. The figures are the engine's own (a test compares them with the code).</p>
            {guides.map((g) => <GuideCard key={g.id} g={g} />)}
          </section>
        )}
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
