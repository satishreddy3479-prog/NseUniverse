import { useIsFetching } from "@tanstack/react-query";
import { Loading } from "../Loading";
import { EmptyState } from "../ui";

/** Shown while no expiry is chosen: a loading state while the expiry list is still coming in (so the page does not flash "No expiry"), the empty state once it has arrived. */
export function NoExpiry() {
  const loading = useIsFetching({ queryKey: ["expiries"] }) > 0;
  return loading ? <Loading label="Loading the expiries…" className="m-3" /> : <EmptyState title="No expiry">Choose an expiry above.</EmptyState>;
}
