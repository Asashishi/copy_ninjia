import { createUpdateFetcher, type FetchOptions } from "@grammyjs/runner";
import type { Update } from "@grammyjs/types";
import type { Bot, BotError, Context } from "grammy";
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
  const fetchUpdates = createUpdateFetcher(bot, { fetch: { allowed_updates: allowedUpdates } });
  let running: boolean = true;
  let activeUpdates: number = 0;
  let currentAbortController: AbortController | null = null;
  let resolveStop: (() => void) | undefined;
  const stopped: Promise<void> = new Promise((resolve) => { resolveStop = resolve; });

  const handleUpdate = async (update: Update): Promise<void> => {
    activeUpdates++;
    try {
      await bot.handleUpdate(update);
    } catch (error: unknown) {
      try {
        await bot.errorHandler(error as BotError<Context>);
      } catch (handlerError: unknown) {
        logger.error("Bot update error handler failed:", handlerError);
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
      const controller = new AbortController();
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

      const batch: Promise<void> = Promise.all(updates.map(handleUpdate)).then(() => undefined);
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
