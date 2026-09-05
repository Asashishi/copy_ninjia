import { logger } from "../../infra/logger";
import { telegramApi } from "../../infra/telegram";
import { signalArgs } from "../../infra/telegram/actions/core";
import {
  LINKED_CHANNEL_FETCH_TIMEOUT_MS,
  LINKED_CHANNEL_TTL_MS,
} from "../../consts/antiRaid/cache";
import {
  cacheLinkedChannel,
  getOrCreateLinkedChannelFetch,
  isCurrentLinkedChannelCacheGeneration,
  linkedChannelCacheGeneration,
  linkedChannels,
} from "../../cache/workers/antiRaid/linkedChannels";
import type { LinkedChannelCache } from "../../types/antiRaid/internal";
import type { ChatFullInfo } from "grammy/types";
import { trackAntiRaidTask } from "./taskTracker";

/** 只读取未过期缓存。undefined 表示必须异步确认，不能据此豁免。 */
export function cachedChatHasLinkedChannel(chatId: number): boolean | undefined {
  const cached: LinkedChannelCache | undefined = linkedChannels.get(chatId);
  if (cached && Date.now() - cached.fetchedAt <= LINKED_CHANNEL_TTL_MS) return cached.hasLinked;
  return undefined;
}

/**
 * 拉取本群是否有关联频道，同群请求复用在途 Promise。查询失败不写缓存并返回
 * undefined，让本次消息保持普通待验证语义；下一条消息仍可重新查询。
 */
export function fetchChatHasLinkedChannel(chatId: number): Promise<boolean | undefined> {
  const generation: number = linkedChannelCacheGeneration.current;
  const task: Promise<boolean | undefined> = getOrCreateLinkedChannelFetch(chatId, (): Promise<void> =>
    telegramApi.getChat(chatId, ...signalArgs(AbortSignal.timeout(LINKED_CHANNEL_FETCH_TIMEOUT_MS)))
      .then((chat: ChatFullInfo): void => {
        if (!isCurrentLinkedChannelCacheGeneration(generation)) return;
        cacheLinkedChannel(chatId, "linked_chat_id" in chat && chat.linked_chat_id !== undefined);
      })
      .catch((error: unknown): void => {
        logger.error(`Error fetching linked channel info for chat ${chatId}:`, error);
      })
  ).then((): boolean | undefined => cachedChatHasLinkedChannel(chatId));
  return trackAntiRaidTask({ task });
}
