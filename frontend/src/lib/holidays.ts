/** Reading NSE's holiday circular as pasted text. Nothing here guesses: a line that is not a clear date is reported, never dropped quietly. */

export interface HolidayRow { date: string; name: string }
export interface ParsedLine { raw: string; date?: string; name?: string; weekend?: boolean; error?: string }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const DAYS = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b[\s,.:;|-]*/i;

const pad = (n: number) => String(n).padStart(2, "0");

/** A real calendar date as YYYY-MM-DD, or null. */
export function toYmd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export const isWeekend = (ymd: string): boolean => {
  const w = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};

/** The date at the start of ``s`` in one of the layouts NSE and people use, and the rest of the line. */
function leadingDate(s: string): { ymd: string | null; rest: string } | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (m) return { ymd: toYmd(+m[1]!, +m[2]!, +m[3]!), rest: s.slice(m[0].length) };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(s); // day first, the Indian order
  if (m) return { ymd: toYmd(+m[3]!, +m[2]!, +m[1]!), rest: s.slice(m[0].length) };
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-/.]+([A-Za-z]{3,9})\.?[\s-/.,]+(\d{4})\b/.exec(s);
  if (m) { const mo = MONTHS[m[2]!.toLowerCase()]; return { ymd: mo ? toYmd(+m[3]!, mo, +m[1]!) : null, rest: s.slice(m[0].length) }; }
  return null;
}

/** One entry per non-empty line. A leading serial number ("3 ") and a weekday word ("Tuesday") are skipped; the rest of the line is the name. */
export function parseHolidayText(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    let s = raw.replace(/\t+/g, " ").replace(/\s{2,}/g, " ");
    // a table row starts with a serial number ("3 26-Jan-2027 ..."): when the line does not begin with a date, try again without one
    let hit = leadingDate(s);
    if (!hit) {
      const serial = /^\d{1,3}[.)]?\s+/.exec(s);
      if (serial) { s = s.slice(serial[0].length); hit = leadingDate(s); }
    }
    if (!hit) { out.push({ raw, error: "No date at the start of this line." }); continue; }
    if (!hit.ymd) { out.push({ raw, error: "This is not a real calendar date." }); continue; }
    let rest = hit.rest.replace(/^[\s,.:;|-]+/, "");
    rest = rest.replace(DAYS, "").replace(/^[\s,.:;|-]+/, "").trim();
    if (isWeekend(hit.ymd)) { out.push({ raw, date: hit.ymd, name: rest, weekend: true }); continue; }
    if (!rest) { out.push({ raw, date: hit.ymd, error: "No holiday name on this line." }); continue; }
    out.push({ raw, date: hit.ymd, name: rest });
  }
  return out;
}

/** Merge parsed rows into the existing ones: the same date is kept once (the later text wins). */
export function mergeRows(existing: HolidayRow[], add: HolidayRow[]): HolidayRow[] {
  const by = new Map(existing.map((r) => [r.date, r]));
  for (const r of add) by.set(r.date, r);
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Whole days from ``today`` to ``ymd`` (negative when it is past). */
export function daysUntil(ymd: string, today: Date = new Date()): number {
  const a = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  const b = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}
