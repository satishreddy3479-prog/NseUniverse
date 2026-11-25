import { MISSING } from "../../lib/format";
import type { PreflightGate, PreflightRadar, StraddleDecay } from "../../lib/straddleDecay";

const LOT = 65;
const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const pts = (v: number | null | undefined) => (v == null ? MISSING : v.toFixed(1));
const rupees = (v: number) => `₹${Math.round(Math.abs(v) * LOT).toLocaleString("en-IN")}`;

const BADGE = {
  GREEN: { box: "border-up bg-up/15 text-up", icon: "🟢" },
  YELLOW: { box: "border-brass bg-brass/15 text-brass", icon: "🟡" },
  RED: { box: "border-down bg-down/15 text-down", icon: "🛑" },
  GREY: { box: "border-rule bg-slate-2 text-muted", icon: "⚪" },
} as const;

const STATUS = {
  PASS: { label: "PASS", cls: "bg-up/15 text-up" },
  FAIL: { label: "FAIL", cls: "bg-down/15 text-down" },
  WARN: { label: "WARN", cls: "bg-brass/15 text-brass" },
  UNKNOWN: { label: "NO DATA", cls: "bg-slate-2 text-muted" },
} as const;

function Gate({ title, gate, value, testid, extra }: { title: string; gate: PreflightGate | undefined; value: string; testid: string; extra?: string[] }) {
  const st = STATUS[gate?.status ?? "UNKNOWN"];
  return (
    <div className="min-w-0 rounded-sm border border-rule/60 bg-slate-2 px-2.5 py-2" data-testid={testid}>
      <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-muted">{title}</span><span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`} data-testid={`${testid}-status`}>{st.label}</span></div>
      <div className="num mt-0.5 text-sm font-semibold text-paper">{value}</div>
      <div className="text-[11px] leading-snug text-muted" data-testid={`${testid}-label`}>{gate?.label ?? "no reading"}</div>
      {extra && extra.length > 0 && <div className="text-[11px] leading-snug text-muted" data-testid={`${testid}-top`}>Costs most: {extra.join("; ")}</div>}
    </div>
  );
}

/** The 09:45 regime tile: the opening-range ratio when it exists, otherwise what the regime readings say. */
function regimeValue(p: PreflightRadar): string {
  const ratio = p.regime.ib_ratio;
  if (p.gates.regime_squeeze?.status === "UNKNOWN") return MISSING;
  return ratio == null ? (p.regime.flags.length ? `${p.regime.flags.length} flag${p.regime.flags.length > 1 ? "s" : ""}` : "none on") : `IB ${ratio.toFixed(2)}× daily move`;
}

/** The live pre-flight radar: a traffic light for selling the at-the-money straddle by hand, the four gates behind it, and reference levels. A description of the straddle right now with provisional thresholds, not a signal. */
export function StraddlePreflightCard({ d }: { d: StraddleDecay }) {
  const p = d.preflight;
  if (!p) return null;
  const b = BADGE[p.badge];
  const g = p.gates;
  const t = p.trade_setup;
  const stopPts = t.stop_loss_pts != null && t.combined_premium != null ? t.stop_loss_pts - t.combined_premium : null;
  return (
    <section aria-label="Pre-flight entry radar" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="preflight">
      <div className={`rounded-sm border px-3 py-2.5 ${b.box}`} data-testid="preflight-badge" data-badge={p.badge}>
        <div className="text-base font-semibold" data-testid="preflight-title">{b.icon} {p.headline}</div>
        <p className="mt-0.5 text-xs" data-testid="preflight-summary">{p.summary}</p>
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_17rem]">
        <div className="min-w-0">
          {p.verdict !== "NO_LIVE_DATA" && (
            <div className="grid gap-2 sm:grid-cols-2" data-testid="preflight-gates">
              <Gate testid="pf-premium" title="Premium momentum (15m)" gate={g.premium_decay} value={g.premium_decay?.val_15m == null ? MISSING : `${sg(g.premium_decay.val_15m)} pts`} />
              <Gate testid="pf-iv" title="Volatility velocity (15m)" gate={g.volatility_shock} value={g.volatility_shock?.val_15m == null ? MISSING : `${sg(g.volatility_shock.val_15m, 2)} vol pts`} />
              <Gate testid="pf-regime" title="09:45 regime / squeeze" gate={g.regime_squeeze} value={regimeValue(p)} />
              {g.seller_environment && <Gate testid="pf-seller" title="Seller environment score" gate={g.seller_environment} value={g.seller_environment.score == null ? MISSING : `${Math.round(g.seller_environment.score)} / 100`} extra={g.seller_environment.top} />}
              <Gate testid="pf-gamma" title="Gamma flip distance (modelled)" gate={g.structure_flip} value={g.structure_flip?.flip == null || g.structure_flip.spot == null ? MISSING : `${sg(g.structure_flip.spot - g.structure_flip.flip, 0)} pts`} />
            </div>
          )}
          {p.regime.flags.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[11px] text-muted" data-testid="preflight-flags">{p.regime.flags.map((f) => <li key={f.id}>{f.message}</li>)}</ul>
          )}
        </div>
        <div className="rounded-sm border border-rule/60 bg-slate-2 px-3 py-2 text-xs" data-testid="preflight-trade">
          <div className="text-[11px] font-semibold text-paper">Reference levels{p.badge === "RED" ? " (the radar says do not sell)" : ""} <span className="font-normal text-muted">· provisional</span></div>
          <dl className="mt-1 space-y-1">
            <div data-testid="pf-strike"><dt className="inline text-muted">ATM strike </dt><dd className="num inline text-paper">{t.strike == null ? MISSING : `${t.strike.toLocaleString("en-IN")} ATM`}</dd></div>
            <div data-testid="pf-premium-now"><dt className="inline text-muted">Total premium </dt><dd className="num inline text-paper">{t.combined_premium == null ? MISSING : `${pts(t.combined_premium)} pts (${rupees(t.combined_premium)} a lot)`}</dd></div>
            <div data-testid="pf-stop"><dt className="inline text-muted">Hard stop (+{t.stop_loss_pct}%) </dt><dd className="num inline text-paper">{t.stop_loss_pts == null ? MISSING : `${pts(t.stop_loss_pts)} pts`}</dd>{stopPts != null && <span className="text-muted"> · about {rupees(stopPts)} a lot lost</span>}</div>
            <div data-testid="pf-restrike"><dt className="inline text-muted">Re-strike alert if spot moves </dt><dd className="num inline text-paper">±{t.re_strike_pts} pts</dd></div>
          </dl>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted" data-testid="preflight-note">{p.note}</p>
    </section>
  );
}
