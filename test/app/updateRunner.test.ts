import { describe, expect, spyOn, test } from "bun:test";
import type { Update } from "@grammyjs/types";
import { BotError } from "grammy";
import type { Bot, Context } from "grammy";
import { runAcknowledgedUpdateBatches } from "../../packages/app/updateRunner";
import { logger } from "../../packages/infra/logger";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: (): void => resolve?.() };
}

describe("acknowledgement-safe update runner", () => {
  test("整批 middleware 全部完成前不发起携带更高 offset 的下一次 getUpdates", async () => {
    const first = deferred();
    const second = deferred();
    const fetchOffsets: number[] = [];
    let fetchCount: number = 0;
    const fakeBot = {
      api: {
        getUpdates: async (args: { offset: number }, signal: AbortSignal): Promise<Update[]> => {
          fetchOffsets.push(args.offset);
          fetchCount++;
          if (fetchCount === 1) {
            return [{ update_id: 10 }, { update_id: 11 }] as Update[];
          }
          return await new Promise<Update[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      },
      handleUpdate: async (update: Update): Promise<void> => {
        await (update.update_id === 10 ? first.promise : second.promise);
      },
      errorHandler: (): void => {},
    };

    const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
    await Bun.sleep(0);
    expect(fetchOffsets).toEqual([0]);
    expect(runner.size()).toBe(2);

    second.resolve();
    await Bun.sleep(0);
    expect(fetchOffsets).toEqual([0]);
    expect(runner.size()).toBe(1);

    first.resolve();
    await Bun.sleep(0);
    expect(fetchOffsets).toEqual([0, 12]);
    await runner.stop();
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
