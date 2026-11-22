import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** A thin bar under the top edge while any data request is running. It appears only after 300 ms, so quick refreshes never flicker, and it is not announced (the panels announce their own loading). */
export function TopProgress() {
  const n = useIsFetching();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (n === 0) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(t);
  }, [n]);
  return show ? <div aria-hidden className="top-progress" data-testid="top-progress" /> : null;
}
