import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lookup, type GlossaryEntry } from "../lib/glossary";

/**
 * A small "i" button that explains a number, chart or panel: what it is, how to read it, and what it does not tell you.
 * `term` is the label or title to look up in the glossary; with no entry nothing is drawn (nothing is invented).
 * Click or tap to open, click again, press Escape or click outside to close. The panel is drawn outside its parent
 * so cards that clip their content cannot cut it off, and on a phone it sits at the bottom of the screen.
 */
export function Info({ term, entry, title, className = "" }: { term?: string; entry?: GlossaryEntry; title?: string; className?: string }) {
  const found = entry ? { key: title ?? term ?? "", entry } : lookup(term);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const below = r.bottom + 8;
    setPos({ top: below, left, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onScroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  if (!found) return null;
  const heading = title ?? term ?? found.key;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label="Help: how to read this"
        title={`How to read: ${heading}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onMouseDown={(e) => e.stopPropagation()}
        className={`widget-nodrag inline-grid size-[18px] shrink-0 place-items-center rounded-full border border-muted/60 align-middle font-serif text-[11px] italic leading-none text-muted after:content-['i'] hover:border-info hover:text-info focus-visible:outline focus-visible:outline-2 focus-visible:outline-info ${open ? "border-info text-info" : ""} ${className}`}
      >
      </button>
      {open && pos && createPortal(
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={`About: ${heading}`}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100vh - ${pos.top + 12}px)` }}
          className="fixed z-[60] overflow-y-auto rounded-md border border-rule bg-slate p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-paper shadow-2xl"
        >
          <div className="mb-1 flex items-start justify-between gap-2">
            <div className="text-[13px] font-semibold">{heading}</div>
            <button type="button" aria-label="Close help" onClick={close} className="-mr-1 -mt-1 grid size-6 place-items-center rounded-sm text-muted hover:text-paper">×</button>
          </div>
          <p><span className="font-semibold text-info">What it is. </span>{found.entry.what}</p>
          <p className="mt-1.5"><span className="font-semibold text-up">How to read it. </span>{found.entry.read}</p>
          {found.entry.caution && <p className="mt-1.5"><span className="font-semibold text-warn">Keep in mind. </span>{found.entry.caution}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
