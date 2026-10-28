import { ApiError } from "./api";
import { fmtExpiry } from "./format";
import { useExpiries, useNow, useSnapshots, useStatus } from "./hooks";
import { deriveSignals, type Signal } from "./signals";
import { useStreamStatus } from "./useLive";
import type { SnapshotSummary } from "./types";

/** The status signals, shared by the top bar (one summary) and Settings (the full list). */
export function useSignals(): {
  signals: Signal[];
  latest: SnapshotSummary | undefined;
  underlying: string;
  expiryText: string;
} {
  const now = useNow();
  const status = useStatus();
  const live = useStreamStatus();
  const expiries = useExpiries();
  const snapshots = useSnapshots();
  const backendDown = status.error instanceof ApiError && status.error.status === 0;
  const latest = snapshots.data?.[0];
  const signals = deriveSignals(status.data, backendDown, latest, now, live);
  const exp = expiries.data;
  const expiryText = exp
    ? exp.weekly_equals_monthly
      ? `Weekly = monthly ${fmtExpiry(exp.weekly)}`
      : `Weekly ${fmtExpiry(exp.weekly)}, monthly ${fmtExpiry(exp.monthly)}`
    : expiries.isLoading
      ? "Loading expiries"
      : "Expiries unavailable";
  return { signals, latest, underlying: status.data?.underlying ?? "NIFTY", expiryText };
}
