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
    const delay = Math.min(maxBackoff, 1000 * 2 ** (attempt - 1));
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

  connect();
  watchdog = setInterval(() => {
    if (ws && Date.now() - lastMsg > deadAfter) ws.close(); // triggers onclose -> reconnect
  }, 2000);

  return () => {
    stopped = true;
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
