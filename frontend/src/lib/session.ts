/**
 * The NSE regular session the dashboards cover (IST). The open and the close come from the backend
 * (`/api/market/session`), which follows the exchange feed. Until the answer arrives, or if the backend is unreachable, the schedule below
 * is used: F&O closes at 15:40 from 3 Aug 2026 and at 15:45 from Monday 7 Dec 2026, when continuous cash trading also runs to 15:30 and
 * the closing auction session moves from 15:15-15:35 to 15:30-15:40. Exchange holidays arrive in the same answer.
 */
export interface SessionClock { open: string; close: string; label: string; source: string; holidays: string[] }

/** The first trading day of the second closing-auction schedule (the backend carries the same date: app/domain/session.py). */
export const CAS_SECOND_DAY = "2026-12-07";
export const CAS_FIRST_DAY = "2026-08-03";
/** Today's IST date (YYYY-MM-DD). */
const istToday = (ms: number = Date.now()): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/** The F&O session close the schedule gives for a day (IST date), until the exchange feed confirms or contradicts it. */
export const defaultCloseFor = (ymd: string): string => (ymd >= CAS_SECOND_DAY ? "15:45" : ymd >= CAS_FIRST_DAY ? "15:40" : "15:30");

export interface ClosingSchedule { cashEnd: string; indicativeFrom: string; indexEnd: string }
/**
 * The closing auction of a day. The cash segment, and so the index, is silent from `cashEnd` (continuous trading ended, last traded prices pause), shows the exchange's
 * indicative closing values from `indicativeFrom` to `indexEnd`. Until 4 Dec 2026: 15:15 / 15:20 / 15:30 (seen live on 19 Nov 2026); from 7 Dec 2026: 15:30 / 15:31 / 15:40 (Kotak Neo).
 */
export const closingSchedule = (ymd: string): ClosingSchedule =>
  ymd >= CAS_SECOND_DAY ? { cashEnd: "15:30", indicativeFrom: "15:31", indexEnd: "15:40" } : { cashEnd: "15:15", indicativeFrom: "15:20", indexEnd: "15:30" };

/**
 * The time from which the NIFTY index level is no longer collected or charted on a day: the end of continuous cash trading (15:15 until 4 Dec 2026, 15:30 from 7 Dec). After it the
 * exchange publishes only indicative auction values, shown live at the top but never stored. Null before the closing auction existed (3 Aug 2026). Option, OI and volume data go on to the F&O close.
 */
export const spotEndFor = (ymd: string): string | null => (ymd >= CAS_FIRST_DAY ? closingSchedule(ymd).cashEnd : null);

const defaultClock = (): SessionClock => { const close = defaultCloseFor(istToday()); return { open: "09:15", close, label: `09:15–${close}`, source: "schedule default (until the backend answers)", holidays: [] }; };
let clock: SessionClock = defaultClock();
let holidaySet = new Set<string>();
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function setSessionClock(next: SessionClock): void { clock = next; holidaySet = new Set(next.holidays); }
/** Test hook: back to the schedule default for today. */
export function resetSessionClock(): void { clock = defaultClock(); holidaySet = new Set(); }
export const getSessionClock = (): SessionClock => clock;
export const sessionOpenMin = (): number => toMin(clock.open);
export const sessionCloseMin = (): number => toMin(clock.close);
export const sessionLabel = (): string => clock.label;
export const sessionCloseHHMM = (): string => clock.close;
/** An exchange holiday on a weekday, from the verified NSE circular list (YYYY-MM-DD, IST date). */
export const isHoliday = (ymd: string): boolean => holidaySet.has(ymd);

/**
 * The moment the market last showed these prices: the time itself during the session, otherwise the close of the
 * latest weekday session before it. A chain fetched at 02:37 the next morning holds the prices of the 15:40 close (15:45 from 7 Dec 2026), so
 * time decay in the model must be counted from the close, not from the fetch. Exchange holidays (from the backend) are skipped.
 */
export function marketClockMs(ms: number): number {
  const IST = 330 * 60_000;
  const d = new Date(ms + IST);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const trading = (x: Date) => x.getUTCDay() !== 0 && x.getUTCDay() !== 6 && !isHoliday(x.toISOString().slice(0, 10));
  const weekday = trading(d);
  const closeOf = (t: number) => { const x = new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 0, sessionCloseMin()) - IST; };
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (weekday && min >= sessionOpenMin() && min <= sessionCloseMin()) return ms;
  if (weekday && min > sessionCloseMin()) return closeOf(day);
  let t = day;
  do { t -= 86_400_000; } while (!trading(new Date(t)));
  return closeOf(t);
}
