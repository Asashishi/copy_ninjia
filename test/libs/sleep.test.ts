import { describe, expect, test } from "bun:test";
import { sleep } from "../../packages/libs/sleep";

describe("abortable sleep", () => {
  test("abort 会立即拒绝并清理真实的长时 referenced timer", async () => {
    const originalClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
    let clearedTimers: number = 0;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]): void => {
      clearedTimers++;
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    const controller = new AbortController();
    const reason = new Error("shutdown");

    try {
      const pending = sleep(60_000, controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(clearedTimers).toBe(1);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("拒绝非法时长，短睡眠正常结算", async () => {
    await expect(sleep(Number.NaN)).rejects.toThrow("finite and non-negative");
    await expect(sleep(-1)).rejects.toThrow("finite and non-negative");
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  test("已 abort 的 signal 立即拒绝，不注册任何 timer", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);

    await expect(sleep(60_000, controller.signal)).rejects.toBe(reason);
  });

  test("无 signal 时走 Bun.sleep，不自建 timer，且仍按时长结算", async () => {
    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    let registeredTimers: number = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      registeredTimers++;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      const startedAt: number = Date.now();
      await expect(sleep(30)).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
      // Bun.sleep 不经过 globalThis.setTimeout：这里为 0 即证明轻量路径生效。
      expect(registeredTimers).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
