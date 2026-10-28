import type { LiveTick, MarketStatus, ServerMessage, StreamStatus } from "./types";

export const INDEX_KEY = "nse_cm|Nifty 50";

export type ConnState = "connecting" | "open" | "closed";

export interface LiveState {
  conn: ConnState;
  status: StreamStatus | null;
  /** Browser-side time of the last message from the backend (for dead-link detection). */
  lastMessageAt: number | null;
  messagesReceived: number;
  ticksApplied: number;
}

const INITIAL: LiveState = {
  conn: "closed", status: null, lastMessageAt: null, messagesReceived: 0, ticksApplied: 0,
};

/** External store: per-instrument subscriptions keep re-renders to the rows whose values changed. */
export class LiveStore {
  private ticks = new Map<string, LiveTick>();
  private tickSubs = new Map<string, Set<() => void>>();
  private stateSubs = new Set<() => void>();
  private anySubs = new Set<() => void>();
  private version = 0;
  private state: LiveState = INITIAL;

  getState = (): LiveState => this.state;
  getTick = (key: string): LiveTick | undefined => this.ticks.get(key);
  size = (): number => this.ticks.size;
  /** Bumps whenever any tick is applied; used by aggregates (totals) that depend on many instruments. */
  getVersion = (): number => this.version;

  subscribeAny = (cb: () => void): (() => void) => {
    this.anySubs.add(cb);
    return () => void this.anySubs.delete(cb);
  };

  private bump(): void {
    this.version += 1;
    this.anySubs.forEach((cb) => cb());
  }

  subscribeState = (cb: () => void): (() => void) => {
    this.stateSubs.add(cb);
    return () => void this.stateSubs.delete(cb);
  };

  subscribeTick = (key: string, cb: () => void): (() => void) => {
    let set = this.tickSubs.get(key);
    if (!set) this.tickSubs.set(key, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.tickSubs.delete(key);
    };
  };

  private setState(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    this.stateSubs.forEach((cb) => cb());
  }

  private notifyTick(key: string): void {
    this.tickSubs.get(key)?.forEach((cb) => cb());
  }

  setConn(conn: ConnState): void {
    if (conn !== this.state.conn) this.setState({ conn });
  }

  /** Apply one server message. Out-of-order or repeated ticks (lower/equal seq) are ignored. */
  apply(msg: ServerMessage, now: number = Date.now()): void {
    const base = { lastMessageAt: now, messagesReceived: this.state.messagesReceived + 1 };
    switch (msg.type) {
      case "hello": {
        const old = [...this.ticks.keys()];
        this.ticks = new Map(msg.ticks.map((t) => [t.key, t]));
        this.setState({ ...base, status: msg.status, ticksApplied: this.state.ticksApplied + msg.ticks.length });
        new Set([...old, ...this.ticks.keys()]).forEach((k) => this.notifyTick(k));
        this.bump();
        break;
      }
      case "ticks": {
        let applied = 0;
        for (const t of msg.ticks) {
          const prev = this.ticks.get(t.key);
          if (prev && t.seq <= prev.seq) continue;
          this.ticks.set(t.key, t);
          applied++;
          this.notifyTick(t.key);
        }
        this.setState({ ...base, ticksApplied: this.state.ticksApplied + applied });
        if (applied > 0) this.bump();
        break;
      }
      case "status":
        this.setState({ ...base, status: msg.status });
        break;
      case "market": {
        const status = this.state.status;
        this.setState({ ...base, status: status ? { ...status, market: msg.market as MarketStatus } : status });
        break;
      }
    }
  }

  reset(): void {
    const keys = [...this.ticks.keys()];
    this.ticks = new Map();
    this.state = INITIAL;
    keys.forEach((k) => this.notifyTick(k));
    this.stateSubs.forEach((cb) => cb());
    this.bump();
  }
}

export const liveStore = new LiveStore();
