import { useState } from "react";
import { MODES, ROLE_LABEL, modeSummary, type ModeRole, type SwingMode } from "../../lib/swingModes";

const ROLE_STYLE: Record<ModeRole, string> = {
  official: "border-up/60 bg-up/10 text-up", shadow: "border-warn/60 bg-warn/10 text-warn", history: "border-info/60 bg-info/10 text-info",
};

/** The one place that says what each way of running the rules is: its data, when it decides, where it fills, and whether it touches the official book. */
export function SwingModes({ onOpen, current }: { onOpen: (m: SwingMode) => void; current?: SwingMode["id"] | null }) {
  // open on a wide screen; on a phone it starts folded so the sections below are not pushed five screens down (the one-line summary stays visible)
  const [open, setOpen] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches);
  return (
    <section aria-label="What is being tested" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 md:p-4" data-testid="swing-modes">
      <h2 className="text-sm font-semibold text-paper">What is being tested</h2>
      <p className="mt-0.5 text-[13px] leading-snug text-muted" data-testid="swing-modes-summary">{modeSummary()} The same entry, stop and exit rules sit behind all of them; they differ in the prices they read and when they decide.</p>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mt-2">
        <summary className="cursor-pointer text-sm text-info">{open ? "Hide the comparison" : "Show the comparison of all five"}</summary>
      <div className="mt-3 overflow-x-auto">
        <table className="stack-rows w-full min-w-[56rem] text-left text-xs leading-snug">
          <caption className="sr-only">The ways the swing rules are run and what each does to the official book</caption>
          <thead><tr className="text-[11px] uppercase tracking-wide text-muted">
            <th className="py-1.5 pr-3 font-medium">Test</th><th className="py-1.5 pr-3 font-medium">Prices it reads</th><th className="py-1.5 pr-3 font-medium">When it decides</th>
            <th className="py-1.5 pr-3 font-medium">Fills at</th><th className="py-1.5 pr-3 font-medium">What it does to the official book</th><th className="py-1.5 font-medium"><span className="sr-only">Open</span></th>
          </tr></thead>
          <tbody>
            {MODES.map((m) => (
              <tr key={m.id} data-testid={`swing-mode-${m.id}`} className={`border-t border-rule align-top ${current === m.id ? "bg-accent/5" : ""}`}>
                <td className="py-2 pr-3">
                  <div className="flex items-start gap-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-paper text-xs font-semibold text-ink" aria-hidden>{m.letter}</span>
                    <div><div className="text-sm font-semibold text-paper">{m.name}</div><span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px] ${ROLE_STYLE[m.role]}`}>{ROLE_LABEL[m.role]}</span></div>
                  </div>
                </td>
                <td data-label="Prices it reads" className="py-2 pr-3 text-paper">{m.data}</td>
                <td data-label="When it decides" className="py-2 pr-3 text-paper">{m.decides}</td>
                <td data-label="Fills at" className="py-2 pr-3 text-paper">{m.fills}</td>
                <td data-label="Official book" className="py-2 pr-3 text-paper">{m.effect}</td>
                <td className="py-2"><button type="button" onClick={() => onOpen(m)} className="min-h-9 whitespace-nowrap rounded-sm border border-rule bg-slate-2 px-3 text-sm text-paper hover:border-accent">Open {m.name.toLowerCase()}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </details>
    </section>
  );
}

/** A line at the top of each tab: what kind of result this is. */
export function RoleBanner({ role, children }: { role: ModeRole; children: React.ReactNode }) {
  return (
    <p data-testid={`role-${role}`} className={`mb-3 rounded-md border px-3 py-2 text-sm text-paper ${ROLE_STYLE[role]}`}>
      <b>{ROLE_LABEL[role]}.</b> <span className="text-paper">{children}</span>
    </p>
  );
}
