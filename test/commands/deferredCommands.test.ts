import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  drainDeferredCommandRuntime,
  initDeferredCommandRuntime,
  submitDeferredCommand,
} from "../../packages/commands/deferredCommands";
import { deferredCommandRuntime } from "../../packages/cache/main/deferredCommands";
import { currentUpdateTopic, runWithUpdateAbortSignal } from "../../packages/infra/updateContext";
import {
  DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
  DEFERRED_COMMAND_MAX_CONCURRENT,
  DEFERRED_COMMAND_MAX_PENDING,
} from "../../packages/consts/deferredCommands";

/** 可以从外部结算的一个任务。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise: Promise<void> = new Promise<void>((resolve: () => void): void => { open = resolve; });
  return { promise, open };
}

beforeEach(() => {
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async () => {
  await drainDeferredCommandRuntime(0);
});

describe("延迟命令执行器", () => {
  test("出队执行时恢复接纳时的触发话题，占满槽位后排队的任务同样如此", async () => {
    const blockers: { promise: Promise<void>; open: () => void }[] = [];
    const topics: unknown[] = [];
    await runWithUpdateAbortSignal(new AbortController().signal, async (): Promise<void> => {
      for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
        const blocker = gate();
        blockers.push(blocker);
        submitDeferredCommand({ priority: "interactive", task: (): Promise<void> => blocker.promise, errorLabel: "test:" });
      }
      submitDeferredCommand({ priority: "interactive", task: async (): Promise<void> => { topics.push(currentUpdateTopic()); }, errorLabel: "test:" });
    }, { chatId: -1001, threadId: 42 });
    expect(topics).toEqual([]);
    for (const blocker of blockers) blocker.open();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(topics).toEqual([{ chatId: -1001, threadId: 42 }]);
  });

  test("后台档最多占 DEFERRED_COMMAND_MAX_BACKGROUND_PENDING 个等待位，其余等待位仍接纳交互请求", async () => {
    expect(DEFERRED_COMMAND_MAX_BACKGROUND_PENDING).toBeLessThan(DEFERRED_COMMAND_MAX_PENDING);
    const blocker = gate();
    for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
      expect(submitDeferredCommand({ priority: "interactive", task: (): Promise<void> => blocker.promise, errorLabel: "test:" })).toBe(true);
    }
    for (let index: number = 0; index < DEFERRED_COMMAND_MAX_BACKGROUND_PENDING; index++) {
      expect(submitDeferredCommand({ priority: "background", task: async (): Promise<void> => {}, errorLabel: "test:" })).toBe(true);
    }
    expect(submitDeferredCommand({ priority: "background", task: async (): Promise<void> => {}, errorLabel: "test:" })).toBe(false);
    expect(submitDeferredCommand({ priority: "interactive", task: async (): Promise<void> => {}, errorLabel: "test:" })).toBe(true);
    blocker.open();
    expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
  });

  test("槽位空出来时，等待中的交互请求先于后台任务开始", async () => {
    const blocker = gate();
    const started: string[] = [];
    for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
      submitDeferredCommand({ priority: "interactive", task: (): Promise<void> => blocker.promise, errorLabel: "test:" });
    }
    submitDeferredCommand({ priority: "background", task: async (): Promise<void> => { started.push("background"); }, errorLabel: "test:" });
    submitDeferredCommand({ priority: "interactive", task: async (): Promise<void> => { started.push("interactive"); }, errorLabel: "test:" });
    blocker.open();
    expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
    expect(started).toEqual(["interactive", "background"]);
  });

  test("onSkipped 只在已接纳的任务没开跑就被撤销时调用，开跑过的任务不调用", async () => {
    const blocker = gate();
    const skipped: string[] = [];
    for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
      submitDeferredCommand({
        priority: "interactive",
        task: (): Promise<void> => blocker.promise,
        errorLabel: "test:",
        onSkipped: (): void => { skipped.push("running"); },
      });
    }
    // 执行器在微任务里开跑任务；先让占位任务真正开跑，排空时它们才算在途而不是撤销。
    await Bun.sleep(0);
    let queuedRan: boolean = false;
    expect(submitDeferredCommand({
      priority: "background",
      task: async (): Promise<void> => { queuedRan = true; },
      errorLabel: "test:",
      onSkipped: (): void => { skipped.push("queued"); },
    })).toBeTrue();

    expect(await drainDeferredCommandRuntime(0)).toBe("timedOut");
    await Bun.sleep(0);
    expect(skipped).toEqual(["queued"]);
    blocker.open();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(queuedRan).toBeFalse();
    expect(skipped).toEqual(["queued"]);
  });

  test("非法停机预算在关闭接纳之前拒绝", async () => {
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(drainDeferredCommandRuntime(budget)).rejects.toThrow(
        new RangeError("Deferred command drain timeout must be a non-negative finite number.")
      );
    }
    expect(deferredCommandRuntime.current?.accepting).toBeTrue();
  });

  test("未启动或已停止接纳时拒绝", () => {
    deferredCommandRuntime.current = null;
    expect(submitDeferredCommand({ priority: "interactive", task: async (): Promise<void> => {}, errorLabel: "test:" })).toBe(false);
    initDeferredCommandRuntime();
    deferredCommandRuntime.current!.accepting = false;
    expect(submitDeferredCommand({ priority: "background", task: async (): Promise<void> => {}, errorLabel: "test:" })).toBe(false);
  });
});
