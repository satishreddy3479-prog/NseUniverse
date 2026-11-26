/**
 * Keeps the open app on the newest build.
 *
 * Every build has its own main script name (``/assets/index-<hash>.js``). The page asks the server for the current index page (never from a cache) and compares
 * that name with the script it is running. At start-up a page that is older than the server reloads itself once (nothing is lost yet); a tab that stays open
 * is told by a banner when a newer build appears, and "Reload" drops the service worker's copies first so the reload cannot bring the old page back.
 */
import { reloadOnceForUpdate } from "./chunkReload";

const MAIN = /\/assets\/index-[\w-]+\.js/;

/** The main script name of the running page (null in dev or tests, where there is no hashed build). */
export function runningBuild(doc: Document = document): string | null {
  for (const s of Array.from(doc.querySelectorAll("script[src]"))) {
    const m = MAIN.exec(s.getAttribute("src") ?? "");
    if (m) return m[0];
  }
  return null;
}

/** The main script name in an index page's HTML. */
export function buildIn(html: string): string | null {
  return MAIN.exec(html)?.[0] ?? null;
}

/** The server's current build, or null when it cannot be read (offline, login prompt, an error page). */
export async function serverBuild(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetcher("/", { cache: "no-store", headers: { accept: "text/html" } });
    if (!r.ok) return null;
    return buildIn(await r.text());
  } catch { return null; }
}

/** Forget every cached copy (the service worker's shell and files), so the next load comes from the server. */
export async function dropCaches(): Promise<void> {
  try {
    if ("caches" in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    if ("serviceWorker" in navigator) await Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => r.update().catch(() => undefined)));
  } catch { /* the reload still goes ahead */ }
}

export async function reloadFresh(): Promise<void> {
  await dropCaches();
  window.location.reload();
}

/** At start-up: a page older than the server reloads itself once (the guard stops a loop if the server keeps answering with another name). */
export async function checkAtStart(): Promise<void> {
  const mine = runningBuild();
  if (!mine) return;
  const now = await serverBuild();
  if (now && now !== mine) { await dropCaches(); reloadOnceForUpdate(); }
}

/** For a tab that stays open: calls ``onNewer`` when the server has a build other than the running one; checks on focus and every few minutes. Returns a stop function. */
export function watchBuild(onNewer: () => void, everyMs = 180_000): () => void {
  const mine = runningBuild();
  if (!mine) return () => undefined;
  let done = false;
  const check = async () => {
    if (done || document.visibilityState === "hidden") return;
    const now = await serverBuild();
    if (now && now !== mine) { done = true; onNewer(); }
  };
  const t = window.setInterval(() => void check(), everyMs);
  const onVis = () => { if (document.visibilityState === "visible") void check(); };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("focus", onVis);
  return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
}
