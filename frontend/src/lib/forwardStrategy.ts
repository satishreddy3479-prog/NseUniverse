/**
 * A forward-test position as a strategy the Strategy builder can open: two sold legs at the strikes and entry premiums the test used, with the stop-loss rule that is selected
 * on the page (a leg stop of 30 to 80 % above each entry premium, "Move SL to cost", or a stop on the whole strategy for a combined-premium rule), and, for a position that has
 * closed or whose leg a stop has closed, the exit price and time. Nothing is estimated: every price is one the test stored.
 */
import { newLegId, NO_RULES, type Leg, type StrategyRules } from "./strategy";

export interface PositionIn {
  session: string; cohort: string; structure: string; n: number; expiry: string; trigger_at: string; ce_strike: number; pe_strike: number; ce0: number; pe0: number;
}
export interface ExitIn { ce_exit: number | null; pe_exit: number | null; stopped_at: string | null; settled_at?: string | null; reason?: string }

const LEG_STOP: Record<string, number> = { leg30: 0.3, leg40: 0.4, leg50: 0.5, leg60: 0.6, leg70: 0.7, leg80: 0.8, leg40_cost: 0.4 };
const COMBINED: Record<string, number> = { comb15: 0.15, comb25: 0.25, comb40: 0.4 };
const tick = (v: number) => Math.max(0.05, Math.round(v * 20) / 20);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Nov 09:30" in IST for an ISO time. */
function label(iso: string): string {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export interface BuilderDoc { name: string; expiry: string; legs: Leg[]; rules: StrategyRules; moveToCost: boolean; holdFrom: string }

export function positionToBuilder(p: PositionIn, rule: string, lot: number, exit?: ExitIn): BuilderDoc {
  const x = LEG_STOP[rule];
  const comb = COMBINED[rule];
  const stoppedAt = exit?.stopped_at ? `${p.session}T${exit.stopped_at}:00+05:30` : null;
  const closeAt = exit?.settled_at ?? `${p.session}T15:20:00+05:30`;
  const leg = (type: "CE" | "PE", strike: number, premium: number, exitPrice: number | null | undefined): Leg => {
    const stop = x != null ? tick(premium * (1 + x)) : null;
    const l: Leg = { id: newLegId(), expiry: p.expiry, strike, type, action: "SELL", lots: 1, premium, premiumSource: "market", stop, target: null, stopPct: x ?? null, enteredAt: p.trigger_at, stopSetAt: stop == null ? null : p.trigger_at };
    if (exitPrice == null) return l;
    // a leg that a stop closed: its price reached the stop (or its entry price for "stop to cost"); every other exit is the 15:20 close
    const stopped = stoppedAt != null && x != null && (exitPrice >= premium * (1 + x) - 1e-9 || (rule === "leg40_cost" && exitPrice >= premium - 1e-9));
    const byStop = stopped || (stoppedAt != null && comb != null);
    return { ...l, exitPrice, exitReason: stopped ? "stop" : "strategy", exitedAt: byStop && stoppedAt ? stoppedAt : closeAt, realised: (premium - exitPrice) * lot, reentryLevel: stopped ? premium : null };
  };
  const legs = [leg("CE", p.ce_strike, p.ce0, exit?.ce_exit), leg("PE", p.pe_strike, p.pe0, exit?.pe_exit)];
  const rules: StrategyRules = comb != null ? { ...NO_RULES, sl: Math.round(comb * (p.ce0 + p.pe0) * lot) } : NO_RULES;
  const kind = p.structure === "strangle" ? "strangle" : "straddle";
  return { name: `Forward ${p.cohort} ${kind} #${p.n}, ${label(p.trigger_at)}`, expiry: p.expiry, legs, rules, moveToCost: rule === "leg40_cost", holdFrom: p.trigger_at };
}
