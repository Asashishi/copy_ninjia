import { describe, expect, spyOn, test } from "bun:test";
import type { Update } from "@grammyjs/types";
import { BotError } from "grammy";
import type { Bot, Context } from "grammy";
import { runAcknowledgedUpdateBatches } from "../../packages/app/updateRunner";
import { logger } from "../../packages/infra/logger";
import { currentUpdateAbortSignal } from "../../packages/infra/updateContext";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: (): void => resolve?.() };
}

describe("acknowledgement-safe update runner", () => {
  test("每次只取一条，middleware 完成前不发起携带更高 offset 的下一次 getUpdates", async () => {
    const first = deferred();
    const fetchOffsets: number[] = [];
    const fetchLimits: number[] = [];
    let fetchCount: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number; limit: number }, signal: AbortSignal): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          fetchLimits.push(args.limit);
          fetchCount++;
          if (fetchCount === 1) {
            return [{ update_id: 10 }] as Update[];
          }
          return await new Promise<Update[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      },
      handleUpdate: async (): Promise<void> => await first.promise,
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    expect(fetchOffsets).toEqual([0]);
    expect(runner.size()).toBe(1);

    first.resolve();
    await Bun.sleep(0);
    expect(fetchOffsets).toEqual([0, 11]);
    expect(fetchLimits).toEqual([1, 1]);
    await runner.stop();
  });

  test("update 严格串行：前一条 middleware 未完成前绝不启动下一条", async () => {
    // per-chat sequentialize 已从 registerHandlers 移除，同群消息的顺序保证此后
    // 完全来自本 runner 的 `await updateTask` 循环，因此这条不变量必须被直接断言，
    // 而不是只看 offset 记账。
    const gates = [deferred(), deferred()];
    const started: number[] = [];
    let fetchCount: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (_args: { offset: number; limit: number }, signal: AbortSignal): Promise<Update[]> => {
          fetchCount++;
          if (fetchCount <= 2) return [{ update_id: 9 + fetchCount }] as Update[];
          return await new Promise<Update[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      },
      handleUpdate: async (update: Update): Promise<void> => {
        started.push(update.update_id);
        await gates[started.length - 1]!.promise;
      },
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    expect(started).toEqual([10]);

    // 第一条仍悬挂：再放几拍事件循环，第二条也不许开始。
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(started).toEqual([10]);

    gates[0]!.resolve();
    await Bun.sleep(0);
    expect(started).toEqual([10, 11]);

    await runner.stop();
    gates[1]!.resolve();
  });

  test("stop 不等待悬挂 middleware，且停止后绝不通过下一次 fetch 确认该批次", async () => {
    const gate = deferred();
    const fetchOffsets: number[] = [];
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number }): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          return [{ update_id: 20 }] as Update[];
        },
      },
      handleUpdate: async (): Promise<void> => await gate.promise,
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    await runner.stop();

    expect(fetchOffsets).toEqual([0]);
    expect(runner.size()).toBe(1);
    gate.resolve();
    await Bun.sleep(0);
    expect(runner.size()).toBe(0);
    expect(fetchOffsets).toEqual([0]);
  });

  test("abortActive 中止每个在途 update 的上下文，且取消不进入普通错误处理", async () => {
    const fetchOffsets: number[] = [];
    let observedSignal: AbortSignal | undefined;
    let handledErrors: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number }): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          return [{ update_id: 25 }] as Update[];
        },
      },
      handleUpdate: async (): Promise<void> => {
        observedSignal = currentUpdateAbortSignal();
        await new Promise<void>((_resolve, reject: (reason?: unknown) => void): void => {
          observedSignal?.addEventListener(
            "abort",
            (): void => reject(observedSignal?.reason),
            { once: true }
          );
        });
      },
      errorHandler: (): void => { handledErrors++; },
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    await runner.stop();

    expect(runner.size()).toBe(1);
    expect(runner.abortActive()).toBe(1);
    expect(runner.abortActive()).toBe(0);
    await Bun.sleep(0);
    expect(observedSignal?.aborted).toBeTrue();
    expect(runner.size()).toBe(0);
    expect(handledErrors).toBe(0);
    expect(fetchOffsets).toEqual([0]);
  });

  test("middleware 失败会终止批次，绝不通过下一次 fetch 确认失败 update", async () => {
    const fetchOffsets: number[] = [];
    let handledErrors: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number }): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          return [{ update_id: 30 }] as Update[];
        },
      },
      handleUpdate: async (): Promise<void> => { throw new Error("durability barrier failed"); },
      errorHandler: (): void => { handledErrors++; },
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await expect(runner.task()).rejects.toThrow("durability barrier failed");
    expect(handledErrors).toBe(1);
    expect(fetchOffsets).toEqual([0]);
  });

  test("后一条失败前已用独立 offset 确认前一条，不会重投其非幂等副作用", async () => {
    const fetchOffsets: number[] = [];
    let fetchCount: number = 0;
    let sentCopies: number = 0;
    let handledErrors: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number; limit: number }): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          expect(args.limit).toBe(1);
          fetchCount++;
          return [{ update_id: fetchCount === 1 ? 31 : 32 }] as Update[];
        },
      },
      handleUpdate: async (update: Update): Promise<void> => {
        if (update.update_id === 31) {
          sentCopies++;
          return;
        }
        throw new Error("second update failed");
      },
      errorHandler: (): void => { handledErrors++; },
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await expect(runner.task()).rejects.toThrow("second update failed");

    expect(runner.size()).toBe(0);
    expect(runner.hasFailedUpdate()).toBeTrue();
    expect(handledErrors).toBe(1);
    expect(sentCopies).toBe(1);
    expect(fetchOffsets).toEqual([0, 32]);
  });

  test("取数端若违反 limit 契约，在执行任何 update 副作用前失败", async () => {
    let handledUpdates: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (): Promise<Update[]> => [
          { update_id: 33 },
          { update_id: 34 },
        ] as Update[],
      },
      handleUpdate: async (): Promise<void> => { handledUpdates++; },
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await expect(runner.task()).rejects.toThrow("returned 2 updates");
    expect(handledUpdates).toBe(0);
    expect(runner.size()).toBe(0);
    expect(runner.hasFailedUpdate()).toBeFalse();
  });

  test("停机放弃在途 update 时，随后失败仍由 hasFailedUpdate 挡住最终 offset", async () => {
    // stop() 让取数循环赢下 Promise.race 并直接 return，之后 updateTask 的 rejection
    // 再没有观察者、task() 正常 resolve。只靠 task() 的话生命周期会照常确认最终
    // offset，把这条从未成功处理的 update 一并确认掉，Telegram 不再重投。
    const gate = deferred();
    let handledErrors: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (): Promise<Update[]> => [{ update_id: 60 }] as Update[],
      },
      handleUpdate: async (): Promise<void> => {
        await gate.promise;
        throw new Error("durability barrier failed during shutdown");
      },
      errorHandler: (): void => { handledErrors++; },
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    await runner.stop();
    expect(runner.hasFailedUpdate()).toBeFalse();

    gate.resolve();
    // 取数循环已经放手，这里只等 handleUpdate 自己走完 catch/finally。
    await Bun.sleep(0);
    await Bun.sleep(0);

    // size() 归零与标记生效必须同步：生命周期正是在排空之后读这个标记。
    expect(runner.size()).toBe(0);
    expect(runner.hasFailedUpdate()).toBeTrue();
    expect(handledErrors).toBe(1);
    await expect(runner.task()).resolves.toBeUndefined();
  });

  test("没有任何 update 失败时 hasFailedUpdate 保持为假", async () => {
    let fetchCount: number = 0;
    const fakeBot = {
      api: {
        // 第二次取数必须挂住：整批瞬间完成的话取数循环会在微任务里无限打转，
        // 宏任务（Bun.sleep）永远排不上。
        getUpdates: async (_args: { offset: number }, signal: AbortSignal): Promise<Update[]> => {
          fetchCount++;
          if (fetchCount === 1) return [{ update_id: 70 }] as Update[];
          return await new Promise<Update[]>((_resolve, reject: (reason?: unknown) => void): void => {
            signal.addEventListener("abort", (): void => reject(new Error("aborted")));
          });
        },
      },
      handleUpdate: async (): Promise<void> => {},
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    await runner.stop();

    expect(runner.hasFailedUpdate()).toBeFalse();
  });

  test("error handler 有意重抛原始错误时不误报 handler 自身失败", async () => {
    const update = { update_id: 40 } as Update;
    const middlewareError = new Error("middleware failed");
    const botError = new BotError(middlewareError, { update } as Context);
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    const fakeBot = {
      api: {
        getUpdates: async (): Promise<Update[]> => [update],
      },
      handleUpdate: async (): Promise<never> => { throw botError; },
      errorHandler: (error: BotError<Context>): never => { throw error.error; },
    };

    try {
      const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
      await expect(runner.task()).rejects.toBe(botError);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  test("error handler 抛出不同错误时保留自身失败诊断并传播原始 update 错误", async () => {
    const update = { update_id: 50 } as Update;
    const botError = new BotError(new Error("middleware failed"), { update } as Context);
    const handlerError = new Error("error logger failed");
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    const fakeBot = {
      api: {
        getUpdates: async (): Promise<Update[]> => [update],
      },
      handleUpdate: async (): Promise<never> => { throw botError; },
      errorHandler: (): never => { throw handlerError; },
    };

    try {
      const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
      await expect(runner.task()).rejects.toBe(botError);
      expect(errorLog).toHaveBeenCalledWith("Bot update error handler failed:", handlerError);
    } finally {
      errorLog.mockRestore();
    }
  });
});
