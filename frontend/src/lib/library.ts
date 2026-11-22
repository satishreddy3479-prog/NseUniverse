// The data library: bundles of aged data, their download with a checksum confirmation, temporary restores and the coverage check (docs/data-library-plan.md).

export interface LibBundle {
  id: number; name: string; start_day: string; end_day: string; days: string[]; created_utc: string; bytes: number; sha256: string; files: number; origin: string;
  confirmed_utc: string | null; on_server: boolean; downloaded: boolean;
}
export interface LibRestore { id: number; bundle_name: string; dir: string; days: string[]; bytes: number; created_utc: string; expires_utc: string }
export interface LibSession {
  day: string; samples: number | null; complete: boolean; archive: boolean; snapshot_files: number; snapshot_bytes: number;
  bundle: { id: number; name: string; downloaded: boolean; on_server: boolean } | null; exported: boolean; restored: boolean; state: string;
}
export interface LibStatus {
  enabled: boolean; bundles: LibBundle[]; restores: LibRestore[]; sessions: LibSession[]; disk_free_gb: number; unconfirmed_bundles: number; note: string;
  policy: { block_days: number; restore_ttl_hours: number; restore_max_mb: number; min_free_gb: number };
  next_block: { start: string; end: string; ready_on: string; ready: boolean; days: number; days_left: number } | null;
  last_auto: { state?: string; at?: string; built?: { name: string; days: number; bytes: number } };
}
export type LibConfirmed = LibBundle & { released_files: number; released_bytes: number };
export interface DataCoverage {
  days: number; observations_ok: number; observations_missing: string[]; snapshot_files_missing: string[]; restorable_from_bundle: string[]; ok: boolean; message: string;
}

export class LibraryError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: "application/json", ...(init?.body && !(init.body instanceof Blob) ? { "Content-Type": "application/json" } : {}) }, ...init });
  } catch {
    throw new LibraryError("network", "Backend unreachable.");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { detail?: { code?: string; message?: string } };
      if (b.detail?.code) code = b.detail.code;
      if (b.detail?.message) message = b.detail.message;
    } catch { /* a body that is not JSON */ }
    throw new LibraryError(code, message);
  }
  return (await res.json()) as T;
}

export const libraryApi = {
  status: () => call<LibStatus>("/api/library/status"),
  build: (start: string, end: string) => call<LibBundle>("/api/library/bundles", { method: "POST", body: JSON.stringify({ start, end }) }),
  confirm: (id: number, sha256: string) => call<LibConfirmed>(`/api/library/bundles/${id}/confirm`, { method: "POST", body: JSON.stringify({ sha256 }) }),
  restore: (bundleId: number) => call<LibRestore>("/api/library/restore", { method: "POST", body: JSON.stringify({ bundle_id: bundleId }) }),
  upload: (file: File) => call<LibRestore>(`/api/library/restore/upload?name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file, headers: { "Content-Type": "application/octet-stream" } }),
  removeRestore: (id: number) => call<{ removed: number }>(`/api/library/restore/${id}`, { method: "DELETE" }),
  keepRestore: (id: number) => call<LibRestore>(`/api/library/restore/${id}/keep`, { method: "POST" }),
};

export const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export type DownloadStep = "downloading" | "checking" | "saving" | "confirming";

/** Download a bundle, check its SHA-256 against the server's, hand it to the browser as a file, then tell the server the copy exists. A damaged download is never saved. */
export async function downloadBundle(b: LibBundle, onStep: (s: DownloadStep) => void = () => undefined): Promise<LibConfirmed> {
  onStep("downloading");
  let res: Response;
  try {
    res = await fetch(`/api/library/bundles/${b.id}/download`);
  } catch {
    throw new LibraryError("network", "Backend unreachable.");
  }
  if (!res.ok) throw new LibraryError("download_failed", `The download failed (${res.status}).`);
  const buf = await res.arrayBuffer();
  onStep("checking");
  const got = hex(await globalThis.crypto.subtle.digest("SHA-256", buf));
  if (got !== b.sha256) throw new LibraryError("checksum_mismatch", "The downloaded file does not match the one on the server (a damaged download). It was not saved; try again.");
  onStep("saving");
  const url = URL.createObjectURL(new Blob([buf], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = b.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  onStep("confirming");
  return libraryApi.confirm(b.id, got);
}

export const mb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`);
