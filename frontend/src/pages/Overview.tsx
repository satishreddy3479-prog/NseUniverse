import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { ageSeconds, fmtAge, fmtDateTimeIST, fmtExpiry, fmtInt, fmtPrice, fmtTimeIST } from "../lib/format";
import { useExpiries, useNow, useSnapshots, useStatus } from "../lib/hooks";
import type { SnapshotSummary } from "../lib/types";
import { LiveActivity, StreamButtons } from "../components/LiveActivity";
import { INDEX_KEY } from "../components/SpotBadge";
import { useLiveTick, useStreamStatus } from "../lib/useLive";
import {
  Button, CompletenessText, EmptyState, ErrorNote, Field, Panel, Skeleton, SourceTag, Unavailable,
} from "../components/ui";

function latestFor(list: SnapshotSummary[] | undefined, expiry: string | null | undefined) {
  return expiry ? list?.find((s) => s.expiry === expiry) : undefined;
}

export function Overview() {
  const now = useNow();
  const qc = useQueryClient();
  const status = useStatus();
  const expiries = useExpiries();
  const snapshots = useSnapshots();

  const capture = useMutation({
    mutationFn: api.capture,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["snapshots"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const exp = expiries.data;
  const weeklySnap = latestFor(snapshots.data, exp?.weekly);
  const monthlySnap = latestFor(snapshots.data, exp?.monthly);
  const staleAfter = status.data?.snapshot_stale_after_seconds ?? 300;
  const spotSnap = snapshots.data?.find((s) => s.underlying_ltp != null);
  const spotTick = useLiveTick(INDEX_KEY);
  const streaming = useStreamStatus().stream?.state === "streaming";
  const liveSpot = streaming && spotTick?.ltp != null ? spotTick : undefined;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-muted">
            Selected expiries, the latest option-chain snapshots and what the backend is doing.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => capture.mutate()}
          disabled={capture.isPending || !exp}
          title="Fetch weekly and monthly option chains from the backend's data source now"
        >
          {capture.isPending ? "Capturing…" : "Capture snapshot"}
        </Button>
      </div>

      {capture.error && (
        <ErrorNote
          title="Snapshot capture failed"
          message={capture.error instanceof ApiError ? capture.error.message : "Unknown error"}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Underlying and expiries" className="lg:col-span-2"
          actions={exp && <SourceTag source={exp.source} />}>
          {expiries.isLoading ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>
          ) : expiries.error ? (
            <ErrorNote title="Could not load expiries"
              message={expiries.error instanceof ApiError ? expiries.error.message : "Unknown error"} />
          ) : exp ? (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                <Field label="Underlying">{exp.underlying} 50</Field>
                <Field
                  label="Underlying price"
                  hint={liveSpot ? `Live, received ${fmtTimeIST(liveSpot.received_at)}` : spotSnap ? `From snapshot ${fmtDateTimeIST(spotSnap.retrieved_at)}, not live` : undefined}
                >
                  {liveSpot ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {fmtPrice(liveSpot.ltp)} <SourceTag source="live" />
                    </span>
                  ) : spotSnap && spotSnap.underlying_ltp != null ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {fmtPrice(spotSnap.underlying_ltp)} <SourceTag source={spotSnap.source} />
                    </span>
                  ) : (
                    <Unavailable reason="No snapshot with an index price yet" />
                  )}
                </Field>
                <Field label="Weekly expiry">{fmtExpiry(exp.weekly)}</Field>
                <Field
                  label="Monthly expiry"
                  hint={exp.monthly_is_next_month ? "Next month: no expiry left this month" : undefined}
                >
                  {fmtExpiry(exp.monthly)}
                </Field>
              </dl>
              {exp.weekly_equals_monthly && (
                <p className="mt-3 text-sm text-info">
                  Weekly and monthly resolve to the same date, so one chain covers both.
                </p>
              )}
              {exp.warnings.length > 0 && (
                <ul className="mt-3 list-disc pl-5 text-sm text-warn">
                  {exp.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted">
                {exp.available.length} listed expiries, resolved {fmtDateTimeIST(exp.retrieved_at)}.
              </p>
            </>
          ) : null}
        </Panel>

        <Panel title="Live activity" actions={<StreamButtons />}>
          <LiveActivity compact />
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(["weekly", "monthly"] as const).map((kind) => {
          const date = kind === "weekly" ? exp?.weekly : exp?.monthly;
          const snap = kind === "weekly" ? weeklySnap : monthlySnap;
          const age = ageSeconds(snap?.retrieved_at, now);
          const stale = snap && age != null && age > staleAfter;
          return (
            <Panel key={kind} title={`${kind === "weekly" ? "Weekly" : "Monthly"} chain, latest snapshot`}
              actions={snap && <SourceTag source={snap.source} />}>
              {snapshots.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : !snap ? (
                <EmptyState title={date ? `No snapshot for ${fmtExpiry(date)} yet` : "No expiry selected"}>
                  Use Capture snapshot to fetch this chain.
                </EmptyState>
              ) : (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <Field label="Expiry">{fmtExpiry(snap.expiry)}</Field>
                  <Field label="CE contracts">{fmtInt(snap.ce_count)}</Field>
                  <Field label="PE contracts">{fmtInt(snap.pe_count)}</Field>
                  <Field label="Retrieved">{fmtDateTimeIST(snap.retrieved_at)}</Field>
                  <Field label="Age">
                    <span className={stale ? "text-warn" : undefined}>
                      {fmtAge(age)}{stale ? ", stale" : ""}
                    </span>
                  </Field>
                  <Field label="Chain"><CompletenessText value={snap.completeness} /></Field>
                </dl>
              )}
            </Panel>
          );
        })}
      </div>

      <Panel title="Recent snapshots">
        {snapshots.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !snapshots.data?.length ? (
          <EmptyState title="No snapshots stored">Captured snapshots are listed here.</EmptyState>
        ) : (
          <SnapshotTable rows={snapshots.data.slice(0, 8)} />
        )}
      </Panel>
    </div>
  );
}

export function SnapshotTable({ rows, selected }: { rows: SnapshotSummary[]; selected?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-rule">
            <th className="py-2 pr-4 font-medium">Retrieved (IST)</th>
            <th className="py-2 pr-4 font-medium">Expiry</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 text-right font-medium">Strikes</th>
            <th className="py-2 pr-4 font-medium">Chain</th>
            <th className="py-2 pr-4 font-medium">Source</th>
            <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((s) => (
            <tr key={s.snapshot_id}
              className={`border-b border-rule/60 ${selected === s.snapshot_id ? "bg-brass/10" : ""}`}>
              <td className="py-2 pr-4">{fmtDateTimeIST(s.retrieved_at)}</td>
              <td className="py-2 pr-4">{fmtExpiry(s.expiry)}</td>
              <td className="py-2 pr-4 capitalize text-muted">{s.expiry_kinds.join(" + ") || "manual"}</td>
              <td className="py-2 pr-4 text-right">{s.strikes}</td>
              <td className="py-2 pr-4"><CompletenessText value={s.completeness} /></td>
              <td className="py-2 pr-4"><SourceTag source={s.source} /></td>
              <td className="py-2 text-right">
                <Link className="text-info underline-offset-2 hover:underline"
                  to={`/data?snapshot=${encodeURIComponent(s.snapshot_id)}`}>
                  Inspect
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
