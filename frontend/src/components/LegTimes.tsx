import { fmtPrice } from "../lib/format";
import { fmtStamp, stripStamp, type Leg } from "../lib/strategy";

const Item = ({ label, children, cls = "" }: { label: string; children: React.ReactNode; cls?: string }) => (
  <span className={`whitespace-nowrap ${cls}`}><span className="text-muted">{label} </span><span className="text-paper">{children}</span></span>
);

/** The dates and times of one leg: when it was entered, when its stop and target were set or last moved (by you, the trailing stop, or "Move SL to cost"), when it exited,
 *  and its history lines, each with its own date and time (IST). `startedAt` is when the strategy was started on the server: used for a leg saved before its own entry time was kept. */
export function LegTimes({ leg, startedAt }: { leg: Leg; startedAt?: string | null }) {
  // a leg saved before it kept its own entry time falls back to when the strategy was last started, unless that is after the leg exited (then it cannot be the entry)
  const fallback = startedAt && (!leg.exitedAt || startedAt <= leg.exitedAt) ? startedAt : null;
  const entered = leg.enteredAt ?? fallback;
  const exited = leg.exitPrice != null;
  const stopMoved = !!(leg.stopTrailed || leg.costMoved);
  const log = leg.log ?? [];
  const older = log.slice(0, Math.max(0, log.length - 3));
  const line = (x: { at: string; text: string }, i: number) => <div key={`${x.at}-${i}`}><span className="num text-paper">{fmtStamp(x.at)}</span> · {stripStamp(x.text)}</div>;
  if (leg.premium == null && !exited && log.length === 0) return null;
  return (
    <div className="mt-1 text-[11px]" data-testid="leg-times">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        <Item label="Entered">{entered ? fmtStamp(entered) : "time not recorded"}{!leg.enteredAt && entered ? <span className="text-muted"> (strategy last started)</span> : null}</Item>
        {leg.stop != null
          ? <Item label={stopMoved ? "Stop moved" : "Stop set"} cls="text-down">{fmtPrice(leg.stop)} · {fmtStamp(leg.stopSetAt ?? entered)}</Item>
          : <Item label="Stop">none</Item>}
        {leg.target != null
          ? <Item label="Target set" cls="text-up">{fmtPrice(leg.target)} · {fmtStamp(leg.targetSetAt ?? entered)}</Item>
          : <Item label="Target">none</Item>}
        {exited && <Item label="Exited" cls="text-warn">{fmtStamp(leg.exitedAt)} at {fmtPrice(leg.exitPrice as number)} ({leg.exitReason})</Item>}
      </div>
      {log.length > 0 && (
        <div className="mt-0.5 text-muted" data-testid="leg-log">
          {log.slice(-3).map(line)}
          {older.length > 0 && <details><summary className="cursor-pointer text-info">{older.length} earlier {older.length === 1 ? "line" : "lines"}</summary>{older.map(line)}</details>}
        </div>
      )}
    </div>
  );
}
