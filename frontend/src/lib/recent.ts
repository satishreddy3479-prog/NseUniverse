/** The pages opened most recently, newest first, kept on this device: Home offers them as "Jump back in". */
const KEY = "nse.recent.v1";
export const RECENT_MAX = 6;

export const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
};

/** Add a page to the front (once), drop the oldest beyond the limit. Home itself and unknown shapes are not kept. */
export function rememberPage(path: string, now: string[] = loadRecent()): string[] {
  if (!path.startsWith("/") || path === "/") return now;
  const next = [path, ...now.filter((p) => p !== path)].slice(0, RECENT_MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: kept for this visit only */ }
  return next;
}
