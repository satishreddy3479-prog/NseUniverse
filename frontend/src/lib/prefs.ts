/**
 * Display preferences that follow the owner, not the browser: saved chart layouts, chosen candle lengths, the theme, the capital figure, read marks and the like.
 *
 * The app keeps writing them to localStorage exactly as before (so no page changes), and this module mirrors every such write to the server (/api/prefs) and, when the
 * app opens, brings the server's copy back before the first page is drawn. A second browser or PC therefore shows the same layouts and choices.
 *
 *  - What is shared: every key that starts with "nse." or "nse-universe." (and "newsSeenAt"), except the denied ones below. Strategies are not preferences: they have their own server
 *    store and the builder's working copy stays in the browser.
 *  - Conflicts: the server stamps every write with its own clock; devices' clocks are never compared. A key changed here and not yet sent (``dirty``) wins and is sent; otherwise the
 *    server's newer copy replaces this browser's. A removal is a tombstone on the server, so it reaches the other devices instead of their old copy bringing the key back.
 *  - First use on a device: a key this browser holds that was never synced is uploaded when the server has none, and replaced by the server's copy when it has one.
 *  - Offline: the app opens with this browser's values after a short wait, keeps its unsent changes and sends them when the server answers again.
 */
const META_KEY = "nse.prefs.sync.v1";
const DENY = ["nse.prefs.", "nse.builder.working", "nse.strategies", "nse.closed", "nse.builder.temp", "nse.builder.open-closed", "nse.builder.expired", "nse.layout.v1.probe"];
const FLUSH_MS = 600;
const RETRY_MS = 20_000;

export const isSynced = (key: string): boolean => (key.startsWith("nse.") || key.startsWith("nse-universe.") || key === "newsSeenAt") && !DENY.some((d) => key.startsWith(d));

interface Meta { at: string | null; dirty: boolean }
type MetaMap = Record<string, Meta>;
interface Remote { value: string | null; updatedAt: string }

const proto = typeof Storage === "undefined" ? null : Storage.prototype;
const orig = proto ? { set: proto.setItem, remove: proto.removeItem, get: proto.getItem } : null;
let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// these three read and write localStorage through the original methods, so the module's own bookkeeping is never mirrored
const rawGet = (k: string): string | null => { try { return orig ? orig.get.call(localStorage, k) : null; } catch { return null; } };
const rawSet = (k: string, v: string): void => { try { orig?.set.call(localStorage, k, v); } catch { /* storage unavailable */ } };
const rawRemove = (k: string): void => { try { orig?.remove.call(localStorage, k); } catch { /* storage unavailable */ } };

function readMeta(): MetaMap {
  try { const v = JSON.parse(rawGet(META_KEY) ?? "{}") as MetaMap; return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
const writeMeta = (m: MetaMap) => rawSet(META_KEY, JSON.stringify(m));

function markDirty(key: string): void {
  const m = readMeta();
  m[key] = { at: m[key]?.at ?? null, dirty: true };
  writeMeta(m);
  schedule(FLUSH_MS);
}

function schedule(ms: number): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void flushPrefs(); }, ms);
}

/** Mirror localStorage writes of shared keys. Call once, after the first hydration (so the app's own start-up writes of defaults are not taken for changes). */
export function installPrefsSync(): void {
  if (installed || !proto || !orig) return;
  installed = true;
  proto.setItem = function (this: Storage, k: string, v: string) {
    const before = this === localStorage && isSynced(k) ? orig.get.call(this, k) : undefined;
    orig.set.call(this, k, v);
    if (before !== undefined && before !== String(v)) markDirty(k);
  };
  proto.removeItem = function (this: Storage, k: string) {
    const had = this === localStorage && isSynced(k) ? orig.get.call(this, k) !== null : false;
    orig.remove.call(this, k);
    if (had) markDirty(k);
  };
}

export function uninstallPrefsSync(): void {
  if (!installed || !proto || !orig) return;
  proto.setItem = orig.set;
  proto.removeItem = orig.remove;
  installed = false;
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
}

/** Send every unsent change. A key that fails stays unsent and is tried again later. Resolves true when nothing is left unsent. */
export async function flushPrefs(): Promise<boolean> {
  const m = readMeta();
  const keys = Object.keys(m).filter((k) => m[k]!.dirty && isSynced(k));
  let allSent = true;
  for (const k of keys) {
    const sent = rawGet(k);
    try {
      const res = sent === null
        ? await fetch(`/api/prefs/${encodeURIComponent(k)}`, { method: "DELETE" })
        : await fetch(`/api/prefs/${encodeURIComponent(k)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: sent }) });
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()) as Remote;
      const now = readMeta();
      // changed again while it was being sent: that newer value is still unsent
      now[k] = { at: r.updatedAt, dirty: rawGet(k) !== sent };
      writeMeta(now);
      if (now[k]!.dirty) allSent = false;
    } catch {
      allSent = false;
    }
  }
  if (!allSent) schedule(RETRY_MS);
  return allSent;
}

export interface HydrateResult { ok: boolean; applied: number; pushed: number }

/** Bring the server's preferences into this browser before the app is drawn. Never throws; with no answer within ``timeoutMs`` the app opens with this browser's values. */
export async function hydratePrefs(timeoutMs = 2500): Promise<HydrateResult> {
  let remote: Record<string, Remote>;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch("/api/prefs", { headers: { Accept: "application/json" }, signal: ctl.signal });
      if (!res.ok) return { ok: false, applied: 0, pushed: 0 };
      remote = ((await res.json()) as { prefs?: Record<string, Remote> }).prefs ?? {};
    } finally {
      clearTimeout(t);
    }
  } catch {
    return { ok: false, applied: 0, pushed: 0 };
  }
  const meta = readMeta();
  let applied = 0, pushed = 0;
  for (const [k, r] of Object.entries(remote)) {
    if (!isSynced(k)) continue;
    const m = meta[k];
    if (m?.dirty) continue; // changed here and not sent yet: this browser's copy wins and is sent below
    if (m?.at === r.updatedAt) continue; // already the server's version
    if (r.value === null) { if (rawGet(k) !== null) { rawRemove(k); applied++; } } else if (rawGet(k) !== r.value) { rawSet(k, r.value); applied++; }
    meta[k] = { at: r.updatedAt, dirty: false };
  }
  // first use of this browser: what it holds and the server does not is sent
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isSynced(k) && !(k in remote) && !meta[k]?.dirty) { meta[k] = { at: null, dirty: true }; pushed++; }
  }
  // a removal made while the server was away
  for (const [k, m] of Object.entries(meta)) if (m.dirty && !isSynced(k)) delete meta[k];
  writeMeta(meta);
  if (Object.values(meta).some((m) => m.dirty)) void flushPrefs();
  return { ok: true, applied, pushed };
}
