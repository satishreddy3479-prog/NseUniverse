import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Full-window view of a chart. Esc, the Close button or a click outside the panel closes it. */
export function FullChart({ title, onClose, toolbar, footer, children }: {
  title: string; onClose: () => void; toolbar?: ReactNode; footer?: ReactNode; children: ReactNode;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-2 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-[1800px] flex-col rounded-[var(--radius-panel)] border border-rule bg-slate">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-3 py-2">
          <h2 className="mr-auto text-base font-semibold text-paper">{title}</h2>
          {toolbar}
          <button ref={close} type="button" onClick={onClose} aria-label="Close full chart"
            className="inline-flex min-h-9 items-center rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper hover:border-brass">Close ✕</button>
        </header>
        <div className="min-h-0 flex-1 p-2">{children}</div>
        {footer && <footer className="border-t border-rule px-3 py-1.5 text-xs text-muted">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
