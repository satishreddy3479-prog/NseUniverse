import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkError, reloadOnceForUpdate } from "../lib/chunkReload";

interface Props {
  children: ReactNode;
  /** When this changes (the page the person moved to) a shown error is cleared, so one broken page never blocks the others. */
  resetKey?: string;
  /** "page" sits inside the shell (the menu stays usable); "app" is the last line of defence around everything. */
  scope?: "page" | "app";
}
interface State { error: Error | null }

/**
 * Without this, any error while a page draws (a file that is gone after an update, a value the page did not expect) unmounts the
 * whole app and leaves a blank screen. Here the person sees what happened and can retry or reload; an update is recovered by itself.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private reloading = false;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isChunkError(error)) this.reloading = reloadOnceForUpdate();
    // kept in the browser console for diagnosis; nothing is sent anywhere
    console.error("page error", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkError(error);
    return (
      <div role="alert" data-testid="page-error" className={`mx-auto max-w-xl rounded-lg border border-rule bg-slate p-4 text-sm ${this.props.scope === "app" ? "mt-16" : "mt-4"}`}>
        <h2 className="text-base font-semibold text-paper">{stale ? "The app was updated" : "This page could not be shown"}</h2>
        <p className="mt-1 text-muted">
          {stale
            ? this.reloading ? "Loading the new version…" : "A newer version is available. Reload to continue; nothing you saved is lost."
            : "Something went wrong while drawing this page. The rest of the app still works; you can try again or open another page."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => window.location.reload()} className="min-h-9 rounded-sm border border-brass bg-brass/15 px-3 font-medium text-paper">Reload the app</button>
          {!stale && <button type="button" onClick={() => this.setState({ error: null })} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-3 text-paper">Try again</button>}
        </div>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Technical detail</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words">{`${error.name}: ${error.message}`}</pre>
        </details>
      </div>
    );
  }
}
