import { describe, expect, test } from "bun:test";
import type { Update } from "@grammyjs/types";
import type { Bot } from "grammy";
import { runAcknowledgedUpdateBatches } from "../../src/app/updateRunner";

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
});
