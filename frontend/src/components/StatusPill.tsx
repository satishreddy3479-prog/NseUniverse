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
      className="flex min-h-9 max-w-[58vw] items-center gap-2 sm:max-w-none rounded-full border border-rule bg-slate-2 px-3 text-[13px] font-medium text-paper hover:border-muted"
    >
      <span aria-hidden className={`size-2 rounded-full ${DOT[s.tone]}`} />
      <span className={`truncate ${s.tone === "bad" ? "text-down" : s.tone === "warn" ? "text-warn" : ""}`}>{s.label}</span>
    </Link>
  );
}
