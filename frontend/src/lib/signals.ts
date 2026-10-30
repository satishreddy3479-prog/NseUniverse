// Pure mapping from backend status to the four top-bar signals.
// Kept separate so "connected" can never be confused with "fresh data".
import { isStreamStatus, type AppStatus, type SnapshotSummary, type StreamStatus } from "./types";
import { ageSeconds } from "./format";

export type Tone = "ok" | "pending" | "warn" | "bad" | "idle";

export interface Signal {
  key: "broker" | "snapshot" | "stream" | "market" | "freshness";
  label: string;
  value: string;
  tone: Tone;
  detail: string;
}

export interface LiveInput {
  stream: StreamStatus | undefined;
  linkOpen: boolean;
}

/** A successful snapshot within the last 5 minutes: a failure since then is probably a passing hiccup. */
const recentSuccess = (at: string | null, now: number): boolean => at != null && now - Date.parse(at) < 5 * 60_000;

export function deriveSignals(
  status: AppStatus | undefined,
  backendDown: boolean,
  latest: SnapshotSummary | undefined,
  now: number,
  live: LiveInput = { stream: status?.stream, linkOpen: false },
): Signal[] {
  if (backendDown || !status) {
    const v = backendDown ? "Backend offline" : "Checking";
    const tone: Tone = backendDown ? "bad" : "pending";
    return [
      { key: "broker", label: "Broker", value: v, tone, detail: "Start the backend on port 8000." },
      { key: "snapshot", label: "Snapshot", value: "Unknown", tone: "idle", detail: "" },
      { key: "stream", label: "Stream", value: "Unknown", tone: "idle", detail: "" },
      { key: "market", label: "Market", value: "Unknown", tone: "idle", detail: "" },
      { key: "freshness", label: "Data", value: "Unknown", tone: "idle", detail: "" },
    ];
  }
  const auth = status.auth;
  const broker: Signal = {
    key: "broker",
    label: "Broker",
    ...({
      not_attempted: { value: "Not signed in", tone: "idle" as Tone },
      authenticating: { value: "Signing in", tone: "pending" as Tone },
      authenticated: { value: "Signed in", tone: "ok" as Tone },
      failed: { value: "Sign-in failed", tone: "bad" as Tone },
    }[auth.state] ?? { value: "Unknown", tone: "idle" as Tone }),
    detail: auth.last_error ?? "Kotak Neo session (TOTP + MPIN).",
  };

  const s = status.snapshots;
  const snapshot: Signal = s.in_progress
    ? { key: "snapshot", label: "Snapshot", value: "Fetching", tone: "pending", detail: "" }
    : s.last_error
      ? recentSuccess(s.last_success_at, now)
        // one failed call between good ones (the broker times out now and then) is a retry, not an outage
        ? { key: "snapshot", label: "Snapshot", value: "Retrying", tone: "warn",
            detail: `The last fetch failed (${s.last_error}); the one before it worked ${Math.round((now - Date.parse(s.last_success_at as string)) / 1000)}s ago and the sampler tries again every minute.` }
        : { key: "snapshot", label: "Snapshot", value: "Last fetch failed", tone: "bad", detail: s.last_error }
      : s.last_success_at
        ? { key: "snapshot", label: "Snapshot", value: "Last fetch OK", tone: "ok", detail: "" }
        : { key: "snapshot", label: "Snapshot", value: "None this session", tone: "idle",
            detail: "Capture a snapshot from Overview." };

  const candidate = live.stream ?? status.stream;
  if (!isStreamStatus(candidate)) {
    // The backend is running an older version that has no streaming support.
    const outdated: Signal = { key: "stream", label: "Stream", value: "Backend needs restart", tone: "warn",
      detail: "The running backend predates streaming. Stop and start NSE Universe." };
    const unknownMarket: Signal = { key: "market", label: "Market", value: "Unknown", tone: "idle", detail: "" };
    const base = deriveSignals({ ...status, stream: streamFallback(status) }, false, latest, now,
      { stream: streamFallback(status), linkOpen: false });
    return [base[0]!, base[1]!, outdated, unknownMarket, base[4]!];
  }
  const st = candidate;
  const stream = deriveStream(st, live.linkOpen);
  const market = deriveMarket(st);

  let freshness: Signal;
  if (st.state === "streaming" && st.freshness === "fresh") {
    freshness = { key: "freshness", label: "Data", value: "Live data", tone: "ok",
      detail: `Last market data ${Math.round(st.data_age_seconds ?? 0)}s ago.` };
  } else if (st.state === "streaming" && st.freshness === "stale") {
    freshness = { key: "freshness", label: "Data", value: "Stale", tone: "warn",
      detail: `No market data for ${Math.round(st.data_age_seconds ?? 0)}s although the feed is connected.` };
  } else if (st.market.state === "closed" && latest) {
    freshness = { key: "freshness", label: "Data", value: "Last session", tone: "idle",
      detail: "The exchange reports the market is closed; values are from the last session." };
  } else if (!latest) {
    freshness = { key: "freshness", label: "Data", value: "No data", tone: "idle",
                  detail: "No snapshot stored yet." };
  } else {
    const age = ageSeconds(latest.retrieved_at, now) ?? Infinity;
    freshness = age > status.snapshot_stale_after_seconds
      ? { key: "freshness", label: "Data", value: "Stale", tone: "warn",
          detail: `Latest snapshot is older than ${status.snapshot_stale_after_seconds}s.` }
      : { key: "freshness", label: "Data", value: "Fresh snapshot", tone: "ok",
          detail: "Point-in-time snapshot, not a live stream." };
  }
  return [broker, snapshot, stream, market, freshness];
}


function deriveStream(st: StreamStatus, linkOpen: boolean): Signal {
  const mk = (value: string, tone: Tone, detail = ""): Signal => ({
    key: "stream", label: "Stream", value, tone, detail: detail || st.note,
  });
  const linkNote = linkOpen ? "" : " Browser link to the backend stream is not open.";
  switch (st.state) {
    case "stopped": return mk("Not started", "idle", "Press Start stream on Overview.");
    case "connecting": return mk("Connecting", "pending");
    case "subscribing": return mk("Subscribing", "pending");
    case "waiting_for_data":
      return st.effective_state === "market_closed"
        ? mk("Subscribed, market closed", "idle")
        : mk("Waiting for data", "pending");
    case "streaming":
      if (st.effective_state === "stale") return mk("Stale", "warn", `No data for ${Math.round(st.data_age_seconds ?? 0)}s.` + linkNote);
      if (st.effective_state === "market_closed") return mk("Market closed", "idle");
      return mk("Streaming", linkOpen ? "ok" : "warn", linkNote.trim());
    case "reconnecting": return mk("Reconnecting", "warn", `${st.reconnect_count} reconnects this run.`);
    case "auth_failed": return mk("Sign-in failed", "bad");
    case "failed": return mk("Stopped after retries", "bad", st.recent_errors[0]?.message ?? "");
  }
}

function deriveMarket(st: StreamStatus): Signal {
  const m = st.market;
  if (m.state === "unknown")
    return { key: "market", label: "Market", value: "Unknown", tone: "idle",
      detail: "Exchange status arrives with the live stream. Hours are never assumed." };
  const label = m.state === "open" ? "Open" : m.state === "closed" ? "Closed" : (m.text ?? "Other");
  return { key: "market", label: "Market", value: label,
    tone: m.state === "open" ? "ok" : "idle", detail: m.text ?? "From the exchange feed." };
}

function streamFallback(status: AppStatus): StreamStatus {
  return {
    implemented: false, state: "stopped", state_since: null, effective_state: "stopped",
    freshness: "none", data_source: "none", phase: "idle", test_subscription_result: "not_run",
    message_count: 0, tick_count: 0, instruments_with_data: 0, subscribed_tokens: 0,
    acknowledged_tokens: 0, reconnect_count: 0, connected_since: null, last_message_at: null,
    last_market_data_at: null, data_age_seconds: null,
    stale_after_seconds: status.snapshot_stale_after_seconds, expiries: [],
    market: { state: "unknown", code: null, text: null, exchange_segment: null, received_at: null, source: "none" },
    recent_errors: [], note: "",
  };
}

/** One line for the top bar: the most important thing the user needs to know right now.
 *  Problems first, then warnings, then whether the numbers are live or from a stored snapshot. */
export function summarize(signals: Signal[]): { label: string; tone: Tone; detail: string } {
  const detail = signals.map((s) => `${s.label}: ${s.value}`).join(" · ");
  const bad = signals.find((s) => s.tone === "bad");
  if (bad) return { label: bad.key === "broker" && bad.value === "Backend offline" ? bad.value : `${bad.label}: ${bad.value}`, tone: "bad", detail };
  const warn = signals.find((s) => s.tone === "warn");
  if (warn) return { label: `${warn.label}: ${warn.value}`, tone: "warn", detail };
  const stream = signals.find((s) => s.key === "stream");
  const data = signals.find((s) => s.key === "freshness");
  if (stream?.tone === "ok" && stream.value === "Streaming") return { label: "Live", tone: "ok", detail };
  if (data) return { label: data.value, tone: data.tone, detail };
  return { label: "Unknown", tone: "idle", detail };
}
