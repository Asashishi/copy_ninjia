import { describe, expect, spyOn, test } from "bun:test";
import {
  currentUpdateAbortSignal,
  refreshUpdateNow,
  runWithUpdateAbortSignal,
  updateNow,
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

describe("本条 update 统一的「现在」", () => {
  test("首次调用读一次墙钟，同一条 update 的后续调用一律复用它", async () => {
    const spy: ReturnType<typeof spyOn> = spyOn(Date, "now")
      .mockReturnValue(1_800_000_000_000);
    try {
      await runWithUpdateAbortSignal(
        new AbortController().signal,
        async (): Promise<void> => {
          expect(updateNow()).toBe(1_800_000_000_000);
          await Bun.sleep(0);
          // 跨过 await 仍是同一个 scope，不再读第二次。
          expect(updateNow()).toBe(1_800_000_000_000);
          expect(spy).toHaveBeenCalledTimes(1);
        }
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("两条 update 各记各的，不共享上一条的时刻", async () => {
    const first: number = await runWithUpdateAbortSignal(
      new AbortController().signal,
      async (): Promise<number> => updateNow()
    );
    await Bun.sleep(2);
    const second: number = await runWithUpdateAbortSignal(
      new AbortController().signal,
      async (): Promise<number> => updateNow()
    );
    expect(second).toBeGreaterThan(first);
  });

  test("不在 update 作用域内时如实返回当刻墙钟，语义同 Date.now", () => {
    const spy: ReturnType<typeof spyOn> = spyOn(Date, "now")
      .mockReturnValue(1_700_000_000_000);
    try {
      expect(updateNow()).toBe(1_700_000_000_000);
      expect(updateNow()).toBe(1_700_000_000_000);
      // 没有 scope 可缓存，每次都要现读。
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("跨过有界等待后 refreshUpdateNow 重新取值，后续调用点改用新值", async () => {
    await runWithUpdateAbortSignal(
      new AbortController().signal,
      async (): Promise<void> => {
        const before: number = updateNow();
        await Bun.sleep(2);
        const refreshed: number = refreshUpdateNow();
        expect(refreshed).toBeGreaterThan(before);
        expect(updateNow()).toBe(refreshed);
      }
    );
  });

  test("scope 之外调用 refreshUpdateNow 只返回当刻墙钟，不写任何状态", () => {
    const spy: ReturnType<typeof spyOn> = spyOn(Date, "now")
      .mockReturnValue(1_600_000_000_000);
    try {
      expect(refreshUpdateNow()).toBe(1_600_000_000_000);
    } finally {
      spy.mockRestore();
    }
  });
});
