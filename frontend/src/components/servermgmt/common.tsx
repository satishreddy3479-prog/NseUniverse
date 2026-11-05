import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MISSING } from "../../lib/format";

/** Bytes in decimal units; unavailable is a dash, never 0. */
export const bytes = (v: number | null | undefined, d = 1): string => {
  if (v == null) return MISSING;
  const a = Math.abs(v);
  const s = a >= 1e12 ? `${(a / 1e12).toFixed(2)} TB` : a >= 1e9 ? `${(a / 1e9).toFixed(2)} GB` : a >= 1e6 ? `${(a / 1e6).toFixed(d)} MB` : a >= 1e3 ? `${(a / 1e3).toFixed(0)} KB` : `${a} B`;
  return v < 0 ? `−${s}` : s;
};
export const signedBytes = (v: number | null | undefined): string => (v == null ? MISSING : v > 0 ? `+${bytes(v)}` : bytes(v));
export const pct = (v: number | null | undefined, d = 1): string => (v == null ? MISSING : `${v.toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 2): string => (v == null ? MISSING : v.toFixed(d));
export const count = (v: number | null | undefined): string => (v == null ? MISSING : v.toLocaleString("en-IN"));
const ist = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const when = (iso: string | null | undefined): string => (iso ? `${ist.format(new Date(iso))} IST` : MISSING);
export const dur = (s: number | null | undefined): string => {
  if (s == null) return MISSING;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const ago = (s: number | null | undefined): string => (s == null ? MISSING : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);
export const ratio = (num_: number | null | undefined, den: number | null | undefined): number | null => (num_ == null || den == null || den === 0 ? null : (100 * num_) / den);

export const btn = (on = false) => `min-h-9 rounded-sm border px-3 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"} disabled:opacity-40`;
export const field = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

export const TONE: Record<string, string> = { ok: "border-up/50 text-up", complete: "border-up/50 text-up", warning: "border-warn/60 text-warn", partial: "border-warn/60 text-warn", critical: "border-down/60 text-down", failed: "border-down/60 text-down", info: "border-rule text-muted" };
export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`inline-block rounded-sm border px-1.5 py-px text-[11px] font-semibold uppercase ${TONE[kind] ?? TONE.info}`}>{children}</span>;
}

export function Card({ title, children, actions, note }: { title: string; children: ReactNode; actions?: ReactNode; note?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-[var(--radius-panel)] border border-rule bg-slate">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <h2 className="text-sm font-semibold text-paper">{title}</h2>
        {actions}
      </header>
      <div className="p-3">{children}</div>
      {note && <p className="border-t border-rule px-3 py-2 text-[11px] text-muted">{note}</p>}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-lg font-semibold ${tone ?? "text-paper"}`}>{value}</div>
      {sub != null && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Bar({ value, warn, crit, label }: { value: number | null; warn?: number; crit?: number; label: string }) {
  if (value == null) return <div className="h-2 rounded-sm bg-slate-2" role="img" aria-label={`${label}: unavailable`} />;
  const tone = crit != null && value >= crit ? "bg-down" : warn != null && value >= warn ? "bg-warn" : "bg-info";
  return (
    <div className="h-2 overflow-hidden rounded-sm bg-slate-2" role="img" aria-label={`${label}: ${value.toFixed(1)}%`}>
      <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/** Loading, error and empty states for one query; renders children only with data. */
export function Async<T>({ q, children, what }: { q: UseQueryResult<T>; what: string; children: (d: T) => ReactNode }) {
  if (q.isPending) return <div className="h-24 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label={`Loading ${what}`} />;
  if (q.isError || q.data === undefined)
    return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">{what} could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  return <>{children(q.data)}</>;
}

export function useServerQuery<T>(key: unknown[], fn: () => Promise<T>, every = 60_000) {
  return useQuery({ queryKey: ["server", ...key], queryFn: fn, refetchInterval: every, retry: false });
}

export function Table({ head, rows, empty, testId, min = "40rem" }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string; testId?: string; min?: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty ?? "Nothing to show."}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" style={{ minWidth: min }} data-testid={testId}>
        <thead><tr className="text-left text-[11px] text-muted">{head.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-1 font-normal">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-rule/50">{r.map((c, j) => <td key={j} className="num px-2 py-1 text-paper">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
