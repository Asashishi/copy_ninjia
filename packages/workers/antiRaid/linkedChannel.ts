import { logger } from "../../infra/logger";
import { joinVerificationApi } from "../../infra/telegram";
import {
  LINKED_CHANNEL_FETCH_TIMEOUT_MS,
  LINKED_CHANNEL_TTL_MS,
} from "../../consts/antiRaid/cache";
import {
  cacheLinkedChannel,
  getOrCreateLinkedChannelFetch,
  linkedChannels,
} from "../../cache/workers/antiRaid/linkedChannels";
import type { LinkedChannelCache } from "../../types/antiRaid/internal";
import type { ChatFullInfo } from "@grammyjs/types";
import { trackAntiRaidTask } from "./taskTracker";
import { withTimeout } from "../../libs/withTimeout";

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
  const task: Promise<boolean | undefined> = getOrCreateLinkedChannelFetch(chatId, (): Promise<void> =>
    withTimeout(
      joinVerificationApi.getChat(chatId),
      LINKED_CHANNEL_FETCH_TIMEOUT_MS,
      `Linked-channel lookup for chat ${chatId}`
    )
      .then((chat: ChatFullInfo): void => {
        cacheLinkedChannel(chatId, "linked_chat_id" in chat && chat.linked_chat_id !== undefined);
      })
      .catch((error: unknown): void => {
        logger.error(`Error fetching linked channel info for chat ${chatId}:`, error);
      })
  ).then((): boolean | undefined => cachedChatHasLinkedChannel(chatId));
  return trackAntiRaidTask({ task });
}
