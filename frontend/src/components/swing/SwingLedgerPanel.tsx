import { useQuery } from "@tanstack/react-query";
import { Panel } from "../ui";
import { api } from "../../lib/api";
import { fmtInt, fmtPrice } from "../../lib/format";
import { fmtStamp, signedRupees } from "../../lib/swing";
import type { LedgerFill, SwingLedger } from "../../lib/types";
import { TABLE_WRAP, TD, TD_L, THEAD } from "./shared";

const TH_L = "px-2 py-1.5 text-left font-medium";
const TH_R = "px-2 py-1.5 text-right font-medium";

/** What a fill's reconciliation with the evening settlement says, in words. */
export function reconLabel(f: LedgerFill): string {
  if (f.recon === "pending") return "Awaiting tonight's official decision";
  if (f.recon === "confirmed") return `Confirmed: official fill ${f.official_fill == null ? "—" : fmtPrice(f.official_fill)} × ${f.official_shares ?? "—"}${f.price_gap ? ` (price gap ${f.price_gap > 0 ? "+" : "−"}${Math.abs(f.price_gap).toFixed(2)})` : ""}`;
  return f.recon_reason ?? "Rejected by the official book";
}

export function SwingLedgerPanel() {
  const q = useQuery({ queryKey: ["swing-live-fills"], queryFn: api.swingLiveFills, refetchInterval: 5_000, retry: false });
  const d: SwingLedger | undefined = q.data;
  return (
    <Panel title="Live paper ledger" actions={<span className="rounded-sm border border-warn/50 px-1.5 py-px text-[11px] text-warn">Provisional</span>}>
      <div role="note" className="mb-3 rounded-sm border border-info/40 bg-info/10 px-3 py-2 text-sm" data-testid="ledger-note">
        <p className="font-medium text-paper">Separate from the official paper book</p>
        <p className="mt-1 text-muted">
          When an order&apos;s entry rule holds on fresh live prices on two readings in a row, a paper buy is recorded here at the price the evening run would use
          (the larger of the day&apos;s open and the trigger), sized from this ledger&apos;s own equity. Tonight&apos;s run then decides the same order on the whole
          day: each live buy is marked confirmed or rejected with the official reason (a rejected one is closed at its last live price and kept, marked void).
          The official book, its trades and its equity are never changed by anything on this panel.
        </p>
      </div>
      {q.isPending && <p className="text-sm text-muted">Reading the live ledger…</p>}
      {q.isError && <p role="alert" className="text-sm text-down" data-testid="ledger-error">Could not read the live ledger: {q.error instanceof Error ? q.error.message : "unknown error"}</p>}
      {d && !d.enabled && <p className="mb-2 text-sm text-warn" data-testid="ledger-off">Live paper fills are switched off in the server settings (swing_live_fills_enabled), so no new fills are made. Earlier ones are listed below.</p>}
      {d && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6" data-testid="ledger-stats">
            {([["Live equity", fmtInt(Math.round(d.equity))], ["Cash", fmtInt(Math.round(d.cash))], ["Open fills", String(d.open)], ["Closed fills", String(d.closed)],
              ["Realised P&L", signedRupees(d.realised_pnl)], ["Reconciled", `${d.reconciliation.confirmed} confirmed · ${d.reconciliation.rejected} rejected · ${d.reconciliation.pending} awaiting`]] as const).map(([l, v]) => (
              <div key={l} className="rounded-sm bg-slate-2 p-2"><div className="text-[11px] text-muted">{l}</div><div className="num text-paper">{v}</div></div>
            ))}
          </div>
          {d.fills.length === 0 ? <p className="text-sm text-muted" data-testid="ledger-empty">No live paper fill yet. A fill needs an order that reads triggered on a fresh price after 09:45, volume on pace, the feed streaming, a free slot and no cooldown.</p> : (
            <div className={TABLE_WRAP}>
              <table className="w-full min-w-[56rem] text-sm" data-testid="ledger-table">
                <thead className={THEAD}><tr><th className={TH_L}>Bought</th><th className={TH_L}>Stock</th><th className={TH_R}>Price</th><th className={TH_R}>Shares</th><th className={TH_R}>Now / exit</th><th className={TH_R}>P&L</th><th className={TH_L}>Status</th><th className={TH_L}>Official book</th></tr></thead>
                <tbody>
                  {[...d.fills].reverse().map((f) => {
                    const pnl = f.status === "closed" ? f.pnl : f.unrealised;
                    return (
                      <tr key={f.id} className="border-t border-rule" data-testid="ledger-row" title={f.evidence}>
                        <td className={TD_L}>{fmtStamp(f.filled_at)}</td><td className={`${TD_L} font-medium text-paper`}>{f.symbol}</td>
                        <td className={TD}>{fmtPrice(f.price)}</td><td className={TD}>{fmtInt(f.shares)}</td>
                        <td className={TD}>{fmtPrice(f.status === "closed" ? f.exit_price : f.last_price)}</td>
                        <td className={`${TD} ${pnl == null ? "" : pnl >= 0 ? "text-up" : "text-down"}`}>{pnl == null ? "—" : signedRupees(pnl)}{f.status === "open" ? " (open)" : ""}</td>
                        <td className={TD_L}>{f.status === "open" ? "Open" : `Closed: ${f.exit_reason ?? ""}`}</td>
                        <td className={`${TD_L} ${f.recon === "rejected" ? "text-warn" : f.recon === "confirmed" ? "text-up" : "text-muted"}`} data-testid="ledger-recon">{reconLabel(f)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
