import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runBlocklistFanOut } from "../../packages/commands/blocklistFanOut";
import {
  drainDeferredCommandRuntime,
  initDeferredCommandRuntime,
  submitDeferredCommand,
} from "../../packages/commands/deferredCommands";
import { deferredCommandRuntime } from "../../packages/cache/main/deferredCommands";
import { runBlocklistIdentityMutation } from "../../packages/infra/identityPolicy/coordination";
import {
  DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
  DEFERRED_COMMAND_MAX_CONCURRENT,
} from "../../packages/consts/deferredCommands";

const IDENTITY_ID: number = 4242;

/**
 * 占满执行器：并发槽位由交互任务占住，并发满后先提交 first，再用后台任务补满后台等待位，
 * 之后同档的提交都会被拒收。返回放行占位任务的函数。
 */
async function fillExecutorAround(first: () => Promise<void>): Promise<() => void> {
  const blocker: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
    expect(submitDeferredCommand({ priority: "interactive", task: (): Promise<void> => blocker.promise, errorLabel: "test:" })).toBeTrue();
  }
  await first();
  for (let index: number = 1; index < DEFERRED_COMMAND_MAX_BACKGROUND_PENDING; index++) {
    expect(submitDeferredCommand({ priority: "background", task: (): Promise<void> => blocker.promise, errorLabel: "test:" })).toBeTrue();
  }
  expect(deferredCommandRuntime.current!.runner.backgroundPendingCount).toBe(DEFERRED_COMMAND_MAX_BACKGROUND_PENDING);
  return blocker.resolve;
}

beforeEach((): void => {
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async (): Promise<void> => {
  await drainDeferredCommandRuntime(0);
});

describe("/block 跨群扇出的同身份顺序", () => {
  test("执行器满额时就地执行的扇出排在仍在排队的同身份扇出之后", async () => {
    const order: string[] = [];
    const release: () => void = await fillExecutorAround((): Promise<void> => runBlocklistFanOut({
      identityId: IDENTITY_ID,
      errorLabel: "test:",
      fanOut: async (): Promise<void> => { order.push("queued fan-out"); },
    }));

    // 执行器拒收，这条就地执行；它必须等前一条同身份扇出跑完。
    const inline: Promise<void> = runBlocklistFanOut({
      identityId: IDENTITY_ID,
      errorLabel: "test:",
      fanOut: async (): Promise<void> => { order.push("inline fan-out"); },
    });
    await Bun.sleep(0);
    expect(order).toEqual([]);

    release();
    await inline;
    expect(order).toEqual(["queued fan-out", "inline fan-out"]);
  });

  test("排队中的扇出被停机撤销时释放串行位，后续同身份变更不被卡住", async () => {
    const order: string[] = [];
    await fillExecutorAround((): Promise<void> => runBlocklistFanOut({
      identityId: IDENTITY_ID,
      errorLabel: "test:",
      fanOut: async (): Promise<void> => { order.push("dropped"); },
    }));
    const inline: Promise<void> = runBlocklistFanOut({
      identityId: IDENTITY_ID,
      errorLabel: "test:",
      fanOut: async (): Promise<void> => { order.push("inline"); },
    });

    // 零预算排空撤销所有排队任务；占位任务仍挂着，不影响串行位释放。
    await drainDeferredCommandRuntime(0);
    await inline;
    expect(order).toEqual(["inline"]);
    await expect(runBlocklistIdentityMutation(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
  });

  test("扇出抛错时仍释放串行位，错误留给执行器记日志", async () => {
    initDeferredCommandRuntime();
    deferredCommandRuntime.current!.accepting = false;
    await expect(runBlocklistFanOut({
      identityId: IDENTITY_ID,
      errorLabel: "test:",
      fanOut: async (): Promise<void> => { throw new Error("fan-out failed"); },
    })).rejects.toThrow("fan-out failed");
    await expect(runBlocklistIdentityMutation(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
  });
});
