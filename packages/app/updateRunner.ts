import type { Update } from "grammy/types";
import { BotError } from "grammy";
import type { Bot, Context } from "grammy";
import { logger } from "../infra/logger";
import {
  runWithUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../infra/updateContext";
import type { AcknowledgedUpdateRunner, TelegramAllowedUpdates } from "../types/lifecycle";
import { createAcknowledgedUpdateFetcher } from "./updateFetcher";

/**
 * 每次只取一条更新，middleware 成功完成后才发起下一次取数。
 * stop 取消取数与退避并唤醒当前等待；在途 middleware 由生命周期按 size() 排空。
 * @see ../../docs/cn/04-invariants.md
 */
export function runAcknowledgedUpdateBatches(
  bot: Bot,
  allowedUpdates: TelegramAllowedUpdates
): AcknowledgedUpdateRunner {
  const fetchUpdates: ReturnType<typeof createAcknowledgedUpdateFetcher> =
    createAcknowledgedUpdateFetcher(bot.api, allowedUpdates);
  let running: boolean = true;
  let failedUpdate: boolean = false;
  const activeUpdateControllers: Set<AbortController> = new Set();
  let currentAbortController: AbortController | null = null;
  let resolveStop: (() => void) | undefined;

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
      // 停机后的迟到失败也必须阻止确认；size() 归零之前先记下失败标志。
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
      // 处理失败的 update 不能被下一轮 getUpdates 确认；让 runner 失败并交给
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
        updates = await fetchUpdates(controller.signal);
      } catch (error: unknown) {
        if (!running || controller.signal.aborted) return;
        throw error;
      } finally {
        if (currentAbortController === controller) currentAbortController = null;
      }
      if (!running) return;
      if (updates.length === 0) continue;
      // 异常响应必须在执行任何副作用前 fail closed。
      if (updates.length !== 1) {
        throw new Error(`Telegram returned ${updates.length} updates for a single-update fetch.`);
      }

      const updateTask: Promise<void> = handleUpdate(updates[0]!);
      await new Promise<void>((
        resolve: (value: void | PromiseLike<void>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        // middleware 可在同步段调用 stop，登记前必须检查它是否已经停止。
        if (running) resolveStop = resolve;
        else resolve();
        void updateTask.then(resolve, reject);
      }).finally((): void => { resolveStop = undefined; });
      // 停机后由生命周期排空在途 middleware，并读取 failedUpdate 决定是否确认。
      if (!running) return;
      await updateTask;
      // 只有走到这里，取数闭包内保存的 offset 才会在下一轮
      // getUpdates 中真正发给 Telegram，确认这一条 update。
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
