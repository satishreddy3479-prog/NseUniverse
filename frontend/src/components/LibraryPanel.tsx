import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { fmtDateTimeIST, MISSING } from "../lib/format";
import { downloadBundle, type DataCoverage, type DownloadStep, type LibBundle, LibraryError, libraryApi, mb } from "../lib/library";
import { Loading } from "./Loading";

const STEP: Record<DownloadStep, string> = { downloading: "Downloading…", checking: "Checking the file…", saving: "Saving…", confirming: "Confirming…" };
const btn = "min-h-9 rounded-sm border border-rule bg-slate-2 px-3 text-xs text-paper hover:border-brass disabled:opacity-50";
const msg = (e: unknown) => (e instanceof LibraryError || e instanceof Error ? e.message : "Something went wrong.");

/**
 * The data library: the system bundles the snapshot files that are about to age out into zip files by itself; here they are downloaded (the page checks the file against the
 * server's checksum, and only then does the server count a copy as existing off the server), restored temporarily for a backtest, and listed per session.
 */
export function LibraryPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["library"], queryFn: libraryApi.status, refetchInterval: 60_000, retry: false });
  const [busy, setBusy] = useState<Record<number, DownloadStep | "error">>({});
  const [err, setErr] = useState<Record<number, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [range, setRange] = useState({ start: "", end: "" });
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["library"] });

  const download = async (b: LibBundle) => {
    setErr((e) => ({ ...e, [b.id]: "" }));
    try {
      const r = await downloadBundle(b, (s) => setBusy((x) => ({ ...x, [b.id]: s })));
      setNote(`${b.name} downloaded and checked. The server has deleted the bundle and ${r.released_files} snapshot files (${mb(r.released_bytes)}); the archive and the database stay.`);
    } catch (e) {
      setErr((x) => ({ ...x, [b.id]: msg(e) }));
    } finally {
      setBusy((x) => { const { [b.id]: _gone, ...rest } = x; return rest; });
      void refresh();
    }
  };
  const act = useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: () => void refresh(),
    onError: (e) => setNote(msg(e)),
  });

  if (q.isPending) return <Loading label="Loading the data library…" />;
  if (q.isError) {
    const off = q.error instanceof LibraryError && q.error.code === "disabled";
    return <p role="alert" className="rounded-sm border border-rule p-3 text-sm text-muted" data-testid="lib-error">{off ? "The data library is turned off on this server." : `The data library could not be loaded: ${msg(q.error)}`}</p>;
  }
  const s = q.data;
  const bundles = s.bundles;
  const pending = bundles.filter((b) => !b.downloaded && b.on_server);
  const total = bundles.reduce((a, b) => a + b.bytes, 0);
  const downloadAll = async () => { for (const b of pending) await download(b); };

  return (
    <div className="flex flex-col gap-3" data-testid="library">
      <p className="text-xs text-muted" data-testid="lib-explain">
        Every {s.policy.block_days} days of snapshot files the system zips into one bundle by itself, checks it, and tells you in the heads-up strip. Download it: the page checks the file, and only then does the server
        delete the bundle and those days' snapshot files. The archive and the database keep all the research data forever, so backtests never need the bundle. For old snapshot files, restore a bundle temporarily
        (it removes itself after {s.policy.restore_ttl_hours} hours).
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="lib-tiles">
        <div className="rounded-sm border border-rule/60 bg-slate-2 p-2"><div className="text-[11px] text-muted">Bundles on the server</div><div className="num text-base font-semibold">{bundles.length}</div><div className="text-[11px] text-muted">{mb(total)}</div></div>
        <div className={`rounded-sm border p-2 ${s.unconfirmed_bundles > 0 ? "border-warn/60 bg-warn/10" : "border-rule/60 bg-slate-2"}`}><div className="text-[11px] text-muted">Not downloaded yet</div><div className={`num text-base font-semibold ${s.unconfirmed_bundles > 0 ? "text-warn" : ""}`}>{s.unconfirmed_bundles}</div><div className="text-[11px] text-muted">{s.unconfirmed_bundles > 0 ? "no copy off the server" : "every bundle has a copy"}</div></div>
        <div className="rounded-sm border border-rule/60 bg-slate-2 p-2"><div className="text-[11px] text-muted">Next bundle</div><div className="num text-base font-semibold">{s.next_block ? (s.next_block.ready ? "now" : `in ${s.next_block.days_left} day${s.next_block.days_left === 1 ? "" : "s"}`) : MISSING}</div><div className="text-[11px] text-muted">{s.next_block ? `${s.next_block.start} → ${s.next_block.end} · ${s.next_block.days} days so far` : "no snapshot files waiting"}</div></div>
        <div className="rounded-sm border border-rule/60 bg-slate-2 p-2"><div className="text-[11px] text-muted">Disk free</div><div className="num text-base font-semibold">{s.disk_free_gb} GB</div><div className="text-[11px] text-muted">last automatic step: {s.last_auto.state ?? MISSING}</div></div>
      </div>
      {note && <p role="status" className="rounded-sm border border-rule bg-slate-2 px-3 py-2 text-xs text-paper" data-testid="lib-note">{note}</p>}

      <section aria-label="Bundles">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Bundles</h3>
          {pending.length > 1 && <button type="button" className={btn} onClick={downloadAll} data-testid="lib-download-all">Download all {pending.length} not yet downloaded</button>}
        </div>
        {bundles.length === 0 ? <p className="mt-2 text-sm text-muted" data-testid="lib-no-bundles">No bundle waiting. The next one is made automatically when the {s.policy.block_days}-day block that is filling up has ended.</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-xs">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Days</th><th className="font-normal">Size</th><th className="font-normal">Made</th><th className="font-normal">Copy off the server</th><th /></tr></thead>
              <tbody>
                {bundles.map((b) => (
                  <tr key={b.id} className="border-t border-rule/50 align-top" data-testid={`lib-bundle-${b.id}`}>
                    <td className="py-1.5"><div className="font-medium text-paper">{b.start_day} → {b.end_day}</div><div className="text-[11px] text-muted">{b.days.length} days · {b.files} files · {b.origin === "auto" ? "made automatically" : b.origin === "found" ? "found on disk" : "made by you"}</div></td>
                    <td className="num">{mb(b.bytes)}</td>
                    <td className="text-muted">{fmtDateTimeIST(b.created_utc)}</td>
                    <td>{b.downloaded ? <span className="text-up">✓ downloaded and checked{b.confirmed_utc ? ` ${fmtDateTimeIST(b.confirmed_utc)}` : ""}</span> : <span className="text-warn">not downloaded</span>}{err[b.id] && <div role="alert" className="mt-1 text-down" data-testid={`lib-error-${b.id}`}>{err[b.id]}</div>}</td>
                    <td className="space-x-1 whitespace-nowrap py-1 text-right">
                      <button type="button" className={btn} disabled={!b.on_server || !!busy[b.id]} onClick={() => void download(b)} aria-label={`Download ${b.name}`}>{busy[b.id] && busy[b.id] !== "error" ? STEP[busy[b.id] as DownloadStep] : b.downloaded ? "Download again" : "Download"}</button>
                      <button type="button" className={btn} disabled={!b.on_server || act.isPending} onClick={() => act.mutate(async () => { const r = await libraryApi.restore(b.id); setNote(`Restored ${r.days.length} days (${mb(r.bytes)}) for ${s.policy.restore_ttl_hours} hours.`); })} aria-label={`Restore ${b.name}`}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <label className="text-muted">From<input type="date" aria-label="Bundle from" className="ml-1 min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} /></label>
          <label className="text-muted">To<input type="date" aria-label="Bundle to" className="ml-1 min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} /></label>
          <button type="button" className={btn} disabled={!range.start || !range.end || act.isPending} onClick={() => act.mutate(async () => { const b = await libraryApi.build(range.start, range.end); setNote(`Made ${b.name} (${mb(b.bytes)}).`); })}>Make a bundle of these days</button>
        </div>
      </section>

      <section aria-label="Temporary restores">
        <h3 className="text-sm font-semibold">Temporary restores</h3>
        <p className="text-xs text-muted">A restore unpacks a bundle into a scratch folder (never into the live data) so the Data page and tests can read the old files. It expires by itself; up to {s.policy.restore_max_mb} MB.</p>
        {s.restores.length === 0 ? <p className="mt-1 text-sm text-muted" data-testid="lib-no-restores">Nothing is restored now.</p> : (
          <ul className="mt-1 space-y-1" data-testid="lib-restores">
            {s.restores.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-sm border border-rule/60 bg-slate-2 p-2 text-xs">
                <span className="font-medium text-paper">{r.days[0]} → {r.days[r.days.length - 1]}</span><span className="text-muted">{r.days.length} days · {mb(r.bytes)} · expires {fmtDateTimeIST(r.expires_utc)}</span>
                <button type="button" className={`${btn} ml-auto`} onClick={() => act.mutate(async () => { await libraryApi.keepRestore(r.id); setNote("Kept for 7 days."); })}>Keep 7 days</button>
                <button type="button" className={btn} onClick={() => act.mutate(async () => { await libraryApi.removeRestore(r.id); setNote("Restore removed."); })}>Remove now</button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input ref={file} type="file" accept=".zip,application/zip" aria-label="Bundle file to restore" className="text-xs" />
          <button type="button" className={btn} disabled={act.isPending} onClick={() => { const f = file.current?.files?.[0]; if (f) act.mutate(async () => { const r = await libraryApi.upload(f); setNote(`Restored ${r.days.length} days (${mb(r.bytes)}) from ${f.name}.`); }); else setNote("Choose a bundle file first."); }}>Restore from a file on this computer</button>
        </div>
      </section>

      <details data-testid="lib-sessions">
        <summary className="cursor-pointer text-sm font-semibold">Every stored session ({s.sessions.length})</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-xs">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Session</th><th className="text-right font-normal">Samples</th><th className="font-normal">Archive</th><th className="text-right font-normal">Snapshot files</th><th className="font-normal">Where the files are</th><th className="font-normal">Copy off the server</th></tr></thead>
            <tbody>
              {s.sessions.map((r) => (
                <tr key={r.day} className="border-t border-rule/40">
                  <td className="py-1">{r.day}</td>
                  <td className="num text-right">{r.samples ?? MISSING}{r.samples != null && !r.complete ? " (partial)" : ""}</td>
                  <td>{r.archive ? "✓" : MISSING}</td>
                  <td className="num text-right">{r.snapshot_files > 0 ? `${r.snapshot_files} · ${mb(r.snapshot_bytes)}` : MISSING}</td>
                  <td>{r.state}{r.restored ? " · restored now" : ""}</td>
                  <td>{r.exported ? <span className="text-up">✓</span> : r.bundle ? <span className="text-warn">in a bundle, not downloaded</span> : <span className="text-muted">not bundled yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Shown on a backtest page: whether the sessions the test read are all there (the library's check). Says nothing when they are. */
export function DataCoverageNote({ coverage }: { coverage: DataCoverage | undefined }) {
  if (!coverage || coverage.ok) return null;
  return (
    <p role="status" className="rounded-sm border border-warn/60 bg-warn/10 px-3 py-2 text-xs text-warn" data-testid="data-coverage">
      Data check: {coverage.message}.{coverage.observations_missing.length > 0 && ` Sessions: ${coverage.observations_missing.join(", ")}.`}
    </p>
  );
}
