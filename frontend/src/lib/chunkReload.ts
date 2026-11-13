/**
 * Recovery from a page that cannot be loaded because the app was updated while the tab was open.
 *
 * Every deploy produces new hashed files. A tab (or the installed app) opened before the deploy still asks for the old
 * names; when one is gone the browser cannot load that page and React, without a boundary, shows a blank screen until the
 * person reloads. Here such a failure is recognised and the page is reloaded once, which fetches the new build.
 */
const KEY = "nse-universe.chunk-reload-at";
/** A second failure within this time is a real problem, not an update: show the message instead of reloading again and again. */
export const RELOAD_GUARD_MS = 30_000;

const PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chrome, Edge
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /loading chunk [\w-]+ failed/i,
  /loading css chunk/i,
  /unable to preload css/i,
  /is not a valid javascript mime type/i, // the server answered with the index page instead of the file
  /unexpected token '<'/i, // the same, seen as a syntax error
];

/** True when the error says a built file could not be fetched or parsed (as opposed to a bug in a page). */
export function isChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  return PATTERNS.some((p) => p.test(msg));
}

/** Reload the page once for an update; returns false (and does nothing) when it already did so a moment ago. */
export function reloadOnceForUpdate(now = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (last && now - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // storage unavailable: reload anyway; the browser itself stops a tight loop of failed loads
  }
  reload();
  return true;
}

/** True while a background warm-up of the other pages is loading one: its failure (a network blip) must not reload the page the person is on. */
export const warmUp = { active: false };

/**
 * Called once at start-up: Vite raises this event when a lazy file cannot be fetched, before React sees any error.
 * Cancelling the event makes Vite swallow the error (the page would then fail later with a confusing "reading 'default'"),
 * so it is cancelled only when the reload really happens; a second failure goes on to the page boundary with its true message.
 */
export function watchForStaleBuild(reload?: () => void): void {
  window.addEventListener("vite:preloadError", (e) => {
    if (warmUp.active) return;
    if (reloadOnceForUpdate(Date.now(), reload)) e.preventDefault();
  });
}
