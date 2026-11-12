/** The plain-language reading at the top of Market Intelligence, written only from fields the summary already carries (nothing is computed or invented here).
 *  It answers four questions in order: what is the market doing, how far can it be trusted, what changed lately, and what would change the view. */
import type { EngineView, Intelligence } from "./intelligence";

export type Tone = "bullish" | "bearish" | "neutral" | "unknown";
export interface Reason { name: string; score: number }
export interface WatchLine { label: string; text: string }
export interface Verdict {
  tone: Tone;
  label: string;
  score: number | null;
  headline: string;
  trust: { level: "High" | "Medium" | "Low" | "Unknown"; text: string };
  changed: { lean: "bullish" | "bearish" | "mixed" | "none" | "unavailable"; text: string };
  reasons: { for: Reason[]; against: Reason[] };
  watch: WatchLine[];
  regime: string;
}

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`;
/** "A. Derivatives positioning" -> "Derivatives positioning" */
export const plainName = (name: string): string => name.replace(/^[A-E]\.\s*/, "");

function toneOf(score: number | null): Tone {
  if (score == null) return "unknown";
  return score >= 15 ? "bullish" : score <= -15 ? "bearish" : "neutral";
}

function trustText(d: Intelligence): Verdict["trust"] {
  const s = d.sentiment;
  if (s.score == null) return { level: "Unknown", text: s.reason ?? "Too little data to read a direction." };
  const level = (s.signal_quality as Verdict["trust"]["level"] | null) ?? "Unknown";
  const stale = d.engines.filter((e) => e.freshness.fresh === false).length;
  const missing = d.engines.filter((e) => e.score == null).length;
  const bits: string[] = [];
  if (s.confidence != null) bits.push(`evidence quality ${s.confidence.toFixed(0)}/100`);
  if (stale > 0) bits.push(`${stale} of ${d.engines.length} evidence groups are stale (the market is closed or a feed has paused)`);
  if (missing > 0) bits.push(`${missing} group${missing > 1 ? "s have" : " has"} no reading`);
  if (s.agreement != null) bits.push(`${(s.agreement * 100).toFixed(0)}% of the groups agree`);
  return { level, text: bits.join("; ") };
}

function reasons(engines: readonly EngineView[], tone: Tone): Verdict["reasons"] {
  const live = engines.filter((e) => e.score != null).map((e) => ({ name: plainName(e.name), score: e.score as number, w: Math.abs(e.contribution ?? e.score ?? 0) }));
  const top = (rows: typeof live) => rows.sort((a, b) => b.w - a.w).slice(0, 2).map(({ name, score }) => ({ name, score }));
  const pos = top(live.filter((r) => r.score >= 15)), neg = top(live.filter((r) => r.score <= -15));
  if (tone === "bearish") return { for: neg, against: pos };
  return { for: pos, against: neg }; // bullish, neutral and unknown: the bullish side first
}

function changed(d: Intelligence): Verdict["changed"] {
  const t = d.turn_watch;
  if (!t) return { lean: "unavailable", text: "The 20-minute change is not available in this reading." };
  if (!t.available) return { lean: "unavailable", text: t.reason ?? "Not enough stored minutes yet to compare with 20 minutes ago." };
  const lean = t.lean ?? "none";
  if (lean === "none" || t.signals.length === 0) {
    const ctx = t.signals[0]; // a breadth signal never sets the lean: it is shown as context, not as a turn
    return { lean: "none", text: ctx ? `No sustained turn in the last 20 minutes. Context: ${ctx.title.charAt(0).toLowerCase()}${ctx.title.slice(1)}.` : "No sustained change in the last 20 minutes." };
  }
  const lead = t.signals.find((x) => !x.id.startsWith("breadth")) ?? t.signals[0]!;
  return { lean, text: `${lead.title}${lead.early ? " (price has not confirmed yet)" : ""}.` };
}

function watch(d: Intelligence, tone: Tone): WatchLine[] {
  const sc = d.scenarios;
  if (!sc?.available) return [];
  const out: WatchLine[] = [];
  const add = (label: string, text: string | null | undefined) => { if (text) out.push({ label, text }); };
  if (tone === "bullish") { add("The bullish view weakens if", sc.bullish?.invalidation); add("It turns bearish if", sc.bearish?.confirmation); }
  else if (tone === "bearish") { add("The bearish view weakens if", sc.bearish?.invalidation); add("It turns bullish if", sc.bullish?.confirmation); }
  else {
    const r = sc.sideways?.range;
    if (r && r[0] != null && r[1] != null) out.push({ label: "Expected range", text: `${r[0]} to ${r[1]}` });
    add("A bullish break needs", sc.bullish?.confirmation); add("A bearish break needs", sc.bearish?.confirmation);
  }
  return out;
}

export function verdict(d: Intelligence): Verdict {
  const s = d.sentiment, tone = toneOf(s.score);
  const trust = trustText(d);
  const label = s.score == null ? "No reading" : s.class;
  const headline = s.score == null
    ? "There is too little data to read a direction right now."
    : `${label}, score ${signed(s.score)} out of 100. ${trust.level === "Low" ? "Treat it with caution: the evidence behind it is weak." : trust.level === "High" ? "The evidence behind it is strong." : trust.level === "Medium" ? "The evidence behind it is moderate." : ""}`.trim();
  return { tone, label, score: s.score, headline, trust, changed: changed(d), reasons: reasons(d.engines, tone), watch: watch(d, tone), regime: `${d.regime.name} · ${s.volatility_regime} volatility · gamma ${d.regime.gamma}` };
}
