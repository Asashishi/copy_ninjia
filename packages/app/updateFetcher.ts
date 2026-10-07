import type { Api } from "grammy";
import type { Update } from "grammy/types";
import {
  UPDATE_POLL_INITIAL_RETRY_MS,
  UPDATE_POLL_LIMIT,
  UPDATE_POLL_MAX_RETRY_MS,
  UPDATE_POLL_RETRY_WINDOW_MS,
  UPDATE_POLL_TIMEOUT_SECONDS,
} from "../consts/updateRunner";
import { logger } from "../infra/logger";
import { createMonotonicDeadline, remainingMonotonicTime } from "../libs/monotonicDeadline";
import { telegramSignal } from "../libs/telegramSignal";
import { sleep } from "../libs/sleep";
import type { TelegramAllowedUpdates } from "../types/lifecycle";

/**
 * 每个 runner 独占一个取数闭包；请求与全部退避继承本次取数的取消信号。
 * 失败退避从 UPDATE_POLL_INITIAL_RETRY_MS 起翻倍，封顶 UPDATE_POLL_MAX_RETRY_MS，
 * 指数退避与 429 等待共用 UPDATE_POLL_RETRY_WINDOW_MS，等待达到或超过剩余预算时抛出最后错误。
 * 返回的 offset 只在下次调用时发送，调用方须先完成本条 middleware。
 * @see ../../docs/cn/04-invariants.md
 */
export function createAcknowledgedUpdateFetcher(
  api: Pick<Api, "getUpdates">,
  allowedUpdates: TelegramAllowedUpdates
): (signal: AbortSignal) => Promise<Update[]> {
  let offset: number = 0;
  return async (signal: AbortSignal): Promise<Update[]> => {
    const payload: NonNullable<Parameters<Api["getUpdates"]>[0]> = {
      timeout: UPDATE_POLL_TIMEOUT_SECONDS,
      allowed_updates: allowedUpdates,
      offset,
      limit: UPDATE_POLL_LIMIT,
    };
    // 进程内耗时预算走单调时钟（口径见 docs/cn/04-invariants.md）。
    const retryDeadline: number = createMonotonicDeadline(UPDATE_POLL_RETRY_WINDOW_MS);
    let delay: number = UPDATE_POLL_INITIAL_RETRY_MS;
    for (;;) {
      signal.throwIfAborted();
      try {
        // SDK 声明引用 abort-controller shim；运行时只传递 Bun 原生信号。
        const updates: Update[] = await api.getUpdates(payload, telegramSignal(signal));
        const last: Update | undefined = updates[updates.length - 1];
        if (last !== undefined) offset = last.update_id + 1;
        return updates;
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        logger.error("Error fetching Telegram updates:", error);
        if (typeof error === "object" && error !== null && "error_code" in error) {
          if (error.error_code === 401 || error.error_code === 409) throw error;
          if (error.error_code === 429 && "parameters" in error &&
            typeof error.parameters === "object" && error.parameters !== null &&
            "retry_after" in error.parameters && typeof error.parameters.retry_after === "number") {
            const retryAfterMs: number = error.parameters.retry_after * 1_000;
            if (retryAfterMs >= remainingMonotonicTime(retryDeadline)) throw error;
            await sleep(retryAfterMs, signal);
          }
        }
        if (delay >= remainingMonotonicTime(retryDeadline)) throw error;
        await sleep(delay, signal);
        delay = Math.min(delay * 2, UPDATE_POLL_MAX_RETRY_MS);
      }
    }
  };
}
