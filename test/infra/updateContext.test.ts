import { describe, expect, test } from "bun:test";
import {
  currentUpdateAbortSignal,
  runWithUpdateAbortSignal,
} from "../../packages/infra/updateContext";

describe("Bun AsyncLocalStorage update 上下文", () => {
  test("nested await 与 timer 保留各层 signal，内层结束后恢复外层", async () => {
    const outer: AbortSignal = new AbortController().signal;
    const inner: AbortSignal = new AbortController().signal;

    await runWithUpdateAbortSignal(outer, async (): Promise<void> => {
      expect(currentUpdateAbortSignal()).toBe(outer);
      await Promise.resolve();
      expect(currentUpdateAbortSignal()).toBe(outer);
      await new Promise<void>((resolve: () => void): void => {
        setTimeout((): void => {
          expect(currentUpdateAbortSignal()).toBe(outer);
          resolve();
        }, 0);
      });
      await runWithUpdateAbortSignal(inner, async (): Promise<void> => {
        expect(currentUpdateAbortSignal()).toBe(inner);
        await Promise.resolve();
        expect(currentUpdateAbortSignal()).toBe(inner);
      });
      expect(currentUpdateAbortSignal()).toBe(outer);
    });

    expect(currentUpdateAbortSignal()).toBeUndefined();
  });

  test("异步拒绝传播后不把已结束 update 的 signal 泄漏给后续任务", async () => {
    const signal: AbortSignal = new AbortController().signal;
    const failure: Error = new Error("update failed");

    await expect(runWithUpdateAbortSignal(signal, async (): Promise<void> => {
      expect(currentUpdateAbortSignal()).toBe(signal);
      await Bun.sleep(0);
      expect(currentUpdateAbortSignal()).toBe(signal);
      throw failure;
    })).rejects.toBe(failure);

    expect(currentUpdateAbortSignal()).toBeUndefined();
    await Bun.sleep(0);
    expect(currentUpdateAbortSignal()).toBeUndefined();
  });
});
