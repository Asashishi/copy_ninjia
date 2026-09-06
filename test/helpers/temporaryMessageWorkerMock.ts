import type * as TelegramModule from "../../packages/infra/telegram";
import { mock } from "bun:test";
import type { SendTemporaryMessageFromMainParams } from "../../packages/infra/telegram/workerClient";
import type { TelegramWorkerTemporaryMessageResult } from "../../packages/types/telegramWorker";

/** 领域单测用既有 Telegram 替身模拟主线程组合能力；真实边界由桥接测试覆盖。 */
export function installTemporaryMessageWorkerMock(): void {
  mock.module("../../packages/infra/telegram/workerClient", (): object => ({
    sendTemporaryMessageFromMain: async (params: SendTemporaryMessageFromMainParams): Promise<TelegramWorkerTemporaryMessageResult | undefined> => {
      const telegram: typeof TelegramModule = await import("../../packages/infra/telegram");
      const messageId: number | undefined = await telegram.sendMessage({
        chatId: params.chatId, text: params.text, signal: params.signal,
        api: telegram.telegramApi, messageThreadId: params.messageThreadId,
      });
      if (messageId === undefined) return undefined;
      telegram.deleteMessageAfter?.({ chatId: params.chatId, messageId, delayMs: params.deleteAfterMs, api: telegram.telegramApi, batchOnFlush: true });
      return { messageId, sentAt: Date.now() };
    },
  }));
}
