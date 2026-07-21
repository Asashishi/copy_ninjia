import { logger } from "../../infra/logger";
import { joinVerificationApi } from "../../infra/telegram";
import { LINKED_CHANNEL_TTL_MS } from "../../consts/antiRaid/cache";
import {
  cacheLinkedChannel,
  getOrCreateLinkedChannelFetch,
  linkedChannels,
} from "../../cache/antiRaid/linkedChannels";

/**
 * 本群有没有关联频道（getChat 的 linked_chat_id），带 TTL 缓存 + 进行中
 * 去重。没有关联频道的群不存在评论区，楼中楼判定应整体跳过——
 * message_thread_id 在普通回复链上也可能出现，不收窄的话普通群里的回复
 * 会误走评论区豁免。缓存未命中时仍先按「有」处理：评论/回帖入群的投递
 * 顺序不稳定，漏判会让真人进入验证甚至在锁定期被踢；代价是冷缓存首次
 * 判断可能暂时放宽。异步拉取回填后，后续消息按真实关联状态判定。
 */
export function chatHasLinkedChannel(chatId: number): boolean {
  const cached = linkedChannels.get(chatId);
  if (cached && Date.now() - cached.fetchedAt <= LINKED_CHANNEL_TTL_MS) return cached.hasLinked;
  void getOrCreateLinkedChannelFetch(chatId, () =>
    joinVerificationApi
      .getChat(chatId)
      .then((chat) => {
        cacheLinkedChannel(chatId, "linked_chat_id" in chat && chat.linked_chat_id !== undefined);
      })
      .catch((error: unknown) => {
        logger.error(`Error fetching linked channel info for chat ${chatId}:`, error);
      })
  );
  return cached ? cached.hasLinked : true;
}
