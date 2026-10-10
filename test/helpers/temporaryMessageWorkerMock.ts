import type * as TelegramModule from "../../packages/infra/telegram";
import { mock } from "bun:test";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../packages/consts/commands";
import type { SendTemporaryMessageFromMainParams } from "../../packages/infra/telegram/workerClient";
import type { TelegramWorkerTemporaryMessageResult } from "../../packages/types/telegramWorker";

/**
 * 领域单测用既有 Telegram 替身模拟主线程组合能力（infra/telegram/temporaryMessage.ts 的
 * sendTemporaryMessageOnMain）：发送成功即登记统一延迟删除，与生产一样在 onSent 里完成；
 * 替身 sendMessage 不回调 onSent 时，拿到 message_id 后补做同一登记。替身必须提供
 * deleteMessageAfter，缺失即报错。真实边界由桥接测试覆盖。
 */
export function installTemporaryMessageWorkerMock(): void {
  mock.module("../../packages/infra/telegram/workerClient", (): object => ({
    sendTemporaryMessageFromMain: async (params: SendTemporaryMessageFromMainParams): Promise<TelegramWorkerTemporaryMessageResult | undefined> => {
      const telegram: typeof TelegramModule = await import("../../packages/infra/telegram");
      let registered: TelegramWorkerTemporaryMessageResult | undefined;
      const register = (messageId: number): void => {
        telegram.deleteMessageAfter({ chatId: params.chatId, messageId, delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS, api: telegram.telegramApi });
        registered = { messageId, sentAt: Date.now() };
      };
      const messageId: number | undefined = await telegram.sendMessage({
        chatId: params.chatId, text: params.text, signal: params.signal,
        api: telegram.telegramApi, messageThreadId: params.messageThreadId,
        replyToMessageId: params.replyToMessageId,
        onSent: register,
      });
      if (messageId === undefined) return undefined;
      if (registered === undefined) register(messageId);
      return registered;
    },
  }));
}
