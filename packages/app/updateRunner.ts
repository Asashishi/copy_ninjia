import { createUpdateFetcher, type FetchOptions } from "@grammyjs/runner";
import type { Update } from "@grammyjs/types";
import { BotError } from "grammy";
import type { Bot, Context } from "grammy";
import { logger } from "../infra/logger";

export interface AcknowledgedUpdateRunner {
  /** 停止继续取数；已开始的 middleware 留给生命周期按 size() 做有界排空。 */
  stop(): Promise<void>;
  /** 取数循环结束（不代表已开始的 middleware 全部结束）。 */
  task(): Promise<void>;
  /** 当前仍在执行的 middleware 数。 */
  size(): number;
}

/**
 * Telegram 只有在下一次 getUpdates 携带更高 offset 时，才会确认上一批 update。
 * @grammyjs/runner 的默认 concurrent sink 会在旧 update 仍在执行时继续取下一批，
 * 因而天然允许“已确认但 middleware 尚未完成”的窗口。本 runner 仍并发执行
 * Telegram 单次返回的整批 update，但整批全部完成前不再调用 getUpdates。
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
  let activeUpdates: number = 0;
  let currentAbortController: AbortController | null = null;
  let resolveStop: (() => void) | undefined;
  const stopped: Promise<void> = new Promise((resolve: (value: void | PromiseLike<void>) => void): void => { resolveStop = resolve; });

  const handleUpdate = async (update: Update): Promise<void> => {
    activeUpdates++;
    try {
      await bot.handleUpdate(update);
    } catch (error: unknown) {
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
      activeUpdates--;
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

      const batch: Promise<void> = Promise.allSettled(updates.map(handleUpdate)).then((results: PromiseSettledResult<void>[]): void => {
        const failures: unknown[] = results
          .filter((result: PromiseSettledResult<void>): result is PromiseRejectedResult => result.status === "rejected")
          .map((result: PromiseRejectedResult): unknown => result.reason as unknown);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Multiple Telegram updates failed.");
      });
      await Promise.race([batch, stopped]);
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
    size: (): number => activeUpdates,
  };
}
