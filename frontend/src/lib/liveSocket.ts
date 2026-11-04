import type { LiveStore } from "./liveStore";
import type { ServerMessage } from "./types";

export interface SocketOptions {
  url?: string;
  /** No message for this long (server sends status every second) => treat the link as dead. */
  deadAfterMs?: number;
  maxBackoffMs?: number;
}

export function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/market-data`;
}

/**
 * Keeps one WebSocket to the backend alive: bounded exponential backoff, dead-link detection,
 * and a clean stop() that removes every handler and timer (safe under React StrictMode).
 * The browser never talks to the broker; it only receives normalized backend messages.
 */
export function startLiveSocket(store: LiveStore, opts: SocketOptions = {}): () => void {
  const deadAfter = opts.deadAfterMs ?? 10_000;
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let lastMsg = Date.now();

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (watchdog) clearInterval(watchdog);
    retryTimer = undefined;
    watchdog = undefined;
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    attempt += 1;
    // the first retry is almost immediate: a dropped link is usually a server-side slow-client drop or a proxy hiccup
    const delay = attempt === 1 ? 300 : Math.min(maxBackoff, 1000 * 2 ** (attempt - 2));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    store.setConn("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url ?? defaultUrl());
    } catch {
      store.setConn("closed");
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      lastMsg = Date.now();
      store.setConn("open");
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (ws !== socket) return;
      lastMsg = Date.now();
      attempt = 0;
      try {
        store.apply(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* malformed frame: ignore, keep the connection */
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      store.setConn("closed");
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows; nothing to do */
    };
  };

  /**
   * The page came back (phone unlocked, tab shown, network back). Timers were frozen while it was away, so the old
   * socket is usually dead even if it looks open: reconnect at once instead of waiting for the dead-link timer and the
   * backoff. The server answers with a full snapshot of its live book (the "hello" message), so nothing is lost.
   */
  const resume = () => {
    if (stopped || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const quiet = Date.now() - lastMsg;
    if (ws && ws.readyState === WebSocket.OPEN && quiet < 4000) return; // healthy: the server sends something every second
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    const old = ws;
    ws = null;
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* already closed */ } }
    attempt = 0;
    connect();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);

  connect();
  watchdog = setInterval(() => {
    if (ws && Date.now() - lastMsg > deadAfter) ws.close(); // triggers onclose -> reconnect
  }, 2000);

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
    clearTimers();
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    store.setConn("closed");
  };
}
