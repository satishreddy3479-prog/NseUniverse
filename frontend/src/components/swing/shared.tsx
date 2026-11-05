import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { fmtStamp, type SortDir } from "../../lib/swing";

export interface TabDef { id: string; label: string }

/** Accessible tab list: arrow keys, Home and End move between tabs; the active panel is rendered by the caller. */
export function Tabs({ tabs, value, onChange, label }: {
  tabs: TabDef[]; value: string; onChange: (id: string) => void; label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-rule">
      {tabs.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`swing-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`swing-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => move(e, i)}
            className={`min-h-10 shrink-0 border-b-2 px-3 text-sm ${on ? "border-brass font-medium text-paper" : "border-transparent text-muted hover:text-paper"}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`swing-panel-${id}`} aria-labelledby={`swing-tab-${id}`} className="flex flex-col gap-4 pt-4">
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-slate-2/40 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={`num mt-0.5 text-lg font-semibold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-paper"}`}>{value}</p>
      {sub && <p className="num mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

/** Sortable column header. The arrow is text, so the sort state is not conveyed by colour alone. */
export function SortTh({ label, k, sortKey, dir, onSort, align = "right", title }: {
  label: string; k: string; sortKey: string; dir: SortDir; onSort: (k: string) => void; align?: "left" | "right"; title?: string;
}) {
  const active = sortKey === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`px-2 py-1.5 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button type="button" onClick={() => onSort(k)} title={title} className="inline-flex items-center gap-1 hover:text-paper">
        {label}
        <span aria-hidden className="w-3 text-[10px]">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

/** Status in words as well as colour. */
export function Verdict({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok == null) return <span className="text-muted">No data</span>;
  return <span className={ok ? "text-up" : "text-down"}>{ok ? `✓ ${yes}` : `✕ ${no}`}</span>;
}

export const TABLE_WRAP = "overflow-x-auto";
export const THEAD = "bg-slate-2 text-xs text-muted";
export const TD = "px-2 py-1.5 text-right";
export const TD_L = "px-2 py-1.5 text-left";

/** A trading day with what is known about its time: when the live feed saw the rule met (exact, seconds) and when the paper job recorded the day. */
export function When({ day, seen, seenLabel, booked }: { day: string; seen?: string | null; seenLabel: string; booked?: string | null }) {
  return (
    <>
      <div>{day}</div>
      {seen && <div className="text-[11px] text-muted" title="The Kotak feed saw the rule met at this moment (shadow log)">{seenLabel} {fmtStamp(seen, true)}</div>}
      {booked && <div className="text-[11px] text-muted" title="The paper book is settled from daily bars after the close: this is when the job recorded the day">booked {fmtStamp(booked)}</div>}
    </>
  );
}
