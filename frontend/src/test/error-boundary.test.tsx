import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense } from "react";
import { MemoryRouter, Route, Routes, Link } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { isChunkError, RELOAD_GUARD_MS, reloadOnceForUpdate, warmUp, watchForStaleBuild } from "../lib/chunkReload";

beforeEach(() => { sessionStorage.clear(); vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("telling an update from a bug", () => {
  it("recognises the messages browsers give when a built file is gone or comes back as the index page", () => {
    for (const m of [
      "Failed to fetch dynamically imported module: https://x/assets/Swing-abc.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Loading chunk 12 failed.",
      "'text/html' is not a valid JavaScript MIME type.",
      "Unexpected token '<'",
    ]) expect(isChunkError(new Error(m))).toBe(true);
    expect(isChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it("reloads once for an update and not again within 30 seconds, so a real fault never loops", () => {
    const reload = vi.fn();
    expect(reloadOnceForUpdate(1_000_000, reload)).toBe(true);
    expect(reloadOnceForUpdate(1_000_000 + RELOAD_GUARD_MS - 1, reload)).toBe(false);
    expect(reloadOnceForUpdate(1_000_000 + RELOAD_GUARD_MS + 1, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("Vite's preload error", () => {
  it("is cancelled only when the page really reloads; the second time the true error is left to reach the boundary", () => {
    const reload = vi.fn();
    watchForStaleBuild(reload);
    const fire = () => { const ev = new Event("vite:preloadError", { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; };
    expect(fire()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fire()).toBe(false); // within 30 s: no second reload, error not swallowed
    expect(reload).toHaveBeenCalledTimes(1);
    sessionStorage.clear();
    warmUp.active = true; // a background warm-up failing on a network blip must not reload the page the person is on
    expect(fire()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    warmUp.active = false;
  });
});

function Boom({ msg }: { msg: string }): never {
  throw new Error(msg);
}

describe("the page boundary", () => {
  it("shows a message with a way out instead of a blank screen when a page fails to draw", () => {
    render(<ErrorBoundary scope="page"><Boom msg="Cannot read properties of undefined" /></ErrorBoundary>);
    expect(screen.getByTestId("page-error")).toHaveTextContent("This page could not be shown");
    expect(screen.getByRole("button", { name: "Reload the app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText(/Cannot read properties/)).toBeInTheDocument(); // the detail is there for diagnosis
  });

  it("a page that is gone after an update is explained and reloaded, not treated as a bug", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    render(<ErrorBoundary scope="page"><Boom msg="Failed to fetch dynamically imported module: /assets/Swing-old.js" /></ErrorBoundary>);
    expect(screen.getByTestId("page-error")).toHaveTextContent("The app was updated");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a broken page does not block the others: moving to another page clears the message and the menu stays usable", async () => {
    const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload: vi.fn() } });
    function Shell() {
      return (
        <MemoryRouter initialEntries={["/broken"]}>
          <nav><Link to="/ok">Fine page</Link></nav>
          <Routes>
            <Route path="/broken" element={<ErrorBoundary resetKey="/broken"><Suspense fallback="loading"><Broken /></Suspense></ErrorBoundary>} />
            <Route path="/ok" element={<p>All good here</p>} />
          </Routes>
        </MemoryRouter>
      );
    }
    render(<Shell />);
    expect(await screen.findByTestId("page-error")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Fine page" }));
    expect(await screen.findByText("All good here")).toBeInTheDocument();
    expect(screen.queryByTestId("page-error")).toBeNull();
  });
});
