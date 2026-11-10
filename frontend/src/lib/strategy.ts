/**
 * Options strategy engine: legs, expiry payoff, breakevens, maximum profit and loss, templates and validation.
 * Pure functions, no UI and no network. Everything here is exact arithmetic on the legs; no price is modelled.
 */

export type OptionType = "CE" | "PE";
export type Action = "BUY" | "SELL";

export interface Leg {
  id: string;
  expiry: string; // ISO date, the contract's expiry
  strike: number;
  type: OptionType;
  action: Action;
  lots: number; // whole lots
  premium: number | null; // entry premium per unit; null = not entered
  premiumSource: "market" | "manual" | null;
  /** false = kept in the table but left out of the payoff (the checkbox); default true */
  enabled?: boolean;
  /** manual implied volatility override for the model estimates, 0.15 = 15 % */
  iv?: number | null;
  /** premium level at which you plan to take profit / cut the loss, per unit (null = none) */
  target?: number | null;
  stop?: number | null;
  /** live-feed key of the contract ("nse_fo|<token>"): lets the server watch this leg's price while no page is open */
  key?: string | null;
  // ---- paper automation (nothing is sent to a broker): a leg that reaches its stop or target is closed at the live price
  /** set when the leg has been exited: the price it was closed at */
  exitPrice?: number | null;
  exitReason?: "stop" | "target" | "manual" | "strategy" | null;
  exitedAt?: string | null;
  /** rupees already booked by closes of this leg (a closed cycle adds its P&L here) */
  realised?: number;
  /** how many times a stopped-out leg may be entered again (the box next to the leg) */
  reentry?: number;
  /** premium the market has to come back to before a stopped-out leg is entered again: its own entry premium before the stop */
  reentryLevel?: number | null;
  /** distance of the stop and target from the entry, as fractions, kept so a re-entered leg gets the same distances */
  stopPct?: number | null;
  targetPct?: number | null;
  cycles?: number;
  /**
   * Percentage trailing stop (needs a stop): for every `trailEvery` % of the ENTRY premium the leg moves in your favour
   * (a sold option falling, a bought one rising), the stop moves `trailBy` % of the entry premium in your favour too.
   * The stop only ever tightens. `stopBase` is the stop you set; `stopTrailed` marks a stop that has moved, and such a stop
   * may sit on the profit side of the entry (it locks profit), which a stop you type may not.
   */
  trailEvery?: number | null;
  trailBy?: number | null;
  stopBase?: number | null;
  stopTrailed?: boolean;
  log?: { at: string; text: string }[];
}

export const sign = (a: Action) => (a === "BUY" ? 1 : -1);
export const isExited = (l: Pick<Leg, "exitPrice">): boolean => l.exitPrice != null;

/** Has the market price reached this leg's target or stop? A bought option's target is above its entry and its stop below; for a sold one it is the other way round. */
export function hitOf(l: { action: Action; premium?: number | null; target?: number | null; stop?: number | null; stopTrailed?: boolean }, kind: "target" | "stop", price: number): boolean {
  const lvl = kind === "target" ? l.target : l.stop;
  if (lvl == null) return false;
  const up = (kind === "target") === (l.action === "BUY"); // the premium has to rise to the level
  // a level on the wrong side of the entry (or at it) is a typing slip, not a trigger: it is flagged in the UI and never fires
  if (!(kind === "stop" && l.stopTrailed) && l.premium != null && (up ? lvl <= l.premium : lvl >= l.premium)) return false;
  return up ? price >= lvl : price <= lvl;
}

const tick = (v: number) => Math.max(0.05, Math.round(v * 20) / 20);
const stamp = (at: string) => new Date(at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });

/** Close a leg at `price` and book its P&L. The stop's distance is remembered so a re-entry can reuse it. */
export function exitLeg(l: Leg, price: number, reason: "stop" | "target" | "manual" | "strategy", lotSize: number, at: string, lotsFactor = 1, label?: string): Leg {
  if (l.premium == null || isExited(l)) return l;
  const pnl = sign(l.action) * (price - l.premium) * l.lots * lotsFactor * lotSize;
  const what = label ?? (reason === "stop" ? (l.stopTrailed ? "Trailing stop" : "Stop") : reason === "target" ? "Target" : "Manual exit");
  const text = `${what}: ${l.action} ${l.strike} ${l.type} closed at ${price.toFixed(2)} (entry ${l.premium.toFixed(2)}), ${pnl < 0 ? "−" : "+"}₹${Math.round(Math.abs(pnl)).toLocaleString("en-IN")}`;
  return {
    ...l, exitPrice: price, exitReason: reason, exitedAt: at, realised: (l.realised ?? 0) + pnl,
    reentryLevel: reason === "stop" ? l.premium : null,
    stopPct: (l.stopBase ?? l.stop) != null ? Math.abs((l.stopBase ?? l.stop!) / l.premium - 1) : l.stopPct ?? null,
    targetPct: l.target != null ? Math.abs(l.target / l.premium - 1) : l.targetPct ?? null,
    log: [...(l.log ?? []), { at, text: `${stamp(at)} ${text}` }].slice(-20),
  };
}

/** Enter an exited leg again at `price`. The stop and target keep their distance from the new entry. `viaBox` uses up one of the re-entries. */
export function reenterLeg(l: Leg, price: number, at: string, viaBox: boolean): Leg {
  if (!isExited(l)) return l;
  const buy = l.action === "BUY";
  const lvl = (pct: number | null | undefined, profitSide: boolean) => (pct == null ? null : tick(price * (profitSide === buy ? 1 + pct : 1 - pct)));
  const what = viaBox ? "Re-entry" : "Entered again";
  return {
    ...l, premium: price, premiumSource: "market", exitPrice: null, exitReason: null, exitedAt: null, reentryLevel: null,
    stop: lvl(l.stopPct, false), target: lvl(l.targetPct, true), stopBase: null, stopTrailed: false,
    reentry: viaBox ? Math.max(0, (l.reentry ?? 0) - 1) : l.reentry, cycles: (l.cycles ?? 0) + 1,
    log: [...(l.log ?? []), { at, text: `${stamp(at)} ${what}: ${l.action} ${l.strike} ${l.type} at ${price.toFixed(2)}` }].slice(-20),
  };
}

/**
 * Roll a leg to another strike: the old position is closed at its live price (its P&L is booked) and the same leg is
 * opened at the new strike at its live price. The stop and target keep their percentage distance from the new entry.
 * Paper only. Returns the leg unchanged when it is closed, has no entry premium, or the strike does not change.
 */
export function rollLeg(l: Leg, newStrike: number, oldPrice: number, newPrice: number, lotSize: number, at: string, lotsFactor = 1): Leg {
  if (isExited(l) || l.premium == null || newStrike === l.strike) return l;
  const pnl = sign(l.action) * (oldPrice - l.premium) * l.lots * lotsFactor * lotSize;
  const buy = l.action === "BUY";
  const pct = (lvl: number | null | undefined) => (lvl == null ? null : Math.abs(lvl / l.premium! - 1));
  const lvl = (p: number | null, profitSide: boolean) => (p == null ? null : tick(newPrice * (profitSide === buy ? 1 + p : 1 - p)));
  const text = `Rolled ${l.action} ${l.strike} ${l.type} to ${newStrike} ${l.type}: old closed at ${oldPrice.toFixed(2)} (entry ${l.premium.toFixed(2)}), ${pnl < 0 ? "−" : "+"}₹${Math.round(Math.abs(pnl)).toLocaleString("en-IN")} booked; new entry ${newPrice.toFixed(2)}`;
  return {
    ...l, strike: newStrike, premium: newPrice, premiumSource: "market", realised: (l.realised ?? 0) + pnl, cycles: (l.cycles ?? 0) + 1,
    stop: lvl(pct(l.stopBase ?? l.stop), false), target: lvl(pct(l.target), true), stopBase: null, stopTrailed: false, exitPrice: null, exitReason: null, reentryLevel: null,
    log: [...(l.log ?? []), { at, text: `${stamp(at)} ${text}` }].slice(-20),
  };
}

/** The strategy's P&L from its legs and live prices: what is booked plus the open legs against the market. Null total when an open leg has no price or entry. */
export function strategyPnl(legs: Leg[], priceOf: (strike: number, type: OptionType) => number | null, lotSize: number): { booked: number; open: number | null; total: number | null; openLegs: number } {
  let booked = 0, open: number | null = 0, openLegs = 0;
  for (const l of legs) {
    if (l.enabled === false) continue;
    booked += l.realised ?? 0;
    if (isExited(l)) continue;
    openLegs += 1;
    const px = priceOf(l.strike, l.type);
    if (px == null || l.premium == null) { open = null; continue; }
    if (open != null) open += sign(l.action) * (px - l.premium) * l.lots * lotSize;
  }
  return { booked, open, total: open == null ? null : booked + open, openLegs };
}

/**
 * Percentage trailing stop of one open leg at the live price `px`. The leg's gain is how far the premium has moved in your
 * favour as a fraction of the ENTRY premium; every full `trailEvery` % of it moves the stop `trailBy` % of the entry premium in
 * your favour from the stop you set (`stopBase`). The stop only tightens, so remembering the best price is not needed.
 * Returns the leg unchanged when no trail is set, there is no stop or entry, or the stop would not move.
 */
export function trailLeg(l: Leg, px: number): Leg {
  const every = l.trailEvery, by = l.trailBy;
  if (!(every && every > 0) || !(by && by > 0) || by > every || l.premium == null || !(l.premium > 0) || l.stop == null || isExited(l)) return l;
  const base = l.stopTrailed ? l.stopBase ?? l.stop : l.stop;
  const buy = l.action === "BUY";
  const gain = (buy ? px - l.premium : l.premium - px) / l.premium; // fraction of the entry premium, in your favour
  const steps = Math.floor(gain * 100 / every + 1e-9);
  if (steps < 1) return l;
  const moved = base + (buy ? 1 : -1) * steps * (by / 100) * l.premium;
  const next = Math.max(0.05, Math.round(moved * 20) / 20);
  const tighter = buy ? next > l.stop : next < l.stop;
  if (!tighter) return l;
  return { ...l, stopBase: base, stopTrailed: true, stop: next };
}

// ---------------------------------------------------------------- strategy-level stop, target, lock and trail (rupees)
/**
 * Rules on the whole strategy's P&L (booked + open), in rupees, all optional:
 *  sl      exit everything when the P&L falls to -sl
 *  target  exit everything when the P&L reaches +target
 *  lockAt, lockProfit   once the P&L has reached lockAt, never give back more than to lockProfit (the floor)
 *  trailEvery, trailBy  after that, for every further trailEvery rupees of profit the floor rises by trailBy
 */
export interface StrategyRules { sl: number | null; target: number | null; lockAt: number | null; lockProfit: number | null; trailEvery: number | null; trailBy: number | null }
export interface RulesState { floor: number | null; done: "sl" | "target" | "lock" | null; at?: string | null; pnl?: number | null }
export const NO_RULES: StrategyRules = { sl: null, target: null, lockAt: null, lockProfit: null, trailEvery: null, trailBy: null };
export const hasRules = (r: StrategyRules | null | undefined): boolean => !!r && Object.values(r).some((v) => v != null);

/**
 * Why the lock-and-trail setting cannot work, or null. Such a setting is ignored (never half-applied) so a slip cannot close
 * the strategy: locking at or above the level reached would exit at once, and a floor rising faster than the profit would too.
 */
export function rulesProblem(r: StrategyRules): string | null {
  const any = r.lockAt != null || r.lockProfit != null;
  if (any && (r.lockAt == null || r.lockProfit == null)) return "Lock needs both “when profit reaches” and “lock”.";
  if (r.lockAt != null && r.lockProfit != null && (!(r.lockAt > 0) || !(r.lockProfit >= 0) || r.lockProfit >= r.lockAt)) return "The locked profit has to be below the profit that triggers it.";
  if ((r.trailEvery != null) !== (r.trailBy != null)) return "Trail needs both “for every” and “raise by”.";
  if (r.trailEvery != null && r.trailBy != null && (!(r.trailEvery > 0) || !(r.trailBy > 0) || r.trailBy > r.trailEvery)) return "Raise the floor by no more than the extra profit it is for.";
  if ((r.trailEvery != null) && r.lockAt == null) return "Trail only works after a lock.";
  return null;
}

/** The profit floor the lock-and-trail rule gives at a P&L of `pnl` (null while the lock level has not been reached). */
export function lockFloor(r: StrategyRules, pnl: number): number | null {
  if (rulesProblem(r) || r.lockAt == null || r.lockProfit == null || pnl < r.lockAt) return null;
  const extra = r.trailEvery && r.trailBy ? Math.floor((pnl - r.lockAt) / r.trailEvery + 1e-9) * r.trailBy : 0;
  return r.lockProfit + extra;
}

/**
 * Check the strategy rules against the live prices (paper only). The floor is kept and only rises. When a rule fires every open
 * leg is closed at its live price (reason "strategy", so no leg re-enters) and `done` records which rule it was.
 * Legs are given at their own lots; `lotsFactor` is the multiplier. Nothing happens while any open leg has no live price.
 */
export function applyStrategyRules(legs: Leg[], rules: StrategyRules, state: RulesState, priceOf: (strike: number, type: OptionType) => number | null, lotSize: number, at: string, lotsFactor = 1): { legs: Leg[]; state: RulesState; events: string[] } {
  if (state.done || !hasRules(rules)) return { legs, state, events: [] };
  const live = legs.filter((l) => l.enabled !== false);
  if (live.length === 0) return { legs, state, events: [] };
  const p = strategyPnl(live.map((l) => ({ ...l, lots: l.lots * lotsFactor })), priceOf, lotSize);
  if (p.total == null || p.openLegs === 0) return { legs, state, events: [] };
  const total = p.total;
  const fl = lockFloor(rules, total);
  const floor = fl != null && (state.floor == null || fl > state.floor) ? fl : state.floor;
  let done: RulesState["done"] = null;
  let label = "";
  if (rules.sl != null && rules.sl > 0 && total <= -rules.sl) { done = "sl"; label = `Strategy stop loss (−₹${Math.round(rules.sl).toLocaleString("en-IN")})`; }
  else if (rules.target != null && rules.target > 0 && total >= rules.target) { done = "target"; label = `Strategy target (+₹${Math.round(rules.target).toLocaleString("en-IN")})`; }
  else if (floor != null && total <= floor) { done = "lock"; label = `Locked profit (floor +₹${Math.round(floor).toLocaleString("en-IN")})`; }
  if (!done) return floor === state.floor ? { legs, state, events: [] } : { legs, state: { ...state, floor }, events: [] };
  const events: string[] = [];
  const out = legs.map((l) => {
    if (l.enabled === false) return l;
    if (isExited(l)) return { ...l, reentry: 0 }; // a leg waiting to re-enter stays out
    const px = priceOf(l.strike, l.type);
    if (px == null || !(px > 0) || l.premium == null) return l;
    const n = { ...exitLeg(l, px, "strategy", lotSize, at, lotsFactor, label), reentry: 0 };
    events.push(n.log![n.log!.length - 1]!.text);
    return n;
  });
  return { legs: out, state: { floor, done, at, pnl: total }, events };
}

/**
 * One evaluation of every automatic rule against the live prices (paper only, nothing is sent to a broker):
 *  - an open leg whose stop or target price has been reached is closed at the live price (the stop is checked first);
 *  - a leg closed by its stop, with re-entries left, is entered again at the live price when the market comes back to
 *    its own entry premium: a sold option when the premium falls back to it or below, a bought option when it rises back.
 * Returns the new legs and the log lines of what happened. Legs without a live price are left alone.
 */
export function applyAutomation(legs: Leg[], priceOf: (strike: number, type: OptionType) => number | null, lotSize: number, at: string, lotsFactor = 1): { legs: Leg[]; events: string[] } {
  const events: string[] = [];
  const out = legs.map((l) => {
    if (l.enabled === false) return l;
    const px = priceOf(l.strike, l.type);
    if (px == null || !(px > 0)) return l;
    if (!isExited(l)) {
      if (l.premium == null) return l;
      const t = trailLeg(l, px);
      if (t !== l) {
        events.push(`Trailing stop ${l.action} ${l.strike} ${l.type}: stop ${l.stop!.toFixed(2)} → ${t.stop!.toFixed(2)} (price ${px.toFixed(2)})`);
        l = t;
      }
      const kind = hitOf(l, "stop", px) ? "stop" : hitOf(l, "target", px) ? "target" : null;
      if (kind == null) return l;
      const n = exitLeg(l, px, kind, lotSize, at, lotsFactor);
      events.push(n.log![n.log!.length - 1]!.text);
      return n;
    }
    if (l.exitReason === "stop" && (l.reentry ?? 0) > 0 && l.reentryLevel != null) {
      const back = l.action === "SELL" ? px <= l.reentryLevel : px >= l.reentryLevel;
      if (back) {
        const n = reenterLeg(l, px, at, true);
        events.push(n.log![n.log!.length - 1]!.text);
        return n;
      }
    }
    return l;
  });
  return { legs: out, events };
}

// ---------------------------------------------------------------- expiry payoff
export const intrinsic = (l: Pick<Leg, "type" | "strike">, s: number) => Math.max(l.type === "CE" ? s - l.strike : l.strike - s, 0);

/** P&L of one leg at expiry, before costs. Null while the premium is missing. */
export function legExpiryPnl(l: Leg, s: number, lotSize: number): number | null {
  if (l.exitPrice != null) return l.realised ?? 0; // closed: its P&L is fixed whatever NIFTY does
  if (l.premium == null) return null;
  return sign(l.action) * (intrinsic(l, s) - l.premium) * l.lots * lotSize + (l.realised ?? 0);
}

/** Strategy P&L at expiry (all legs share the expiry), before costs. Null if any premium is missing. */
export function expiryPnl(legs: Leg[], s: number, lotSize: number): number | null {
  let total = 0;
  for (const l of legs) {
    const p = legExpiryPnl(l, s, lotSize);
    if (p == null) return null;
    total += p;
  }
  return total;
}

export interface ExpiryAnalysis {
  /** false for multi-expiry strategies: an expiry payoff is only defined when every leg expires together */
  defined: boolean;
  reason?: string;
  breakevens: number[];
  /** finite best/worst P&L over S >= 0; null when unbounded */
  maxProfit: number | null;
  maxLoss: number | null;
  profitUnlimited: boolean;
  lossUnlimited: boolean;
  kinks: number[];
}

/**
 * Exact analysis: the payoff is piecewise linear with kinks at the strikes, so the extremes are at S = 0 or a strike
 * (or unbounded if the slope beyond the last strike is not zero), and every breakeven lies on one linear piece.
 */
export function analyzeExpiry(legs: Leg[], lotSize: number): ExpiryAnalysis {
  const none = { breakevens: [], maxProfit: null, maxLoss: null, profitUnlimited: false, lossUnlimited: false, kinks: [] as number[] };
  if (legs.length === 0) return { defined: false, reason: "Add at least one leg.", ...none };
  if (new Set(legs.map((l) => l.expiry)).size > 1) return { defined: false, reason: "The legs expire on different dates: there is no single expiry payoff. See the theoretical curve.", ...none };
  if (legs.some((l) => l.premium == null)) return { defined: false, reason: "Enter the entry premium of every leg.", ...none };
  const kinks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const pts = [0, ...kinks];
  const f = (s: number) => expiryPnl(legs, s, lotSize) as number;
  // slope above the last strike: calls only (puts are worthless there); below the first strike: puts only
  const upSlope = legs.filter((l) => !isExited(l)).reduce((a, l) => a + (l.type === "CE" ? sign(l.action) * l.lots * lotSize : 0), 0);
  const values = pts.map(f);
  const maxFinite = Math.max(...values), minFinite = Math.min(...values);
  const profitUnlimited = upSlope > 0, lossUnlimited = upSlope < 0;
  const be: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!, fa = values[i]!, fb = values[i + 1]!;
    if (fa === 0 && i === 0 && a > 0) be.push(a);
    if (fa * fb < 0) be.push(a + ((0 - fa) * (b - a)) / (fb - fa));
    else if (fb === 0 && b !== pts[pts.length - 1]) be.push(b);
  }
  const last = pts[pts.length - 1]!, flast = values[values.length - 1]!;
  if (upSlope !== 0) {
    const root = last - flast / upSlope; // linear beyond the last strike
    if (root > last) be.push(root);
  } else if (flast === 0 && !be.includes(last)) be.push(last);
  const uniq = [...new Set(be.map((x) => Math.round(x * 1e6) / 1e6))].filter((x) => x >= 0).sort((x, y) => x - y);
  return {
    defined: true, breakevens: uniq, kinks,
    maxProfit: profitUnlimited ? null : maxFinite, maxLoss: lossUnlimited ? null : minFinite,
    profitUnlimited, lossUnlimited,
  };
}

export function payoffCurve(legs: Leg[], lotSize: number, lo: number, hi: number, step: number): { s: number; pnl: number }[] {
  const out: { s: number; pnl: number }[] = [];
  if (!(step > 0) || hi < lo) return out;
  for (let s = lo; s <= hi + 1e-9; s += step) {
    const p = expiryPnl(legs, s, lotSize);
    if (p == null) return [];
    out.push({ s, pnl: p });
  }
  return out;
}

// ---------------------------------------------------------------- validation
export interface Issue { legId: string | null; field: string; message: string; level: "error" | "warning" }

export interface ValidationContext {
  expiries: string[]; // contracts the instrument master lists
  strikesByExpiry: Record<string, number[]>; // listed strikes per expiry, where known
  today: string; // ISO date
}

export function validateStrategy(legs: Leg[], ctx: ValidationContext): Issue[] {
  const out: Issue[] = [];
  for (const l of legs) {
    const err = (field: string, message: string) => out.push({ legId: l.id, field, message, level: "error" });
    if (!Number.isInteger(l.lots) || l.lots < 1) err("lots", "Lots must be a whole number of at least 1.");
    if (!Number.isFinite(l.strike) || l.strike <= 0) err("strike", "Strike must be a positive number.");
    if (!ctx.expiries.includes(l.expiry)) err("expiry", `${l.expiry} is not a listed expiry for this instrument.`);
    else if (l.expiry < ctx.today) err("expiry", "This expiry has passed.");
    const listed = ctx.strikesByExpiry[l.expiry];
    if (listed && listed.length && !listed.includes(l.strike)) err("strike", `${l.strike} is not a listed strike for ${l.expiry}.`);
    if (l.premium == null) out.push({ legId: l.id, field: "premium", message: "Entry premium is missing: enter it or use the market quote.", level: "warning" });
    else if (!Number.isFinite(l.premium) || l.premium < 0) err("premium", "Premium cannot be negative.");
  }
  const seen = new Set<string>();
  for (const l of legs) {
    const key = `${l.expiry}|${l.strike}|${l.type}|${l.action}`;
    if (seen.has(key)) out.push({ legId: l.id, field: "leg", message: "Duplicate of another leg: combine them with a larger lot count.", level: "warning" });
    seen.add(key);
  }
  return out;
}

// ---------------------------------------------------------------- templates
export interface TemplateContext {
  strikes: number[]; // listed strikes of the main expiry, any order
  atm: number; // the listed strike nearest the spot
  expiry: string;
  premium: (expiry: string, strike: number, type: OptionType) => number | null;
}
type Draft = Omit<Leg, "id">;
export interface Template { id: string; label: string; group: "Directional" | "Neutral" | "Spreads"; view: string; build: (c: TemplateContext) => Draft[] | { error: string } }

function strikeAt(c: TemplateContext, steps: number): number | null {
  const ks = [...c.strikes].sort((a, b) => a - b);
  const i = ks.indexOf(c.atm);
  const j = i + steps;
  return i < 0 || j < 0 || j >= ks.length ? null : ks[j]!;
}

function mk(c: TemplateContext, rows: [Action, OptionType, number, number?][]): Draft[] | { error: string } {
  const out: Draft[] = [];
  for (const [action, type, steps, lots = 1] of rows) {
    const strike = strikeAt(c, steps);
    if (strike == null) return { error: `The chain has no listed strike ${Math.abs(steps)} steps ${steps < 0 ? "below" : "above"} the ATM strike.` };
    const expiry = c.expiry;
    const premium = c.premium(expiry, strike, type);
    out.push({ expiry, strike, type, action, lots, premium, premiumSource: premium == null ? null : "market" });
  }
  return out;
}

export const TEMPLATES: Template[] = [
  { id: "long_call", label: "Long call", group: "Directional", view: "Bullish, limited risk", build: (c) => mk(c, [["BUY", "CE", 0]]) },
  { id: "long_put", label: "Long put", group: "Directional", view: "Bearish, limited risk", build: (c) => mk(c, [["BUY", "PE", 0]]) },
  { id: "short_call", label: "Short call", group: "Directional", view: "Bearish or flat, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 0]]) },
  { id: "short_put", label: "Short put", group: "Directional", view: "Bullish or flat, large risk", build: (c) => mk(c, [["SELL", "PE", 0]]) },
  { id: "long_straddle", label: "Long straddle", group: "Neutral", view: "Big move either way", build: (c) => mk(c, [["BUY", "CE", 0], ["BUY", "PE", 0]]) },
  { id: "short_straddle", label: "Short straddle", group: "Neutral", view: "Range-bound, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 0], ["SELL", "PE", 0]]) },
  { id: "long_strangle", label: "Long strangle", group: "Neutral", view: "Big move either way", build: (c) => mk(c, [["BUY", "CE", 2], ["BUY", "PE", -2]]) },
  { id: "short_strangle", label: "Short strangle", group: "Neutral", view: "Range-bound, unlimited risk", build: (c) => mk(c, [["SELL", "CE", 2], ["SELL", "PE", -2]]) },
  { id: "bull_call_spread", label: "Bull call spread", group: "Spreads", view: "Moderately bullish", build: (c) => mk(c, [["BUY", "CE", 0], ["SELL", "CE", 2]]) },
  { id: "bear_put_spread", label: "Bear put spread", group: "Spreads", view: "Moderately bearish", build: (c) => mk(c, [["BUY", "PE", 0], ["SELL", "PE", -2]]) },
  { id: "bull_put_spread", label: "Bull put spread", group: "Spreads", view: "Moderately bullish, credit", build: (c) => mk(c, [["SELL", "PE", 0], ["BUY", "PE", -2]]) },
  { id: "bear_call_spread", label: "Bear call spread", group: "Spreads", view: "Moderately bearish, credit", build: (c) => mk(c, [["SELL", "CE", 0], ["BUY", "CE", 2]]) },
  { id: "iron_condor", label: "Iron condor", group: "Neutral", view: "Range-bound, limited risk", build: (c) => mk(c, [["SELL", "PE", -2], ["BUY", "PE", -4], ["SELL", "CE", 2], ["BUY", "CE", 4]]) },
  { id: "iron_butterfly", label: "Iron butterfly", group: "Neutral", view: "Pinned near ATM, limited risk", build: (c) => mk(c, [["SELL", "CE", 0], ["SELL", "PE", 0], ["BUY", "CE", 2], ["BUY", "PE", -2]]) },
  { id: "butterfly", label: "Butterfly spread (calls)", group: "Neutral", view: "Pinned near ATM, limited risk", build: (c) => mk(c, [["BUY", "CE", -2], ["SELL", "CE", 0, 2], ["BUY", "CE", 2]]) },
  { id: "ratio_spread", label: "Call ratio spread (1:2)", group: "Spreads", view: "Mild rise, risk above", build: (c) => mk(c, [["BUY", "CE", 0], ["SELL", "CE", 2, 2]]) },
];

let counter = 0;
export const newLegId = () => `leg-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const withIds = (drafts: Draft[]): Leg[] => drafts.map((d) => ({ ...d, id: newLegId() }));

export type Bias = "Bullish" | "Bearish" | "Neutral" | "Other";
/** Which tab of the ready-made gallery each template sits under. */
export const TEMPLATE_BIAS: Record<string, Bias> = {
  long_call: "Bullish", short_put: "Bullish", bull_call_spread: "Bullish", bull_put_spread: "Bullish",
  long_put: "Bearish", short_call: "Bearish", bear_put_spread: "Bearish", bear_call_spread: "Bearish",
  short_straddle: "Neutral", short_strangle: "Neutral", iron_condor: "Neutral", iron_butterfly: "Neutral", butterfly: "Neutral",
  long_straddle: "Other", long_strangle: "Other", ratio_spread: "Other",
};


/** Which contract and side a leg is, whatever id a device gave it. */
export const legIdentity = (l: Pick<Leg, "expiry" | "strike" | "type" | "action">) => `${l.expiry}|${l.strike}|${l.type}|${l.action}`;

/**
 * Carry the server's exits into the legs held here. An exit cannot be undone, so a leg the server has closed is closed here too,
 * whatever else is being edited. A local leg matches the server's by id, else by contract, side and entry premium; a leg entered
 * again here (another entry premium) does not match, and a server leg that is still open changes nothing. Returns the same array
 * when nothing needed adopting.
 */
export function adoptExits(local: Leg[], server: Leg[]): Leg[] {
  const closed = server.filter(isExited);
  if (closed.length === 0) return local;
  let changed = false;
  const out = local.map((l) => {
    if (isExited(l)) return l;
    const s = closed.find((c) => c.id === l.id) ?? closed.find((c) => legIdentity(c) === legIdentity(l) && c.premium === l.premium);
    if (!s || s.premium !== l.premium) return l;
    changed = true;
    return { ...l, exitPrice: s.exitPrice, exitReason: s.exitReason, exitedAt: s.exitedAt, realised: s.realised, reentryLevel: s.reentryLevel, stopPct: s.stopPct ?? l.stopPct, targetPct: s.targetPct ?? l.targetPct, log: s.log ?? l.log };
  });
  return changed ? out : local;
}


// ---- holding period: intraday closes every open leg at a time of day, overnight holds to expiry and closes at that time on expiry day.
// Mirrors apply_hold in backend/app/strategy/automation.py (same moments, same label, nothing re-enters afterwards).
export interface HoldRule { mode: "intraday" | "overnight" | "manual"; closeAt: string }
export const DEFAULT_HOLD: HoldRule = { mode: "overnight", closeAt: "15:20" };

export function holdProblem(h: HoldRule): string | null {
  if (!["intraday", "overnight", "manual"].includes(h.mode)) return "Choose intraday, overnight or manual.";
  if (!/^\d\d:\d\d$/.test(h.closeAt) || h.closeAt <= "09:15" || h.closeAt > "15:40" || Number(h.closeAt.slice(3)) > 59) return "The close time has to be a time inside the session (09:15-15:40), for example 15:20.";
  return null;
}

const istDate = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const istAt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+05:30`);

/** When the holding rule closes a leg (epoch ms), or null: never (manual, a bad time) or already past when the rule was armed (overnight). */
export function holdMoment(h: HoldRule, heldFromMs: number, expiry: string | null | undefined): number | null {
  if (holdProblem(h) || h.mode === "manual") return null;
  if (h.mode === "overnight") {
    if (!expiry) return null;
    const m = istAt(expiry, h.closeAt);
    return m > heldFromMs ? m : null;
  }
  let day = istDate(heldFromMs);
  let m = istAt(day, h.closeAt);
  while (m <= heldFromMs || [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) {
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    m = istAt(day, h.closeAt);
  }
  return m;
}

export function applyHold(legs: Leg[], h: HoldRule, heldFrom: string | null, priceOf: (strike: number, type: OptionType) => number | null, lotSize: number, at: string, lotsFactor = 1): { legs: Leg[]; events: string[] } {
  const from = heldFrom ? Date.parse(heldFrom) : NaN;
  if (!Number.isFinite(from)) return { legs, events: [] };
  const label = `Auto close (${h.mode === "intraday" ? "intraday" : "expiry day"} ${h.closeAt})`;
  const events: string[] = [];
  const out = legs.map((l) => {
    const m = holdMoment(h, from, l.expiry);
    if (l.enabled === false || m == null || Date.parse(at) < m) return l;
    if (isExited(l)) return (l.reentry ?? 0) ? { ...l, reentry: 0 } : l; // a stopped leg waiting to re-enter is not entered after the close
    const px = priceOf(l.strike, l.type);
    if (px == null || !(px > 0) || l.premium == null) return l;
    const n = { ...exitLeg(l, px, "strategy", lotSize, at, lotsFactor, label), reentry: 0 };
    events.push(n.log![n.log!.length - 1]!.text);
    return n;
  });
  return { legs: out, events };
}
