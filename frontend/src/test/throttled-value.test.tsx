import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledValue } from "../lib/hooks";

describe("useThrottledValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("follows a fast-changing value at most once per interval and always ends on the newest", () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 1000), { initialProps: { v: 1 } });
    expect(result.current).toBe(1);
    for (const v of [2, 3, 4, 5]) { act(() => { vi.advanceTimersByTime(100); }); rerender({ v }); }
    expect(result.current).toBe(1); // 400 ms in: still the old value, no per-tick redraw
    act(() => { vi.advanceTimersByTime(700); });
    expect(result.current).toBe(5); // the newest one, not an intermediate one
  });

  it("shows a change of the reset key at once", () => {
    const { result, rerender } = renderHook(({ v, k }) => useThrottledValue(v, 1000, k), { initialProps: { v: 1, k: "a" } });
    rerender({ v: 2, k: "b" });
    expect(result.current).toBe(2);
  });
});
