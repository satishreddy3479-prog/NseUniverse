import { useEffect, useMemo } from "react";
import { REPLAY_SPEEDS, replayDays, replaySteps, stepAt } from "../../lib/replay";
import { useDash } from "./DashContext";
import { fmtDay } from "./PriceBoards";
import { useReplay } from "./ReplayContext";

const btn = (on: boolean) => `widget-nodrag min-h-9 rounded-sm border px-3 text-sm ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/**
 * The replay control of a tool page. Off by default: the page shows live or last-session data as always. "Replay" plays a stored
 * session from its first sample, one stored sample at a time, and every chart of the page shows only what was known up to that moment.
 */
export function ReplayBar() {
  const d = useDash();
  const rp = useReplay();
  const raw = d.historyRaw.data?.observations;
  const days = useMemo(() => replayDays(raw), [raw]);
  const day = rp.day ?? days[0] ?? null;
  const steps = useMemo(() => replaySteps(raw, day), [raw, day]);
  const at = rp.cutMs == null ? -1 : stepAt(steps, rp.cutMs);

  // advance one stored sample at a time; speed is samples per second
  useEffect(() => {
    if (!rp.on || !rp.playing || steps.length === 0) return;
    const id = setInterval(() => {
      const i = rp.cutMs == null ? -1 : stepAt(steps, rp.cutMs);
      if (i + 1 >= steps.length) { rp.setPlaying(false); return; }
      rp.setCut(steps[i + 1]!);
    }, 1000 / rp.speed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rp.on, rp.playing, rp.speed, rp.cutMs, steps]);

  if (!d.expiry) return null;
  if (!rp.on) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2" data-testid="replay-bar">
        <button type="button" disabled={days.length === 0 || steps.length === 0} onClick={() => day && steps.length && rp.start(day, steps[0]!)} className={btn(false)}
          title="Play a stored session from its first sample: every chart on this page shows only what was known up to that moment">▶ Replay</button>
        <span className="text-xs text-muted">{days.length === 0 ? "No stored session to replay yet." : "Replay a stored session minute by minute, as it looked live."}</span>
      </div>
    );
  }
  const atEnd = at >= steps.length - 1;
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-brass bg-slate px-3 py-2" data-testid="replay-bar" role="group" aria-label="Replay">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="rounded-sm bg-brass/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-paper">Replay</span>
        <label className="flex items-center gap-2 text-xs text-muted">Day
          <select aria-label="Replay day" value={day ?? ""} onChange={(e) => { const nd = e.target.value; const st = replaySteps(raw, nd); if (st.length) rp.setDay(nd, st[0]!); }}
            className="widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper">
            {days.map((x, i) => <option key={x} value={x}>{fmtDay(x, i === 0)}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { if (atEnd && steps.length) { rp.setCut(steps[0]!); rp.setPlaying(true); } else rp.setPlaying(!rp.playing); }} className={btn(rp.playing)}>{rp.playing ? "❚❚ Pause" : atEnd ? "↺ Replay again" : "▶ Play"}</button>
        <button type="button" aria-label="Step back one sample" disabled={at <= 0} onClick={() => { rp.setPlaying(false); rp.setCut(steps[Math.max(0, at - 1)]!); }} className={btn(false)}>‹</button>
        <button type="button" aria-label="Step forward one sample" disabled={atEnd} onClick={() => { rp.setPlaying(false); rp.setCut(steps[Math.min(steps.length - 1, at + 1)]!); }} className={btn(false)}>›</button>
        <label className="flex items-center gap-2 text-xs text-muted">Speed
          <select aria-label="Replay speed" value={rp.speed} onChange={(e) => rp.setSpeed(Number(e.target.value))} className="widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper">
            {REPLAY_SPEEDS.map((s) => <option key={s} value={s}>{s}× ({s} min per second)</option>)}
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 items-center gap-3 text-xs text-muted">Time
          <input type="range" aria-label="Replay time" min={0} max={Math.max(0, steps.length - 1)} value={Math.max(0, at)} onChange={(e) => { rp.setPlaying(false); rp.setCut(steps[Number(e.target.value)]!); }} className="flex-1 accent-[var(--brass)]" />
          <span className="num text-paper" data-testid="replay-time">{rp.cutMs != null ? `${hhmm(rp.cutMs)} IST` : ""}</span>
        </label>
        <button type="button" onClick={rp.stop} className={btn(false)} title="Back to the live or last-session view">Exit replay</button>
      </div>
      <p className="text-[11px] text-muted" data-testid="replay-note">
        Replaying {day ? fmtDay(day, day === days[0]) : ""}: every chart on this page shows what was stored up to {rp.cutMs != null ? hhmm(rp.cutMs) : "—"} IST and nothing later. Sample {Math.max(0, at) + 1} of {steps.length}. Stored samples are about a minute apart; a minute that was not recorded is not filled in.
      </p>
    </div>
  );
}
