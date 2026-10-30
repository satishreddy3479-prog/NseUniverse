import type { ReactNode } from "react";
import type { Completeness, DataSource } from "../lib/types";

export function Panel({ title, actions, children, className = "" }: {
  title: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`rounded-[var(--radius-panel)] border border-rule bg-slate ${className}`}
    >
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-rule px-4 py-2">
        <h2 className="text-[15px] font-semibold text-paper">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="num mt-0.5 truncate text-[15px] font-medium text-paper">{children}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="font-normal text-muted" title={reason}>
      Unavailable <span className="sr-only">: {reason}</span>
    </span>
  );
}

const SOURCE_LABEL: Record<DataSource, string> = {
  live: "Live",
  snapshot: "Snapshot",
  stored: "Stored (historical)",
};

const SOURCE_STYLE: Record<DataSource, string> = {
  live: "border-up/50 text-up",
  snapshot: "border-info/50 text-info",
  stored: "border-warn/50 text-warn",
};

export function SourceTag({ source }: { source: DataSource }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs font-medium ${SOURCE_STYLE[source]}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

const COMPLETENESS_STYLE: Record<Completeness, string> = {
  complete: "text-up",
  partial: "text-warn",
  empty: "text-down",
};

export function CompletenessText({ value }: { value: Completeness }) {
  const label = { complete: "Complete", partial: "Partial", empty: "Empty" }[value];
  return <span className={COMPLETENESS_STYLE[value]}>{label}</span>;
}

export function Skeleton({ className = "h-4 w-24" }: { className?: string }) {
  return <span aria-hidden className={`skeleton inline-block ${className}`} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <p className="font-medium text-paper">{title}</p>
      {children && <div className="max-w-[60ch] text-sm text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorNote({ title, message }: { title: string; message: string }) {
  return (
    <div role="alert" className="rounded-sm border border-down/50 bg-down/10 px-3 py-2 text-sm">
      <p className="font-medium text-down">{title}</p>
      <p className="text-paper">{message}</p>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "default", type = "button", title, ariaLabel }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; ariaLabel?: string;
  variant?: "default" | "primary"; type?: "button" | "submit"; title?: string;
}) {
  const style = variant === "primary"
    ? "border-brass bg-brass/15 text-paper hover:bg-brass/25"
    : "border-rule bg-slate-2 text-paper hover:border-muted";
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-9 items-center gap-2 rounded-sm border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}
