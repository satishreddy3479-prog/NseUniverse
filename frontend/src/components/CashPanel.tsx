import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import { fmtInt } from "../lib/format";
import { Button, Panel } from "./ui";

const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "");

/** FII/DII cash-market activity: the newest 7 sessions only. NSE refuses automated downloads of this feed,
 *  so it is filled from the CSV you download from NSE's FII/DII report page. */
export function CashPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cash"], queryFn: api.flowsCash, retry: false });
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const imp = useMutation({
    mutationFn: (csv: string) => api.importCash(csv),
    onSuccess: (r) => { setMsg({ ok: true, text: `Read ${r.rows} rows, ${r.added} new, ${r.removed_old} older rows removed; keeping ${r.sessions_kept} sessions.` }); setText(""); void qc.invalidateQueries({ queryKey: ["cash"] }); },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Import failed" }),
  });
  const days = [...new Set(q.data?.rows.map((r) => r.session) ?? [])];
  const get = (d: string, c: string) => q.data?.rows.find((r) => r.session === d && r.category.toUpperCase().startsWith(c));
  return (
    <Panel title="FII / DII cash activity — newest 7 sessions (₹ crore)">
      <div className="space-y-3">
        {q.isPending ? <p className="text-sm text-muted">Loading…</p>
          : q.error ? <p className="text-sm text-muted">Not available: the running backend does not have this module yet.</p>
          : days.length === 0 ? <p className="text-sm text-muted" data-testid="cash-empty">No cash-market data yet. NSE does not allow automated downloads of this feed. Download the CSV from NSE’s FII/DII report page and paste its contents below.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="FII DII cash">
                <thead className="text-xs text-muted"><tr><th className="text-left font-normal">Session</th><th className="text-right font-normal">FII buy</th><th className="text-right font-normal">FII sell</th><th className="text-right font-normal">FII net</th><th className="text-right font-normal">DII net</th><th className="text-right font-normal">Total net</th></tr></thead>
                <tbody>
                  {days.map((d) => {
                    const f = get(d, "FII"), di = get(d, "DII");
                    const tot = (f?.net ?? 0) + (di?.net ?? 0);
                    return (
                      <tr key={d} className="num border-t border-rule/50">
                        <td>{d}</td><td className="text-right">{f ? fmtInt(f.buy) : "—"}</td><td className="text-right">{f ? fmtInt(f.sell) : "—"}</td>
                        <td className={`text-right ${f ? tone(f.net) : ""}`}>{f ? fmtInt(f.net) : "—"}</td><td className={`text-right ${di ? tone(di.net) : ""}`}>{di ? fmtInt(di.net) : "—"}</td>
                        <td className={`text-right ${f && di ? tone(tot) : ""}`}>{f && di ? fmtInt(tot) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <details>
          <summary className="cursor-pointer text-sm text-info">Import from an NSE CSV</summary>
          <div className="mt-2 space-y-2">
            <textarea aria-label="NSE FII DII CSV" value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Category,Date,Buy Value,Sell Value,Net Value&#10;DII,28-Oct-2026,…" className="num w-full rounded-lg border border-rule bg-ink/60 p-2 text-xs" />
            <div className="flex items-center gap-3">
              <Button disabled={!text.trim() || imp.isPending} onClick={() => imp.mutate(text)}>Import</Button>
              {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
            </div>
            <p className="text-xs text-muted">Only the newest 7 sessions are kept; each time you import, older sessions are removed. Every row must satisfy buy − sell = net, otherwise the whole file is rejected and nothing is stored.</p>
          </div>
        </details>
      </div>
    </Panel>
  );
}
