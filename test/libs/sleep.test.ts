import { describe, expect, test } from "bun:test";
import { sleep } from "../../src/libs/sleep";

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
});
