import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import { useStatus } from "../lib/hooks";
import { useStreamStatus } from "../lib/useLive";
import { LiveActivity, StreamButtons } from "../components/LiveActivity";
import { Button, EmptyState, ErrorNote, Field, Panel, Skeleton } from "../components/ui";

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
              <Field label="Provider">Kotak Neo</Field>
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
          {!config.data ? <Skeleton className="h-16 w-full" /> : (
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

      <Panel title="Recent errors">
        {!errors.data?.length ? <EmptyState title="No errors this session" /> : (
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
