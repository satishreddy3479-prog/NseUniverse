import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LiveStore } from "../lib/liveStore";
import { startLiveSocket } from "../lib/liveSocket";
import { liveTick, streamStatus } from "./fixtures";

describe("LiveStore", () => {
  it("applies hello, then newer ticks, and ignores repeats and out-of-order ones", () => {
    const s = new LiveStore();
    s.apply({ type: "hello", status: streamStatus(), ticks: [liveTick({ seq: 5, ltp: 100 })] });
    expect(s.getTick("nse_fo|101")?.ltp).toBe(100);
    s.apply({ type: "ticks", ticks: [liveTick({ seq: 4, ltp: 90 })] }); // older
    s.apply({ type: "ticks", ticks: [liveTick({ seq: 5, ltp: 91 })] }); // same seq
    expect(s.getTick("nse_fo|101")?.ltp).toBe(100);
    s.apply({ type: "ticks", ticks: [liveTick({ seq: 6, ltp: 101 })] });
    expect(s.getTick("nse_fo|101")?.ltp).toBe(101);
    expect(s.getState().ticksApplied).toBe(2);
  });

  it("notifies only the subscribers of the instruments that changed (row-level updates)", () => {
    const s = new LiveStore();
    const a = vi.fn(), b = vi.fn(), st = vi.fn();
    s.subscribeTick("nse_fo|101", a);
    s.subscribeTick("nse_fo|102", b);
    s.subscribeState(st);
    s.apply({ type: "ticks", ticks: [liveTick({ seq: 1 })] });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(st).toHaveBeenCalled();
  });

  it("hello replaces the whole book so a reconnect cannot leave stale instruments behind", () => {
    const s = new LiveStore();
    const gone = vi.fn();
    s.apply({ type: "hello", status: streamStatus(), ticks: [liveTick({ key: "nse_fo|1", seq: 1 })] });
    s.subscribeTick("nse_fo|1", gone);
    s.apply({ type: "hello", status: streamStatus(), ticks: [liveTick({ key: "nse_fo|2", instrument_token: "2", seq: 1 })] });
    expect(s.getTick("nse_fo|1")).toBeUndefined();
    expect(gone).toHaveBeenCalled();
  });

  it("unsubscribe removes the listener (no leaks)", () => {
    const s = new LiveStore();
    const cb = vi.fn();
    const off = s.subscribeTick("k", cb);
    off();
    s.apply({ type: "ticks", ticks: [liveTick({ key: "k", seq: 1 })] });
    expect(cb).not.toHaveBeenCalled();
  });

  it("market messages update the status without dropping other fields", () => {
    const s = new LiveStore();
    s.apply({ type: "status", status: streamStatus({ message_count: 7 }) });
    s.apply({ type: "market", market: { state: "closed", code: 2, text: "Market closed", exchange_segment: null, received_at: null, source: "exchange_feed" } });
    expect(s.getState().status?.message_count).toBe(7);
    expect(s.getState().status?.market.state).toBe("closed");
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe("startLiveSocket", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects, applies messages, and reconnects with exponential backoff after a drop", () => {
    const store = new LiveStore();
    const stop = startLiveSocket(store, { url: "ws://x/ws" });
    expect(store.getState().conn).toBe("connecting");
    FakeSocket.instances[0]!.open();
    expect(store.getState().conn).toBe("open");
    FakeSocket.instances[0]!.send({ type: "status", status: streamStatus({ message_count: 3 }) });
    expect(store.getState().status?.message_count).toBe(3);

    FakeSocket.instances[0]!.close(); // drop
    expect(store.getState().conn).toBe("closed");
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2); // 1 s backoff
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.close(); // fails again: next delay is 2 s
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(FakeSocket.instances).toHaveLength(3);
    stop();
  });

  it("treats a silent link as dead and reconnects", () => {
    const store = new LiveStore();
    const stop = startLiveSocket(store, { url: "ws://x/ws", deadAfterMs: 5000 });
    FakeSocket.instances[0]!.open();
    vi.advanceTimersByTime(8000); // watchdog closes the silent socket
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it("stop() closes the socket, cancels retries and leaves no handlers (StrictMode safe)", () => {
    const store = new LiveStore();
    const stop = startLiveSocket(store, { url: "ws://x/ws" });
    const sock = FakeSocket.instances[0]!;
    sock.open();
    stop();
    expect(sock.closed).toBe(true);
    expect(sock.onmessage).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(store.getState().conn).toBe("closed");
  });

  it("ignores malformed frames without dropping the connection", () => {
    const store = new LiveStore();
    const stop = startLiveSocket(store, { url: "ws://x/ws" });
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.onmessage?.({ data: "not json{" });
    expect(store.getState().conn).toBe("open");
    stop();
  });
});
