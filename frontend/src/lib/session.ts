/**
 * The NSE regular session the dashboards cover (IST). Equity derivatives (NIFTY futures and options) trade
 * 09:15-15:40 since 3 Aug 2026 (Closing Auction Session alignment). Keep in step with backend/app/domain/session.py.
 */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 40;
export const SESSION_LABEL = "09:15–15:40";
export const SESSION_CLOSE_HHMM = "15:40";
