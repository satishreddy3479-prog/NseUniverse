import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { clipSeries } from "../../lib/replay";

/** Replay of one stored session on a tool page: the day, how far it has played, and whether it is playing. Off until the user starts it. */
export interface ReplayState {
  on: boolean;
  day: string | null;
  /** Everything after this instant (ms) is hidden; null while replay is off. */
  cutMs: number | null;
  playing: boolean;
  speed: number;
  start: (day: string, firstMs: number) => void;
  stop: () => void;
  setDay: (day: string, firstMs: number) => void;
  setCut: (ms: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (n: number) => void;
}

const OFF: ReplayState = {
  on: false, day: null, cutMs: null, playing: false, speed: 1,
  start: () => undefined, stop: () => undefined, setDay: () => undefined, setCut: () => undefined, setPlaying: () => undefined, setSpeed: () => undefined,
};

const Ctx = createContext<ReplayState>(OFF);

export function ReplayProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState({ on: false, day: null as string | null, cutMs: null as number | null, playing: false, speed: 1 });
  const start = useCallback((day: string, firstMs: number) => setS((p) => ({ ...p, on: true, day, cutMs: firstMs, playing: true })), []);
  const stop = useCallback(() => setS((p) => ({ ...p, on: false, day: null, cutMs: null, playing: false })), []);
  const setDay = useCallback((day: string, firstMs: number) => setS((p) => ({ ...p, day, cutMs: firstMs, playing: false })), []);
  const setCut = useCallback((ms: number) => setS((p) => ({ ...p, cutMs: ms })), []);
  const setPlaying = useCallback((playing: boolean) => setS((p) => ({ ...p, playing })), []);
  const setSpeed = useCallback((speed: number) => setS((p) => ({ ...p, speed })), []);
  const value = useMemo<ReplayState>(() => ({ ...s, start, stop, setDay, setCut, setPlaying, setSpeed }), [s, start, stop, setDay, setCut, setPlaying, setSpeed]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The replay of the page this is rendered in; "off" outside a replay-capable page. */
export function useReplay(): ReplayState {
  return useContext(Ctx);
}

/** A per-time series cut at the replay time (the series itself when no replay is running). */
export function useClipped<T extends { times: string[] }>(series: T | undefined | null): T | undefined {
  const { cutMs } = useReplay();
  return useMemo(() => (series ? clipSeries(series, cutMs) : undefined), [series, cutMs]);
}
