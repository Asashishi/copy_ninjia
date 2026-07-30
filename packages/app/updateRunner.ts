import { createUpdateFetcher, type FetchOptions } from "@grammyjs/runner";
import type { Update } from "@grammyjs/types";
import { BotError } from "grammy";
import type { Bot, Context } from "grammy";
import { logger } from "../infra/logger";
import {
  runWithUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../infra/updateContext";

export interface AcknowledgedUpdateRunner {
  /** 停止继续取数；已开始的 middleware 留给生命周期按 size() 做有界排空。 */
  stop(): Promise<void>;
  /** 取数循环结束（不代表已开始的 middleware 全部结束）。 */
  task(): Promise<void>;
  /** 当前仍在执行的 middleware 数。 */
  size(): number;
  /**
   * 是否有 update 以抛错结束。为真时**不得**确认最终 Telegram offset：那条
   * update 必须留给 Telegram 在重启后重投。
   *
   * 单独暴露这个标记是因为停机路径会放弃在途批次、不再用它的汇总结果决定
   * 退出状态（见下方取数循环）；正常路径则由 task() 的 rejection 表达失败。
   * 标记在 handleUpdate 抛错的同一个同步段里写下，因此 size() 归零时它必然
   * 已经生效。
   */
  hasFailedUpdate(): boolean;
  /** 中止全部活跃 update，并返回这次实际发出取消信号的数量。 */
  abortActive(): number;
}

/**
 * Telegram 只有在下一次 getUpdates 携带更高 offset 时，才会确认上一批 update。
 * @grammyjs/runner 的默认 concurrent sink 会在旧 update 仍在执行时继续取下一批，
 * 因而天然允许“已确认但 middleware 尚未完成”的窗口。本 runner 仍并发执行
 * Telegram 单次返回的整批 update，但整批全部成功前不再调用 getUpdates；
 * 任一 update 失败则立即取消同批其它 update 并向生命周期传播首个错误。
 *
 * 停机时 stop 会立即结束取数循环，而不是等待可能悬挂的 middleware；调用方可
 * 用 size() 有界排空。只有排空成功后，生命周期才显式确认最后一个 update id。
 */
export function runAcknowledgedUpdateBatches(
  bot: Bot,
  allowedUpdates: NonNullable<FetchOptions["allowed_updates"]>
): AcknowledgedUpdateRunner {
  // 形参 signal 用的是 @grammyjs/runner 内部的 abort-controller shim 类型，
  // 无法从公开入口引用，因此借 ReturnType 精确表达而不是手写形参类型。
  const fetchUpdates: ReturnType<typeof createUpdateFetcher<Update, unknown>> =
    createUpdateFetcher(bot, { fetch: { allowed_updates: allowedUpdates } });
  let running: boolean = true;
  let failedUpdate: boolean = false;
  const activeUpdateControllers: Set<AbortController> = new Set();
  let currentAbortController: AbortController | null = null;
  let resolveStop: (() => void) | undefined;
  const stopped: Promise<void> = new Promise((resolve: (value: void | PromiseLike<void>) => void): void => { resolveStop = resolve; });

  const abortActiveUpdates = (reason: DOMException): number => {
    let aborted: number = 0;
    for (const controller of activeUpdateControllers) {
      if (controller.signal.aborted) continue;
      controller.abort(reason);
      aborted++;
    }
    return aborted;
  };

  const handleUpdate = async (update: Update): Promise<void> => {
    const updateController: AbortController = new AbortController();
    activeUpdateControllers.add(updateController);
    try {
      await runWithUpdateAbortSignal(
        updateController.signal,
        (): Promise<void> => bot.handleUpdate(update)
      );
      // handler 可能没有 await 可取消操作；即便它恰好在 abort 后自行返回，
      // 该 update 仍不能被当成成功完成并跨过 offset。
      throwIfUpdateAborted(updateController.signal);
    } catch (error: unknown) {
      // 记在这里、而不是等 batch 汇总：任何以抛错离开本函数的 update 都不能被
      // 确认，而停机时取数循环会放弃在途批次，那次汇总 rejection 已经没有观察
      // 者了。放在 catch 的第一句是为了同时覆盖下面两条 throw；这一句与 finally
      // 里的 delete 处在同一个同步段，因此 size() 归零时它必然已经写好。
      failedUpdate = true;
      if (updateController.signal.aborted) throw error;
      try {
        await bot.errorHandler(error as BotError<Context>);
      } catch (handlerError: unknown) {
        // bot.catch 可以有意重抛 BotError 或其原始 error，让 acknowledged
        // runner 保留失败 update；这属于传播协议，不是 error handler 自身
        // 故障。只有抛出了不同对象时才追加诊断，避免二次扫描再次误报。
        const deliberatelyPropagated: boolean = handlerError === error ||
          (error instanceof BotError && handlerError === error.error);
        if (!deliberatelyPropagated) {
          logger.error("Bot update error handler failed:", handlerError);
        }
      }
      // 处理失败的 update 不能被下一轮 getUpdates 确认；让整批失败并交给
      // 应用生命周期停止进程，由 Telegram 在重启后重新投递。
      throw error;
    } finally {
      activeUpdateControllers.delete(updateController);
    }
  };

  const task: Promise<void> = (async (): Promise<void> => {
    while (running) {
      const controller: AbortController = new AbortController();
      currentAbortController = controller;
      let updates: Update[];
      try {
        updates = await fetchUpdates(
          100,
          controller.signal as unknown as Parameters<typeof fetchUpdates>[1]
        );
      } catch (error: unknown) {
        if (!running || controller.signal.aborted) return;
        throw error;
      } finally {
        if (currentAbortController === controller) currentAbortController = null;
      }
      if (!running) return;

      let firstFailureSignaled: boolean = false;
      let rejectFirstFailure: ((reason?: unknown) => void) | undefined;
      const firstFailure: Promise<void> = new Promise((
        _resolve: (value: void | PromiseLike<void>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        rejectFirstFailure = reject;
      });
      const updateTasks: Promise<void>[] = updates.map(handleUpdate);
      for (const updateTask of updateTasks) {
        // 单独观察首错，让失败不再被同批永久悬挂的 middleware 遮住。
        void updateTask.catch((error: unknown): void => {
          if (firstFailureSignaled) return;
          firstFailureSignaled = true;
          abortActiveUpdates(new DOMException(
            "Telegram update aborted because another update in the batch failed.",
            "AbortError"
          ));
          rejectFirstFailure?.(error);
        });
      }
      // 即便首错已让 runner 退出，仍持续观察所有 sibling 的迟到结果，避免
      // 忽略 AbortSignal 的 middleware 最终 rejection 变成 unhandledRejection。
      const allSettled: Promise<void> = Promise.allSettled(updateTasks).then((results: PromiseSettledResult<void>[]): void => {
        const failures: unknown[] = results
          .filter((result: PromiseSettledResult<void>): result is PromiseRejectedResult => result.status === "rejected")
          .map((result: PromiseRejectedResult): unknown => result.reason as unknown);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Multiple Telegram updates failed.");
      });
      const batch: Promise<void> = Promise.race([firstFailure, allSettled]);
      await Promise.race([batch, stopped]);
      // 停机：不等这批走完（middleware 可能悬挂），交给生命周期按 size() 做有界
      // 排空。这批里失败的 update 因此只能靠 failedUpdate 表达——放弃 await 之后
      // 取数循环不再用 batch 的结算结果决定退出状态，光凭 task() 正常 resolve
      // 会让生命周期把失败的那条一起确认掉。
      if (!running) return;
      await batch;
      // 只有走到这里，createUpdateFetcher 内部已推进的 offset 才会在下一轮
      // getUpdates 中真正发给 Telegram，确认整批 update。
    }
  })();

  return {
    stop: async (): Promise<void> => {
      if (!running) return task;
      running = false;
      resolveStop?.();
      currentAbortController?.abort();
      await task;
    },
    task: (): Promise<void> => task,
    size: (): number => activeUpdateControllers.size,
    hasFailedUpdate: (): boolean => failedUpdate,
    abortActive: (): number => abortActiveUpdates(new DOMException(
      "Telegram update aborted because the shutdown drain budget was exhausted.",
      "AbortError"
    )),
  };
}
