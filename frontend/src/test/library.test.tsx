// The data library panel: the lists, the download with its checksum confirmation, restores, and the coverage note.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataCoverageNote, LibraryPanel } from "../components/LibraryPanel";
import { hex, mb, type LibStatus } from "../lib/library";

const BYTES = new TextEncoder().encode("a pretend zip file, long enough to hash");
const SHA = createHash("sha256").update(BYTES).digest("hex");

const bundle = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "nse-universe-bundle-2026-10-28_to-2026-11-12.zip", start_day: "2026-10-28", end_day: "2026-11-12", days: ["2026-10-28", "2026-10-29", "2026-11-12"], created_utc: "2026-11-20T14:00:00+00:00",
  bytes: BYTES.length, sha256: SHA, files: 12, origin: "auto", confirmed_utc: null, on_server: true, downloaded: false, ...over,
});
const status = (over: Partial<LibStatus> = {}): LibStatus => ({
  enabled: true, bundles: [bundle() as never], restores: [], due_days: ["2026-11-13", "2026-11-16"], disk_free_gb: 10.9, unconfirmed_bundles: 1, note: "",
  policy: { raw_keep_days: 30, normalized_keep_days: 30, bundle_after_days: 25, min_batch_days: 7, bundle_keep_days: 90, restore_ttl_hours: 24, restore_max_mb: 1024, hard_stop_days: 60, min_free_gb: 6 },
  last_auto: { state: "ok" },
  sessions: [
    { day: "2026-11-20", samples: 389, complete: true, archive: true, snapshot_files: 778, snapshot_bytes: 7_300_000, bundle: null, exported: false, restored: false, state: "on the server" },
    { day: "2026-10-28", samples: 120, complete: false, archive: true, snapshot_files: 0, snapshot_bytes: 0, bundle: { id: 1, name: "b", downloaded: false, on_server: true }, exported: false, restored: false, state: "in a bundle" },
  ],
  ...over,
});

let calls: { url: string; method: string; body: unknown }[] = [];
let current: LibStatus;

function install(over: { downloadBytes?: Uint8Array; confirmStatus?: number; list?: Record<string, { status: number; body: unknown }> } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (over.list?.[url]) return json(over.list[url]!.body, over.list[url]!.status);
    if (url === "/api/library/status") return json(current);
    if (url.endsWith("/download")) return new Response((over.downloadBytes ?? BYTES) as BodyInit, { status: 200, headers: { "Content-Type": "application/zip" } });
    if (url.endsWith("/confirm")) return over.confirmStatus && over.confirmStatus !== 200 ? json({ detail: { code: "checksum_mismatch", message: "mismatch" } }, over.confirmStatus) : json(bundle({ downloaded: true, confirmed_utc: "2026-11-22T04:00:00+00:00" }));
    if (url === "/api/library/restore") return json({ id: 5, bundle_name: "b", dir: "/x", days: ["2026-10-28", "2026-11-12"], bytes: 5_000_000, created_utc: "2026-11-22T04:00:00+00:00", expires_utc: "2026-11-23T04:00:00+00:00" });
    if (url.startsWith("/api/library/restore/upload")) return json({ id: 6, bundle_name: "mine.zip", dir: "/y", days: ["2026-11-01"], bytes: 1_000_000, created_utc: "2026-11-22T04:00:00+00:00", expires_utc: "2026-11-23T04:00:00+00:00" });
    if (method === "DELETE") return json({ removed: "x" });
    if (url.endsWith("/keep")) return json({ id: 5 });
    return json({ detail: { code: "nf", message: "not found" } }, 404);
  }));
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LibraryPanel /></QueryClientProvider>);
}

let saved: string[] = [];
beforeEach(() => {
  current = status();
  saved = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("data library panel", () => {
  it("lists the bundles with what is not yet downloaded, the due days and every session", async () => {
    install();
    mount();
    expect(await screen.findByTestId("lib-bundle-1")).toHaveTextContent("2026-10-28 → 2026-11-12");
    expect(screen.getByTestId("lib-bundle-1")).toHaveTextContent("3 days · 12 files · made automatically");
    expect(screen.getByTestId("lib-bundle-1")).toHaveTextContent("not downloaded");
    const tiles = screen.getByTestId("lib-tiles");
    expect(tiles).toHaveTextContent("Not downloaded yet1no copy off the server");
    expect(tiles).toHaveTextContent("Next bundle2days due (at 25 days old)");
    expect(tiles).toHaveTextContent("Disk free10.9 GB");
    expect(screen.getByText(/kept on the server for 30 days/)).toBeInTheDocument();
    const sessions = within(screen.getByTestId("lib-sessions"));
    expect(sessions.getByText("389")).toBeInTheDocument();
    expect(sessions.getByText("120 (partial)")).toBeInTheDocument(); // a partial day is said to be partial
    expect(sessions.getByText("in a bundle, not downloaded")).toBeInTheDocument();
  });

  it("downloads, checks the file against the server's checksum, saves it, and only then confirms", async () => {
    install();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Download nse-universe-bundle/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(true));
    expect(saved).toEqual(["nse-universe-bundle-2026-10-28_to-2026-11-12.zip"]);
    const confirm = calls.find((c) => c.url.endsWith("/confirm"))!;
    expect(confirm.body).toEqual({ sha256: SHA });
    expect(calls.map((c) => c.url).indexOf("/api/library/bundles/1/download")).toBeLessThan(calls.indexOf(confirm)); // downloaded first
    expect(await screen.findByTestId("lib-note")).toHaveTextContent("downloaded and confirmed");
  });

  it("does not save or confirm a damaged download", async () => {
    install({ downloadBytes: new TextEncoder().encode("damaged in transit") });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Download nse-universe-bundle/ }));
    expect(await screen.findByTestId("lib-error-1")).toHaveTextContent("does not match the one on the server");
    expect(saved).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(false); // the server must not count a copy that does not exist
  });

  it("shows the server's refusal when it does not accept the checksum", async () => {
    install({ confirmStatus: 409 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Download nse-universe-bundle/ }));
    expect(await screen.findByTestId("lib-error-1")).toHaveTextContent("mismatch");
  });

  it("will not remove a bundle that has not been downloaded, and removes one that has", async () => {
    current = status({ bundles: [bundle({ id: 1 }) as never, bundle({ id: 2, name: "second.zip", downloaded: true, confirmed_utc: "2026-11-21T10:00:00+00:00" }) as never], unconfirmed_bundles: 1 });
    install();
    mount();
    expect(await screen.findByRole("button", { name: /Remove nse-universe-bundle.* from the server/ })).toBeDisabled();
    expect(screen.getByTestId("lib-bundle-2")).toHaveTextContent("✓ downloaded and checked");
    fireEvent.click(screen.getByRole("button", { name: "Remove second.zip from the server" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/library/bundles/2")).toBe(true));
  });

  it("restores a bundle held on the server, and a file from this computer", async () => {
    install();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore nse-universe-bundle/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/library/restore" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url === "/api/library/restore")!.body).toEqual({ bundle_id: 1 });
    expect(await screen.findByTestId("lib-note")).toHaveTextContent("Restored 2 days (5.0 MB) for 24 hours.");
    fireEvent.click(screen.getByRole("button", { name: "Restore from a file on this computer" }));
    expect(await screen.findByTestId("lib-note")).toHaveTextContent("Choose a bundle file first.");
    const f = new File(["zip"], "mine.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Bundle file to restore"), { target: { files: [f] } });
    fireEvent.click(screen.getByRole("button", { name: "Restore from a file on this computer" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/library/restore/upload?name=mine.zip" && c.method === "PUT")).toBe(true));
  });

  it("lists active restores with their expiry and lets them be kept or removed", async () => {
    current = status({ restores: [{ id: 5, bundle_name: "b", dir: "/x", days: ["2026-10-28", "2026-11-12"], bytes: 5_000_000, created_utc: "2026-11-22T04:00:00+00:00", expires_utc: "2026-11-23T04:00:00+00:00" }] });
    install();
    mount();
    const list = await screen.findByTestId("lib-restores");
    expect(list).toHaveTextContent("2026-10-28 → 2026-11-12");
    expect(list).toHaveTextContent("2 days · 5.0 MB · expires");
    fireEvent.click(within(list).getByRole("button", { name: "Keep 7 days" }));
    fireEvent.click(within(list).getByRole("button", { name: "Remove now" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/library/restore/5")).toBe(true));
    expect(calls.some((c) => c.url === "/api/library/restore/5/keep")).toBe(true);
  });

  it("makes a bundle of chosen days", async () => {
    install({ list: { "/api/library/bundles": { status: 200, body: bundle({ id: 9, name: "made.zip" }) } } });
    mount();
    await screen.findByTestId("library");
    const make = screen.getByRole("button", { name: "Make a bundle of these days" });
    expect(make).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Bundle from"), { target: { value: "2026-10-28" } });
    fireEvent.change(screen.getByLabelText("Bundle to"), { target: { value: "2026-11-02" } });
    fireEvent.click(make);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/library/bundles" && c.method === "POST")?.body).toEqual({ start: "2026-10-28", end: "2026-11-02" }));
  });

  it("says plainly when there is no bundle, when the library is off and when it cannot be loaded", async () => {
    current = status({ bundles: [], unconfirmed_bundles: 0, due_days: [] });
    install();
    const a = mount();
    expect(await screen.findByTestId("lib-no-bundles")).toHaveTextContent("made automatically when snapshot days reach 25 days of age");
    expect(screen.getByTestId("lib-no-restores")).toBeInTheDocument();
    a.unmount();
    install({ list: { "/api/library/status": { status: 404, body: { detail: { code: "disabled", message: "off" } } } } });
    const b = mount();
    expect(await screen.findByTestId("lib-error")).toHaveTextContent("turned off on this server");
    b.unmount();
    install({ list: { "/api/library/status": { status: 500, body: {} } } });
    mount();
    expect(await screen.findByTestId("lib-error")).toHaveTextContent("could not be loaded");
  });
});

describe("helpers and the coverage note", () => {
  it("formats the checksum and the sizes", () => {
    expect(hex(new Uint8Array([0, 15, 255]).buffer)).toBe("000fff");
    expect(mb(5_000_000)).toBe("5.0 MB");
    expect(mb(150_000_000)).toBe("150 MB");
    expect(mb(2_300_000_000)).toBe("2.30 GB");
  });
  it("says nothing when the data is all there and names the missing sessions when it is not", () => {
    const ok = { days: 5, observations_ok: 5, observations_missing: [], snapshot_files_missing: [], restorable_from_bundle: [], ok: true, message: "all sessions have their observation rows" };
    const a = render(<DataCoverageNote coverage={ok} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    render(<DataCoverageNote coverage={{ ...ok, ok: false, observations_ok: 4, observations_missing: ["2026-11-09"], message: "1 of 5 sessions have fewer than 300 stored samples: the result would rest on partial days" }} />);
    expect(screen.getByTestId("data-coverage")).toHaveTextContent("Data check: 1 of 5 sessions have fewer than 300 stored samples");
    expect(screen.getByTestId("data-coverage")).toHaveTextContent("Sessions: 2026-11-09.");
  });
});
