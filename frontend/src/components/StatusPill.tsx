import { Link } from "react-router-dom";
import { summarize, type Signal, type Tone } from "../lib/signals";

const DOT: Record<Tone, string> = {
  ok: "bg-up", pending: "bg-info", warn: "bg-warn", bad: "bg-down", idle: "bg-muted",
};

/** The single status the top bar keeps. The full signal list lives in Settings. */
export function StatusPill({ signals }: { signals: Signal[] }) {
  const s = summarize(signals);
  return (
    <Link
      to="/settings#status"
      title={`${s.detail}. Open Settings for details.`}
      aria-label={`System status: ${s.label}`}
      className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-rule bg-slate-2 px-2.5 text-xs font-medium text-paper hover:border-muted max-sm:size-8 max-sm:justify-center max-sm:px-0 sm:max-w-none"
    >
      <span aria-hidden className={`size-2.5 shrink-0 rounded-full sm:size-2 ${DOT[s.tone]}`} />
      <span className={`truncate max-sm:sr-only ${s.tone === "bad" ? "text-down" : s.tone === "warn" ? "text-warn" : ""}`}>{s.label}</span>
    </Link>
  );
}
