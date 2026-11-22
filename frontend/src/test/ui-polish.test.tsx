// The loading states, the progress bar and the colour tokens of the interface: guards for the design system.
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Loading } from "../components/Loading";
import { TopProgress } from "../components/TopProgress";

describe("Loading", () => {
  it("says in words what is loading, in both shapes, and is announced as a status", () => {
    render(<><Loading label="Loading the gamma map…" /><Loading variant="inline" label="Calculating…" /></>);
    const [block, inline] = screen.getAllByRole("status") as [HTMLElement, HTMLElement];
    expect(block).toHaveAttribute("aria-label", "Loading the gamma map…");
    expect(block).toHaveTextContent("Loading the gamma map…");
    expect(inline).toHaveTextContent("Calculating…");
    expect(block.querySelectorAll(".loading-bars i")).toHaveLength(14); // the skeleton is decoration: hidden from assistive technology
    expect(block.querySelector("[aria-hidden]")).not.toBeNull();
  });
});

describe("TopProgress", () => {
  afterEach(() => { vi.useRealTimers(); });
  function Probe({ run }: { run: boolean }) {
    useQuery({ queryKey: ["probe"], queryFn: () => new Promise((r) => setTimeout(() => r(1), 1000)), enabled: run });
    return <TopProgress />;
  }
  it("appears only after 300 ms of fetching and goes when the request ends", async () => {
    vi.useFakeTimers();
    render(<QueryClientProvider client={new QueryClient()}><Probe run /></QueryClientProvider>);
    expect(screen.queryByTestId("top-progress")).toBeNull(); // a quick refresh never flickers
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByTestId("top-progress")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("top-progress")).toBeNull();
  });
});

const css = readFileSync(resolve(__dirname, "..", "index.css"), "utf8");
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("colour tokens", () => {
  const dark = tokens(css.slice(css.indexOf(":root,"), css.indexOf('[data-theme="light"] {')));
  const light = tokens(css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf("@theme inline")));
  it.each([["night", dark], ["day", light]] as const)("every text colour reaches 4.5:1 on every surface in the %s theme", (_n, t) => {
    for (const fg of ["paper", "muted", "accent", "brass", "up", "down", "warn", "info", "legend-off"]) {
      for (const bg of ["ink", "slate", "slate-2"]) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
