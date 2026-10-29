/**
 * The NSE regular session the dashboards cover (IST). Equity derivatives (NIFTY futures and options) trade
 * 09:15-15:40 since 3 Aug 2026 (Closing Auction Session alignment). Keep in step with backend/app/domain/session.py.
 */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 40;
export const SESSION_LABEL = "09:15–15:40";
export const SESSION_CLOSE_HHMM = "15:40";

/**
 * The moment the market last showed these prices: the time itself during the session, otherwise the close of the
 * latest weekday session before it. A chain fetched at 02:37 the next morning holds the prices of the 15:40 close, so
 * time decay in the model must be counted from 15:40, not from the fetch. Exchange holidays are not known here, so a
 * fetch after a holiday is dated to the previous weekday's close.
 */
export function marketClockMs(ms: number): number {
  const IST = 330 * 60_000;
  const d = new Date(ms + IST);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const weekday = d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
  const closeOf = (t: number) => { const x = new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 0, SESSION_CLOSE_MIN) - IST; };
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (weekday && min >= SESSION_OPEN_MIN && min <= SESSION_CLOSE_MIN) return ms;
  if (weekday && min > SESSION_CLOSE_MIN) return closeOf(day);
  let t = day;
  do { t -= 86_400_000; } while (new Date(t).getUTCDay() === 0 || new Date(t).getUTCDay() === 6);
  return closeOf(t);
}
