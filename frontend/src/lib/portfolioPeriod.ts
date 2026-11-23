/** The period filter of the Strategy portfolio page: overall, one year, or one month, by the IST calendar date a strategy was closed. */
export type PeriodMode = "overall" | "year" | "month";
export interface Period { mode: PeriodMode; year: number | null; month: number | null }
export const OVERALL: Period = { mode: "overall", year: null, month: null };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: number) => MONTHS[m - 1] ?? String(m);

/** Year and month (1-12) of an instant on the IST calendar: a close at 23:50 IST on the 30th belongs to that month, whatever UTC says. Null for an unreadable time. */
export function istYearMonth(iso: string): { y: number; m: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 330 * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

/** The years that have a closed strategy (newest first) and, for each, its months (newest first). */
export function availablePeriods(list: readonly { closedAt: string }[]): { years: number[]; months: Record<number, number[]> } {
  const months: Record<number, Set<number>> = {};
  for (const c of list) {
    const p = istYearMonth(c.closedAt);
    if (p) (months[p.y] ??= new Set()).add(p.m);
  }
  const years = Object.keys(months).map(Number).sort((a, b) => b - a);
  return { years, months: Object.fromEntries(years.map((y) => [y, [...months[y]!].sort((a, b) => b - a)])) };
}

/** A period that does not match any stored data (a saved month with nothing in it any more) falls back: a missing month to its year, a missing year to Overall. */
export function normalizePeriod(p: Period, list: readonly { closedAt: string }[]): Period {
  if (p.mode === "overall") return OVERALL;
  const av = availablePeriods(list);
  if (p.year == null || !av.years.includes(p.year)) return OVERALL;
  if (p.mode === "year") return { mode: "year", year: p.year, month: null };
  return p.month != null && av.months[p.year]!.includes(p.month) ? p : { mode: "year", year: p.year, month: null };
}

export function filterClosed<T extends { closedAt: string }>(list: readonly T[], p: Period): T[] {
  if (p.mode === "overall") return [...list];
  return list.filter((c) => {
    const x = istYearMonth(c.closedAt);
    return x != null && x.y === p.year && (p.mode === "year" || x.m === p.month);
  });
}

export const periodLabel = (p: Period) => (p.mode === "overall" ? "overall" : p.mode === "year" ? String(p.year) : `${monthName(p.month!)} ${p.year}`);
