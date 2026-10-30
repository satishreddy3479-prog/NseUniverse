import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import { useStatus } from "../lib/hooks";
import { useStreamStatus } from "../lib/useLive";
import { LiveActivity, StreamButtons } from "../components/LiveActivity";
import { Button, EmptyState, ErrorNote, Field, Panel, Skeleton } from "../components/ui";
import { useEffect, useState } from "react";

const CRED_LABEL: Record<string, string> = {
  kotak_consumer_key: "Consumer key",
  kotak_mobile_number: "Mobile number",
  kotak_ucc: "UCC",
  kotak_mpin: "MPIN",
  kotak_totp_secret: "TOTP secret",
};

const AUTH_LABEL: Record<string, string> = {
  not_attempted: "Not attempted",
  authenticating: "Signing in",
  authenticated: "Signed in",
  failed: "Failed",
};

const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/** Server clock against this browser, and the last run of every background data job as the backend itself reports it. */
function DataPipelines({ serverTime, fetchedAt }: { serverTime: string | undefined; fetchedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const opt = { retry: false, refetchInterval: 60_000 } as const;
  const hist = useQuery({ queryKey: ["diag-history"], queryFn: api.historyStatus, ...opt });
  const flows = useQuery({ queryKey: ["diag-flows"], queryFn: api.flowsStatus, ...opt });
  const news = useQuery({ queryKey: ["diag-news"], queryFn: api.newsStatus, ...opt });
  const store = useQuery({ queryKey: ["diag-storage"], queryFn: api.storageStatus, ...opt });
  // the skew is measured when the status arrives (server clock minus this browser's clock at that moment)
  const skew = serverTime && fetchedAt ? (new Date(serverTime).getTime() - fetchedAt) / 1000 : null;
  type Row = { name: string; state: "ok" | "problem" | "unknown"; detail: string; last: string | null };
  const rows: Row[] = [];
  const h = hist.data, f = flows.data, n = news.data, st = store.data;
  rows.push(h ? { name: "Daily prices and global series", state: (h.last_run?.summary?.failed_symbols.length ?? 0) > 0 ? "problem" : "ok", detail: h.last_run?.summary ? `${h.last_run.summary.new_bars} new bars, ${h.last_run.summary.failed_symbols.length} failed symbol(s), ${h.last_run.summary.disagreements} disagreement(s)${h.running ? " · running now" : ""}` : "no completed run reported", last: h.last_run?.finished_at ?? null } : { name: "Daily prices and global series", state: "unknown", detail: hist.isError ? "status unavailable" : "loading", last: null });
  rows.push(f ? { name: "NSE flows (participants, FII/DII cash)", state: f.blocked || (f.missing_expected?.length ?? 0) > 0 || (f.last_run?.errors ?? 0) > 0 ? "problem" : "ok", detail: f.blocked ? `blocked: ${f.blocked}` : (f.missing_expected?.length ?? 0) > 0 ? `missing for ${f.expected_session}: ${f.missing_expected!.join(", ")}` : `expected session ${f.expected_session ?? "—"} stored`, last: f.last_attempt_utc ?? null } : { name: "NSE flows (participants, FII/DII cash)", state: "unknown", detail: flows.isError ? "status unavailable" : "loading", last: null });
  rows.push(n ? { name: "News tone (GDELT)", state: n.problems.length > 0 ? "problem" : "ok", detail: n.problems.length > 0 ? n.problems.join("; ") : `${n.coverage.days} day(s) collected`, last: n.coverage.last_fetch } : { name: "News tone (GDELT)", state: "unknown", detail: news.isError ? "status unavailable" : "loading", last: null });
  rows.push(st ? { name: "End-of-day archive and backups", state: st.end_of_day.pending_days.length > 0 || st.pressure === "critical" || st.pressure === "low" ? "problem" : "ok", detail: `${st.end_of_day.sessions_archived} session(s) archived · pending ${st.end_of_day.pending_days.length} · disk pressure ${st.pressure} (${st.disk.free_gb} GB free) · last run: ${st.end_of_day.last_result.state}`, last: st.end_of_day.last_attempt_at } : { name: "End-of-day archive and backups", state: "unknown", detail: store.isError ? "status unavailable" : "loading", last: null });
  const tone = { ok: "text-up", problem: "text-down", unknown: "text-muted" } as const;
  return (
    <Panel title="Server clock and data jobs">
      <dl className="mb-3 grid grid-cols-2 gap-4">
        <Field label="Server time">{serverTime ? fmtDateTimeIST(serverTime) : "—"}</Field>
        <Field label="Clock difference to this browser" hint="Market-time logic runs on the server clock; a large difference points at a wrong clock on either side.">
          {skew == null ? "—" : <span className={Math.abs(skew) > 5 ? "text-warn" : "text-up"}>{skew >= 0 ? "+" : "−"}{Math.abs(skew).toFixed(1)} s</span>}
        </Field>
      </dl>
      <ul className="flex flex-col divide-y divide-rule text-sm" data-testid="diag-jobs">
        {rows.map((r) => (
          <li key={r.name} className="grid gap-1 py-2 sm:grid-cols-[220px_90px_1fr_110px]">
            <span className="text-paper">{r.name}</span>
            <span className={`font-medium ${tone[r.state]}`}>{r.state === "ok" ? "No problem reported" : r.state === "problem" ? "Needs a look" : "Unknown"}</span>
            <span className="text-muted">{r.detail}</span>
            <span className="num text-muted sm:text-right">{ago(r.last, now)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Each line is what that job's own status says; this page applies no age limit of its own.</p>
    </Panel>
  );
}

export function Diagnostics() {
  const qc = useQueryClient();
  const status = useStatus();
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const errors = useQuery({ queryKey: ["errors"], queryFn: api.errors, refetchInterval: 10000 });
  const login = useMutation({
    mutationFn: api.login,
    onSettled: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });

  if (status.error) {
    return (
      <ErrorNote title="Backend unreachable"
        message={status.error instanceof ApiError ? status.error.message : "Unknown error"} />
    );
  }
  const st = status.data;
  const streamNow = useStreamStatus().stream;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Connection diagnostics</h1>
        <p className="text-sm text-muted">What the backend knows about each link in the data path. No credentials are shown here.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Broker session"
          actions={
            <Button onClick={() => login.mutate()} disabled={login.isPending || st?.auth.state === "authenticating"}>
              {login.isPending ? "Signing in…" : "Sign in again"}
            </Button>
          }>
          {!st ? <Skeleton className="h-16 w-full" /> : (
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Provider">{st.broker || "—"}</Field>
              <Field label="Authentication">
                <span className={st.auth.state === "failed" ? "text-down" : st.auth.state === "authenticated" ? "text-up" : undefined}>
                  {AUTH_LABEL[st.auth.state] ?? st.auth.state}
                </span>
              </Field>
              <Field label="Last attempt">{fmtDateTimeIST(st.auth.last_attempt_at)}</Field>
              <Field label="Last success">{fmtDateTimeIST(st.auth.last_success_at)}</Field>
              {st.auth.last_error && (
                <div className="col-span-2"><ErrorNote title="Last sign-in error" message={st.auth.last_error} /></div>
              )}
            </dl>
          )}
          {login.error && <div className="mt-3"><ErrorNote title="Sign-in request failed"
            message={login.error instanceof ApiError ? login.error.message : "Unknown error"} /></div>}
        </Panel>

        <Panel title="Snapshot retrieval">
          {!st ? <Skeleton className="h-16 w-full" /> : (
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Captured this session">{st.snapshots.captured_count}</Field>
              <Field label="In progress">{st.snapshots.in_progress ? "Yes" : "No"}</Field>
              <Field label="Last attempt">{fmtDateTimeIST(st.snapshots.last_attempt_at)}</Field>
              <Field label="Last success">{fmtDateTimeIST(st.snapshots.last_success_at)}</Field>
              {st.snapshots.last_error && (
                <div className="col-span-2"><ErrorNote title="Last snapshot error" message={st.snapshots.last_error} /></div>
              )}
            </dl>
          )}
        </Panel>

        <Panel title="Live stream" actions={<StreamButtons />}>
          <LiveActivity />
          {streamNow && streamNow.recent_errors.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 border-t border-rule pt-3 text-sm">
              {streamNow.recent_errors.slice(0, 6).map((e, i) => (
                <li key={i} className="grid gap-1 sm:grid-cols-[170px_1fr]">
                  <span className="num text-muted">{fmtDateTimeIST(e.at)}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Configuration">
          {config.isError ? <ErrorNote title="Configuration is unavailable" message={config.error instanceof ApiError ? config.error.message : "The request failed"} /> : !config.data ? <Skeleton className="h-16 w-full" /> : (
            <div className="flex flex-col gap-3 text-sm">
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1">
                {Object.entries(config.data.credentials_present).map(([k, present]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-muted">{CRED_LABEL[k] ?? k}</span>
                    <span className={present ? "text-up" : "text-down"}>
                      {present ? "Set" : "Not set"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted">
                Backend bound to {config.data.host_is_loopback ? "this computer only" : "a network address"}.
                Strikes per side: {config.data.option_chain_strike_count}.
              </p>
            </div>
          )}
        </Panel>
      </div>

      <DataPipelines serverTime={st?.server_time} fetchedAt={status.dataUpdatedAt} />

      <Panel title="Recent errors">
        {errors.isError ? <ErrorNote title="The error list could not be read" message={errors.error instanceof ApiError ? errors.error.message : "The request failed, so this page cannot say whether there are errors."} />
          : !errors.data ? <Skeleton className="h-10 w-full" />
          : !errors.data.length ? <EmptyState title="No errors this session" /> : (
          <ul className="flex flex-col divide-y divide-rule text-sm">
            {errors.data.map((e, i) => (
              <li key={i} className="grid gap-1 py-2 sm:grid-cols-[180px_120px_1fr]">
                <span className="num text-muted">{fmtDateTimeIST(e.at)}</span>
                <span className="text-muted">{e.component}</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
