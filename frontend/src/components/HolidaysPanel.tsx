import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type HolidaysView } from "../lib/api";
import { daysUntil, isWeekend, mergeRows, parseHolidayText, type HolidayRow } from "../lib/holidays";
import { Button, Panel } from "./ui";

type Kind = "holiday" | "special";
interface Row extends HolidayRow { kind: Kind }

const input = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

const fromView = (v: HolidaysView): Row[] => [
  ...v.user.holidays.map((h) => ({ ...h, kind: "holiday" as const })),
  ...v.user.special_sessions.map((h) => ({ ...h, kind: "special" as const })),
].sort((a, b) => a.date.localeCompare(b.date));

/** The exchange holiday list. The NSE circular part is fixed; this is where the next year's list is added, from the circular, in a minute. */
export function HolidaysPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["holidays"], queryFn: api.holidays, retry: false });
  const v = q.data;
  const [rows, setRows] = useState<Row[]>([]);
  const [coverageTo, setCoverageTo] = useState("");
  const [source, setSource] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!v || loaded) return;
    setRows(fromView(v));
    setCoverageTo(v.user.coverage_to ?? "");
    setSource(v.user.source ?? "");
    setLoaded(true);
  }, [v, loaded]);

  const refEnd = v?.reference.coverage[1] ?? "";
  const effEnd = v?.effective_coverage[1] ?? "";
  const left = effEnd ? daysUntil(effEnd) : null;
  const extending = !!coverageTo && !!refEnd && coverageTo > refEnd;

  const addPasted = () => {
    const parsed = parseHolidayText(paste);
    const good = parsed.filter((p) => p.date && p.name && !p.error && !p.weekend);
    const weekend = parsed.filter((p) => p.weekend).length;
    const bad = parsed.filter((p) => p.error);
    const known = new Set((v?.reference.holidays ?? []).map((h) => h.date));
    const dup = good.filter((p) => known.has(p.date!));
    const fresh = good.filter((p) => !known.has(p.date!));
    setRows((cur) => {
      const merged = mergeRows(cur.filter((r) => r.kind === "holiday"), fresh.map((p) => ({ date: p.date!, name: p.name! })));
      return [...merged.map((r) => ({ ...r, kind: "holiday" as const })), ...cur.filter((r) => r.kind === "special")].sort((a, b) => a.date.localeCompare(b.date));
    });
    // the covered period follows the newest date unless the user already chose one
    if (fresh.length && !coverageTo) setCoverageTo(`${fresh.map((p) => p.date!).sort().at(-1)!.slice(0, 4)}-12-31`);
    const parts = [`${fresh.length} holiday${fresh.length === 1 ? "" : "s"} added`];
    if (weekend) parts.push(`${weekend} on a weekend skipped (weekends are never sessions)`);
    if (dup.length) parts.push(`${dup.length} already in the NSE list skipped`);
    if (bad.length) parts.push(`${bad.length} line${bad.length === 1 ? "" : "s"} not understood: ${bad.slice(0, 3).map((b) => `“${b.raw.slice(0, 40)}” (${b.error})`).join("; ")}${bad.length > 3 ? "…" : ""}`);
    setNote({ ok: bad.length === 0, text: parts.join(" · ") + "." });
    if (!bad.length) setPaste("");
  };

  const save = useMutation({
    mutationFn: () => api.putHolidays({
      coverage_to: coverageTo, source, confirm_complete: confirm,
      holidays: rows.filter((r) => r.kind === "holiday").map(({ date, name }) => ({ date, name })),
      special_sessions: rows.filter((r) => r.kind === "special").map(({ date, name }) => ({ date, name })),
    }),
    onSuccess: (view) => {
      qc.setQueryData(["holidays"], view);
      void qc.invalidateQueries({ queryKey: ["market-session"] });
      void qc.invalidateQueries({ queryKey: ["ops-alerts"] });
      setRows(fromView(view)); setConfirm(false);
      setNote({ ok: true, text: `Saved. The app now treats ${view.effective_coverage[0]} to ${view.effective_coverage[1]} as covered.` });
    },
    onError: (e) => setNote({ ok: false, text: e instanceof ApiError ? e.message : "Could not save." }),
  });

  const dirty = useMemo(() => {
    if (!v) return false;
    const a = JSON.stringify(fromView(v).map(({ date, name, kind }) => [date, name, kind]));
    const b = JSON.stringify(rows.map(({ date, name, kind }) => [date, name, kind]));
    return a !== b || coverageTo !== (v.user.coverage_to ?? "") || source !== (v.user.source ?? "");
  }, [v, rows, coverageTo, source]);

  const setRow = (i: number, patch: Partial<Row>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Panel title="Exchange holidays">
      {q.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {q.isError && <p role="alert" className="text-sm text-warn">The holiday list could not be read from the server.</p>}
      {v && (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted" data-testid="holiday-summary">
            The NSE circular list covers <span className="num text-paper">{v.reference.coverage[0]}</span> to <span className="num text-paper">{refEnd}</span> ({v.reference.holidays.length} weekday holidays, read-only).
            {v.user.coverage_to ? <> Your additions extend it to <span className="num text-paper">{v.user.coverage_to}</span>.</> : null}
            {" "}After the covered period the app has no holiday information and treats every weekday as a session.
          </p>
          {left !== null && left < 60 && (
            <p role="status" className={`rounded-sm border px-3 py-2 ${left < 14 ? "border-down bg-down/10" : "border-warn bg-warn/10"}`} data-testid="holiday-warning">
              The list ends on {effEnd} ({Math.max(left, 0)} day{left === 1 ? "" : "s"}). NSE publishes next year’s holiday circular in December: paste its dates below.
            </p>
          )}

          <div>
            <label htmlFor="holiday-paste" className="mb-1 block text-muted">Paste the holidays from NSE’s circular (one per line, e.g. “26-Jan-2027 Tuesday Republic Day” or “2027-01-26 Republic Day”)</label>
            <textarea id="holiday-paste" value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} className={`${input} w-full py-2`} placeholder={"26-Jan-2027  Tuesday  Republic Day\n26-Mar-2027  Friday  Good Friday"} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button onClick={addPasted} disabled={!paste.trim()}>Add these lines</Button>
              <Button onClick={() => setRows((cur) => [...cur, { date: "", name: "", kind: "holiday" }])}>Add one by hand</Button>
            </div>
          </div>

          {rows.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="holiday-rows" aria-label="Holidays you added">
              {rows.map((r, i) => (
                <li key={`${r.date}-${i}`} className="flex flex-wrap items-center gap-2">
                  <input type="date" aria-label={`Date of entry ${i + 1}`} value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} className={`${input} num`} />
                  <input type="text" aria-label={`Name of entry ${i + 1}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} maxLength={80} className={`${input} min-w-[10rem] flex-1`} />
                  <select aria-label={`Type of entry ${i + 1}`} value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as Kind })} className={input}>
                    <option value="holiday">Holiday (no session)</option>
                    <option value="special">Special session (e.g. Muhurat)</option>
                  </select>
                  {r.date && r.kind === "holiday" && isWeekend(r.date) && <span className="text-[11px] text-warn">weekend: not needed</span>}
                  <button type="button" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))} className="min-h-9 rounded-sm border border-rule px-2 text-muted hover:text-down" aria-label={`Remove entry ${i + 1}`}>Remove</button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="holiday-to" className="mb-1 block text-muted">Covered up to</label>
              <input id="holiday-to" type="date" value={coverageTo} onChange={(e) => setCoverageTo(e.target.value)} className={`${input} num w-full`} />
            </div>
            <div>
              <label htmlFor="holiday-source" className="mb-1 block text-muted">Source (the circular’s number and date)</label>
              <input id="holiday-source" type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="NSE circular NSE/CMTR/… dated 12 Dec 2026" className={`${input} w-full`} />
            </div>
          </div>
          {extending && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-1" />
              <span>I entered every trading holiday of the circular up to {coverageTo}. A missing holiday would be treated as a normal trading day.</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => { setNote(null); save.mutate(); }} disabled={save.isPending || !dirty || !coverageTo}>{save.isPending ? "Saving…" : "Save holidays"}</Button>
            {note && <span role={note.ok ? "status" : "alert"} className={note.ok ? "text-up" : "text-down"} data-testid="holiday-note">{note.text}</span>}
          </div>

          <details>
            <summary className="cursor-pointer text-muted">The NSE circular list ({v.reference.holidays.length} holidays, read-only)</summary>
            <ul className="mt-2 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {v.reference.holidays.map((h) => <li key={h.date}><span className="num">{h.date}</span> <span className="text-muted">{h.name}</span></li>)}
            </ul>
          </details>
        </div>
      )}
    </Panel>
  );
}
