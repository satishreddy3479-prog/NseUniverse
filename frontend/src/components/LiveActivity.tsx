import { ApiError } from "../lib/api";
import { fmtDateTimeIST, fmtInt, fmtTimeIST } from "../lib/format";
import { useLiveState, useStreamControl, useStreamStatus } from "../lib/useLive";
import { Button, ErrorNote, Field, SourceTag } from "./ui";

const STATE_LABEL: Record<string, string> = {
  stopped: "Not started",
  connecting: "Connecting",
  subscribing: "Subscribing",
  waiting_for_data: "Subscribed, waiting for data",
  streaming: "Streaming",
  reconnecting: "Reconnecting",
  auth_failed: "Sign-in failed",
  failed: "Stopped after repeated failures",
  stale: "Connected, but data is stale",
  market_closed: "Market closed",
};

const TEST_LABEL = { not_run: "Not run", received: "Messages received", no_data: "No data arrived" } as const;

export function StreamButtons() {
  const { stream, outdated } = useStreamStatus();
  const { start, stop } = useStreamControl();
  const active = !!stream && !["stopped", "failed", "auth_failed"].includes(stream.state);
  const err = (start.error ?? stop.error) as unknown;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => start.mutate()} disabled={active || start.isPending || outdated}>
          {start.isPending ? "Starting…" : "Start stream"}
        </Button>
        <Button onClick={() => stop.mutate()} disabled={!active || stop.isPending || outdated}>
          {stop.isPending ? "Stopping…" : "Stop stream"}
        </Button>
      </div>
      {err instanceof ApiError && <span className="text-xs text-down">{err.message}</span>}
    </div>
  );
}

/** Full live-stream readout. Connection state, subscriptions, message flow and freshness stay separate. */
export function LiveActivity({ compact = false }: { compact?: boolean }) {
  const { stream, linkOpen, outdated } = useStreamStatus();
  const live = useLiveState();
  if (outdated)
    return (
      <ErrorNote title="The running backend is an older version"
        message="It has no streaming support yet. Run Stop NSE Universe, then Start NSE Universe (Live) to load the new code." />
    );
  if (!stream) return <p className="text-sm text-muted">Waiting for the backend…</p>;
  const s = stream;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-paper">{STATE_LABEL[s.effective_state] ?? s.effective_state}</span>
        {s.data_source !== "none" && <SourceTag source="live" />}
      </div>
      {s.note && <p className="text-sm text-muted">{s.note}</p>}
      {s.state === "failed" || s.state === "auth_failed" ? (
        <ErrorNote title="Stream stopped" message={s.recent_errors[0]?.message ?? "See Connection diagnostics."} />
      ) : null}
      <dl className={`grid gap-x-6 gap-y-3 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        <Field label="Messages received">{fmtInt(s.message_count)}</Field>
        <Field label="Instruments with data">{fmtInt(s.instruments_with_data)}</Field>
        <Field label="Subscribed / acknowledged">{`${fmtInt(s.subscribed_tokens)} / ${fmtInt(s.acknowledged_tokens)}`}</Field>
        <Field label="Reconnects">{fmtInt(s.reconnect_count)}</Field>
        <Field label="Last market data" hint={s.data_age_seconds != null ? `${s.data_age_seconds}s ago` : undefined}>
          {fmtTimeIST(s.last_market_data_at)}
        </Field>
        <Field label="Exchange status">
          {s.market.state === "unknown" ? "Unknown" : (s.market.text ?? s.market.state)}
        </Field>
        <Field label="Test subscription">{TEST_LABEL[s.test_subscription_result]}</Field>
        <Field label="Browser link" hint={linkOpen ? undefined : "Updates arrive by polling until it reconnects"}>
          <span className={linkOpen ? "text-up" : "text-warn"}>
            {linkOpen ? "Connected" : live.conn === "connecting" ? "Connecting" : "Not connected"}
          </span>
        </Field>
      </dl>
      {!compact && s.connected_since && (
        <p className="text-xs text-muted">Feed connected since {fmtDateTimeIST(s.connected_since)}.</p>
      )}
    </div>
  );
}
