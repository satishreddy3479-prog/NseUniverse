/**
 * The NSE regular session the dashboards cover (IST). The open and the close come from the backend
 * (`/api/market/session`), which follows the exchange feed: the close is 15:40 while the Closing Auction Session
 * alignment is in force and returns to 15:30 on its own when NSE ends it. Until the answer arrives, or if the backend
 * is unreachable, the values below (15:40) are used. Exchange holidays arrive in the same answer.
 */
export interface SessionClock { open: string; close: string; label: string; source: string; holidays: string[] }

const DEFAULT: SessionClock = { open: "09:15", close: "15:40", label: "09:15–15:40", source: "default (until the backend answers)", holidays: [] };
let clock: SessionClock = DEFAULT;
let holidaySet = new Set<string>();
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function setSessionClock(next: SessionClock): void { clock = next; holidaySet = new Set(next.holidays); }
export const getSessionClock = (): SessionClock => clock;
export const sessionOpenMin = (): number => toMin(clock.open);
export const sessionCloseMin = (): number => toMin(clock.close);
export const sessionLabel = (): string => clock.label;
export const sessionCloseHHMM = (): string => clock.close;
/** An exchange holiday on a weekday, from the verified NSE circular list (YYYY-MM-DD, IST date). */
export const isHoliday = (ymd: string): boolean => holidaySet.has(ymd);

/**
 * The moment the market last showed these prices: the time itself during the session, otherwise the close of the
 * latest weekday session before it. A chain fetched at 02:37 the next morning holds the prices of the 15:40 close, so
 * time decay in the model must be counted from 15:40, not from the fetch. Exchange holidays (from the backend) are skipped.
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
