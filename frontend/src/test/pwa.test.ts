// "This app cannot be installed" (Chrome, 5 Nov 2026): the web manifest, service worker and icons sit behind the site's login
// and a browser fetches them without it (the server-side fix is pending approval, see D73). These checks keep the install
// files themselves complete.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");
const manifest = JSON.parse(read(resolve(FRONTEND, "public/manifest.webmanifest"))) as {
  name: string; short_name: string; start_url: string; scope: string; display: string; id?: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("installable app", () => {
  it("has the manifest fields a browser needs", () => {
    expect(manifest.name && manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/");
  });

  it("declares a 192 and a 512 icon, a maskable one, and each file is really that size", () => {
    const sizes = new Set(manifest.icons.map((i) => i.sizes));
    expect(sizes.has("192x192") && sizes.has("512x512")).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of manifest.icons) {
      const file = resolve(FRONTEND, "public", i.src.replace(/^\//, ""));
      expect(existsSync(file), i.src).toBe(true);
      const [w, h] = pngSize(file);
      expect(`${w}x${h}`, i.src).toBe(i.sizes);
    }
  });

  it("is linked with credentials, registers a service worker with a fetch handler, and the worker never touches live data", () => {
    const html = read(resolve(FRONTEND, "index.html"));
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
    expect(read(resolve(FRONTEND, "src/main.tsx"))).toContain('serviceWorker.register("/sw.js")');
    const sw = read(resolve(FRONTEND, "public/sw.js"));
    expect(sw).toContain('addEventListener("fetch"');
    expect(sw).toMatch(/startsWith\("\/api"\)[\s\S]*startsWith\("\/ws"\)/);
  });
});
