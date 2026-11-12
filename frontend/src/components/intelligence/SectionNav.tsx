import { useEffect, useState } from "react";

export interface NavItem { id: string; label: string }

/** A sticky strip of jump links for a long page. The link of the section nearest the top is highlighted (where the browser can tell). */
export function SectionNav({ items }: { items: NavItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Number.POSITIVE_INFINITY);
      const best = [...seen.entries()].filter(([, t]) => Number.isFinite(t)).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
      if (best) setActive(best[0]);
    }, { rootMargin: "-10% 0px -70% 0px", threshold: 0 });
    for (const it of items) { const el = document.getElementById(it.id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [items]);
  const go = (id: string) => (e: React.MouseEvent) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return (
    <nav aria-label="Sections of this page" className="sticky -top-3 z-20 -mx-3 border-b border-rule bg-ink px-3 py-1.5 md:-top-4 md:-mx-4 md:px-4 lg:-top-6 lg:-mx-6 lg:px-6" data-testid="mi-nav">
      <ul className="flex gap-1.5 overflow-x-auto whitespace-nowrap pb-0.5 text-xs [scrollbar-width:thin]">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} onClick={go(it.id)} aria-current={active === it.id ? "true" : undefined}
              className={`inline-block rounded-full border px-2.5 py-1 transition-colors ${active === it.id ? "border-accent bg-accent/15 text-paper" : "border-rule bg-slate text-muted hover:border-accent/60 hover:text-paper"}`}>{it.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
