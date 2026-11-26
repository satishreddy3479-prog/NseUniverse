import { render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIn, runningBuild, serverBuild, watchBuild } from "../lib/buildWatch";
import { UpdateBanner } from "../components/UpdateBanner";

const page = (name: string) => `<!doctype html><html><head><script type="module" crossorigin src="/assets/${name}.js"></script></head><body></body></html>`;
const setRunning = (name: string) => { document.head.innerHTML = `<script type="module" src="/assets/${name}.js"></script>`; };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.head.innerHTML = ""; });

describe("build watch", () => {
  it("reads the main script name from an index page and from the running page", () => {
    expect(buildIn(page("index-AbC123_-x"))).toBe("/assets/index-AbC123_-x.js");
    expect(buildIn("<html>login</html>")).toBeNull();
    setRunning("index-OLD111");
    expect(runningBuild()).toBe("/assets/index-OLD111.js");
  });

  it("reads the server's build without the browser cache, and treats an error page as unknown", async () => {
    const ok = vi.fn().mockResolvedValue(new Response(page("index-NEW222"), { status: 200 }));
    expect(await serverBuild(ok as unknown as typeof fetch)).toBe("/assets/index-NEW222.js");
    expect(ok).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
    const denied = vi.fn().mockResolvedValue(new Response("no", { status: 401 }));
    expect(await serverBuild(denied as unknown as typeof fetch)).toBeNull();
    const down = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await serverBuild(down as unknown as typeof fetch)).toBeNull();
  });

  it("tells a tab that is open when the server has another build, and stays quiet when it is the same", async () => {
    vi.useFakeTimers();
    setRunning("index-OLD111");
    const fetcher = vi.fn().mockResolvedValue(new Response(page("index-OLD111"), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const onNewer = vi.fn();
    const stop = watchBuild(onNewer, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(onNewer).not.toHaveBeenCalled();
    fetcher.mockImplementation(() => Promise.resolve(new Response(page("index-NEW222"), { status: 200 })));
    await vi.advanceTimersByTimeAsync(1100);
    expect(onNewer).toHaveBeenCalledTimes(1);
    stop();
    vi.unstubAllGlobals();
  });

  it("shows a Reload banner only once a newer build is found", async () => {
    vi.useFakeTimers();
    setRunning("index-OLD111");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(page("index-NEW222"), { status: 200 }))));
    render(<UpdateBanner />);
    expect(screen.queryByTestId("update-banner")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(181_000); });
    expect(screen.getByTestId("update-banner")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload now/i })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
