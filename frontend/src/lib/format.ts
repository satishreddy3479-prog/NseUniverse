// Display formatting. Missing values render as an em dash, never as 0.

export const MISSING = "—";

const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intIN = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function fmtPrice(v: number | null | undefined): string {
  return v == null ? MISSING : inr2.format(v);
}

export function fmtInt(v: number | null | undefined): string {
  return v == null ? MISSING : intIN.format(v);
}

export function fmtSigned(v: number | null | undefined): string {
  if (v == null) return MISSING;
  const s = intIN.format(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null) return MISSING;
  const s = Math.abs(v).toFixed(2);
  return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
}

const istTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const expiryFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function fmtTimeIST(iso: string | null | undefined): string {
  return iso ? `${istTime.format(new Date(iso))} IST` : MISSING;
}

export function fmtDateTimeIST(iso: string | null | undefined): string {
  return iso ? `${istDateTime.format(new Date(iso))} IST` : MISSING;
}

/** Expiry dates are calendar dates (YYYY-MM-DD) with no time zone. */
export function fmtExpiry(d: string | null | undefined): string {
  return d ? expiryFmt.format(new Date(`${d}T00:00:00Z`)) : MISSING;
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null) return MISSING;
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function ageSeconds(iso: string | null | undefined, now: number = Date.now()): number | null {
  return iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : null;
}
