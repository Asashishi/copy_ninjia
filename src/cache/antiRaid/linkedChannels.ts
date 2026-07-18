import type { LinkedChannelCache } from "../../types/antiRaid/internal";
import { ANTI_RAID_CHAT_CACHE_MAX, LINKED_CHANNEL_TTL_MS } from "../../consts/antiRaid/cache";
import { setBoundedMapValue } from "../../libs/boundedMap";

/** 各群是否有关联频道的按需 TTL 缓存。 */
export const linkedChannels: Map<number, LinkedChannelCache> = new Map();
/** 进行中的关联频道信息拉取，按 chatId 去重。 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();

/** 在 500 群硬顶内落一份关联频道快照。 */
export function cacheLinkedChannel(chatId: number, hasLinked: boolean, fetchedAt: number = Date.now()): void {
  setBoundedMapValue(linkedChannels, chatId, { hasLinked, fetchedAt }, ANTI_RAID_CHAT_CACHE_MAX);
}

/** 获取或创建同群唯一一次关联频道拉取；settle 后自动释放在途槽位。 */
export function getOrCreateLinkedChannelFetch(chatId: number, create: () => Promise<void>): Promise<void> {
  let inFlight = linkedChannelFetches.get(chatId);
  if (inFlight) return inFlight;
  inFlight = create().finally(() => linkedChannelFetches.delete(chatId));
  linkedChannelFetches.set(chatId, inFlight);
  return inFlight;
}

/** 淘汰过期快照；仍在拉取的群保留旧值作为同步降级结果。 */
export function sweepLinkedChannelCache(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const [chatId, cached] of linkedChannels) {
    if (now - cached.fetchedAt > LINKED_CHANNEL_TTL_MS && !linkedChannelFetches.has(chatId)) {
      linkedChannels.delete(chatId);
      deleted++;
    }
  }
  return deleted;
}

/** Worker dispose/测试隔离时清空关联频道缓存及其在途状态。 */
export function resetLinkedChannelCache(): void {
  linkedChannels.clear();
  linkedChannelFetches.clear();
}
