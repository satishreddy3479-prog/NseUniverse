import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** A thin bar under the top edge while a page is loading data it does not have yet. It appears only after 300 ms, so quick loads never flicker, and it is not announced (the panels announce their own loading).
 * Background refreshes of data already on screen do not count: dozens of panels poll every few seconds, some for longer than 300 ms, and the bar would never go away (seen on the phone, 25 Nov 2026). */
export function TopProgress() {
  const n = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (n === 0) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(t);
  }, [n]);
  return show ? <div aria-hidden className="top-progress" data-testid="top-progress" /> : null;
}
