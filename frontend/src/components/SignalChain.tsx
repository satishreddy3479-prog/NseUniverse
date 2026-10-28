import type { Signal, Tone } from "../lib/signals";

const TONE: Record<Tone, { bar: string; text: string }> = {
  ok: { bar: "bg-up", text: "text-paper" },
  pending: { bar: "bg-info", text: "text-paper" },
  warn: { bar: "bg-warn", text: "text-warn" },
  bad: { bar: "bg-down", text: "text-down" },
  idle: { bar: "bg-rule", text: "text-muted" },
};

/** Four independent signals, left to right in pipeline order:
 *  broker session → snapshot fetch → live stream → data freshness. */
export function SignalChain({ signals }: { signals: Signal[] }) {
  return (
    <ol aria-label="System signals" className="flex min-w-0 items-stretch">
      {signals.map((s, i) => (
        <li
          key={s.key}
          title={s.detail || undefined}
          className={`flex min-w-0 flex-col justify-center border-rule px-3 ${i > 0 ? "border-l" : ""}`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span aria-hidden className={`h-1.5 w-4 rounded-full ${TONE[s.tone].bar}`} />
            {s.label}
          </span>
          <span className={`truncate text-[13px] font-medium ${TONE[s.tone].text}`}>{s.value}</span>
        </li>
      ))}
    </ol>
  );
}
