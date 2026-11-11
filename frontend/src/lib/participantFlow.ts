// Analysis of NSE participant-wise F&O open interest (end-of-day positions, in contracts). Pure functions on the stored rows:
// nothing is estimated, a missing column stays missing (null) and is never read as zero.
import type { FlowsDay } from "./types";

export const PARTICIPANTS = ["FII", "DII", "Pro", "Client"] as const;
export type Participant = (typeof PARTICIPANTS)[number];

export const SEGMENTS = [
  { id: "idxFut", label: "Index futures", long: "Future Index Long", short: "Future Index Short" },
  { id: "stkFut", label: "Stock futures", long: "Future Stock Long", short: "Future Stock Short" },
  { id: "idxCall", label: "Index calls", long: "Option Index Call Long", short: "Option Index Call Short" },
  { id: "idxPut", label: "Index puts", long: "Option Index Put Long", short: "Option Index Put Short" },
] as const;
export type SegmentId = (typeof SEGMENTS)[number]["id"];

export interface Legs { long: number; short: number; net: number }

export function legs(day: FlowsDay | undefined, p: string, seg: SegmentId): Legs | null {
  const m = day?.participants[p];
  const s = SEGMENTS.find((x) => x.id === seg)!;
  if (!m || !(s.long in m) || !(s.short in m)) return null;
  const long = m[s.long]!;
  const short = m[s.short]!;
  return { long, short, net: long - short };
}

/** Sessions oldest first. */
export const ascending = (days: FlowsDay[]): FlowsDay[] => [...days].sort((a, b) => (a.session < b.session ? -1 : 1));

export type MoveKind = "long_build" | "long_unwind" | "short_build" | "short_cover" | "flat";

export const MOVE_TEXT: Record<MoveKind, string> = {
  long_build: "Long build-up", long_unwind: "Long unwinding", short_build: "Short build-up", short_cover: "Short covering", flat: "Little changed",
};
/** Direction each move points to for FUTURES (a long build-up or short covering leans up, a short build-up or long unwinding leans down). */
export const MOVE_LEAN: Record<MoveKind, 1 | -1 | 0> = { long_build: 1, short_cover: 1, short_build: -1, long_unwind: -1, flat: 0 };

/** What changed between two readings: the bigger of the two legs decides the label; a change under 1% of the larger book is "little changed". */
export function classify(now: Legs, then: Legs): MoveKind {
  const dl = now.long - then.long;
  const ds = now.short - then.short;
  const book = Math.max(now.long, now.short, then.long, then.short, 1);
  if (Math.max(Math.abs(dl), Math.abs(ds)) < 0.01 * book) return "flat";
  if (Math.abs(dl) >= Math.abs(ds)) return dl > 0 ? "long_build" : "long_unwind";
  return ds > 0 ? "short_build" : "short_cover";
}

export interface Delta { now: Legs; then: Legs; dLong: number; dShort: number; dNet: number; kind: MoveKind; thenSession: string }

/** Today (the newest session at index ``at``) against ``back`` sessions earlier; null when either side lacks the data. */
export function delta(asc: FlowsDay[], p: string, seg: SegmentId, back: number, at = asc.length - 1): Delta | null {
  const ti = at - back;
  if (at < 0 || ti < 0) return null;
  const now = legs(asc[at], p, seg);
  const then = legs(asc[ti], p, seg);
  if (!now || !then) return null;
  return { now, then, dLong: now.long - then.long, dShort: now.short - then.short, dNet: now.net - then.net, kind: classify(now, then), thenSession: asc[ti]!.session };
}

/** Share of the participant's own book that is long: long / (long + short). */
export const longShare = (l: Legs): number | null => (l.long + l.short > 0 ? l.long / (l.long + l.short) : null);

/** Where today's net sits among the stored sessions: rank 1 = the lowest (most short). */
export function netRank(asc: FlowsDay[], p: string, seg: SegmentId): { rank: number; of: number; lowest: boolean; highest: boolean } | null {
  const nets = asc.map((d) => legs(d, p, seg)?.net).filter((v): v is number => v != null);
  if (nets.length < 3) return null;
  const today = legs(asc[asc.length - 1], p, seg)?.net;
  if (today == null) return null;
  const rank = nets.filter((v) => v < today).length + 1;
  return { rank, of: nets.length, lowest: rank === 1, highest: rank === nets.length };
}

/** Consecutive sessions, ending at the newest, in which the net moved the same way (+ rising, − falling). 0 when the last step was flat. */
export function streak(asc: FlowsDay[], p: string, seg: SegmentId): number {
  let n = 0;
  let dir = 0;
  for (let i = asc.length - 1; i > 0; i--) {
    const a = legs(asc[i], p, seg)?.net;
    const b = legs(asc[i - 1], p, seg)?.net;
    if (a == null || b == null || a === b) break;
    const d = a > b ? 1 : -1;
    if (dir === 0) dir = d;
    if (d !== dir) break;
    n++;
  }
  return n * dir;
}

/** FII option bias: net calls minus net puts (positive = more bullish option exposure). null if either side is missing. */
export function optionBias(day: FlowsDay | undefined, p: string): number | null {
  const c = legs(day, p, "idxCall");
  const u = legs(day, p, "idxPut");
  return c && u ? c.net - u.net : null;
}

/** Newest session's sum of nets across the four groups: should be near zero for futures (every long has a short). */
export function netBalance(day: FlowsDay | undefined, seg: SegmentId): number | null {
  const parts = PARTICIPANTS.map((p) => legs(day, p, seg)?.net);
  return parts.every((v) => v != null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
}

/** Traded volume of a participant in a segment (side = bought or sold contracts), from the participant volume file. */
export function tradedVolume(day: FlowsDay | undefined, p: string, seg: SegmentId): Legs | null {
  return legs(day, p, seg);
}

export function fmtSigned(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

/** Plain-language readout, every line built from the stored numbers. ``back`` = sessions to compare with. */
export function headlines(asc: FlowsDay[], vol: FlowsDay[], back: number): string[] {
  const out: string[] = [];
  const n = asc.length;
  if (n < 2) return out;
  const b = Math.min(back, n - 1);
  const label = b === 1 ? "the previous session" : `${b} sessions ago (${asc[n - 1 - b]!.session})`;
  const fii = delta(asc, "FII", "idxFut", b);
  if (fii) {
    const verb = fii.dNet > 0 ? "less short" : fii.dNet < 0 ? "more short" : "unchanged";
    const side = fii.now.net < 0 ? "net short" : "net long";
    out.push(`FII are ${side} ${Math.abs(fii.now.net).toLocaleString("en-IN")} index futures and ${verb} than ${label} (${fmtSigned(fii.dNet)}): ${MOVE_TEXT[fii.kind].toLowerCase()} (longs ${fmtSigned(fii.dLong)}, shorts ${fmtSigned(fii.dShort)}).`);
    const r = netRank(asc, "FII", "idxFut");
    if (r && (r.lowest || r.highest)) out.push(`FII index-futures net is the ${r.highest ? (fii.now.net < 0 ? "least short" : "most long") : fii.now.net > 0 ? "least long" : "most short"} of the ${r.of} stored sessions.`);
    const s = streak(asc, "FII", "idxFut");
    if (Math.abs(s) >= 3) out.push(`FII net index futures have ${s > 0 ? "risen" : "fallen"} for ${Math.abs(s)} sessions in a row.`);
  }
  const cl = delta(asc, "Client", "idxFut", b);
  const pro = delta(asc, "Pro", "idxFut", b);
  const dii = delta(asc, "DII", "idxFut", b);
  if (cl && fii && Math.sign(cl.now.net) !== Math.sign(fii.now.net) && cl.now.net !== 0 && fii.now.net !== 0) {
    out.push(`Client (retail and others) hold the opposite side of FII: net ${cl.now.net > 0 ? "long" : "short"} ${Math.abs(cl.now.net).toLocaleString("en-IN")}${pro ? `; Pro are net ${pro.now.net > 0 ? "long" : "short"} ${Math.abs(pro.now.net).toLocaleString("en-IN")}` : ""}${dii ? `; DII net ${dii.now.net > 0 ? "long" : "short"} ${Math.abs(dii.now.net).toLocaleString("en-IN")}` : ""}.`);
  }
  const bias = optionBias(asc[n - 1], "FII");
  const biasThen = optionBias(asc[n - 1 - b], "FII");
  if (bias != null) out.push(`FII index options: net calls minus net puts is ${fmtSigned(bias)} (${bias < 0 ? "more put-side than call-side exposure, a bearish tilt" : "more call-side exposure, a bullish tilt"})${biasThen != null ? `, ${bias - biasThen >= 0 ? "up" : "down"} ${Math.abs(Math.round(bias - biasThen)).toLocaleString("en-IN")} from ${label}` : ""}.`);
  const v = vol.find((d) => d.session === asc[n - 1]!.session);
  const prior = vol.filter((d) => d.session < asc[n - 1]!.session).slice(0, 5);
  const vToday = v ? legs(v, "FII", "idxFut") : null;
  const vAvg = prior.map((d) => legs(d, "FII", "idxFut")).filter((x): x is Legs => x != null);
  if (vToday && vAvg.length >= 3) {
    const avg = vAvg.reduce((a, x) => a + x.long + x.short, 0) / vAvg.length;
    const ratio = (vToday.long + vToday.short) / avg;
    out.push(`FII index-futures trading activity is ${ratio.toFixed(2)}× the average of the previous ${vAvg.length} sessions.`);
  }
  return out;
}
