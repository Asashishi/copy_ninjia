import type { LinkedChannelCache } from "../../../types/antiRaid/internal";
import { ANTI_RAID_CHAT_CACHE_MAX, LINKED_CHANNEL_TTL_MS } from "../../../consts/antiRaid/cache";
import {
  setBoundedMapValue,
  sweepExpiredSnapshots,
} from "../../../libs/boundedMap";

/** 关联频道按需缓存（packages/workers/antiRaid/linkedChannel.ts）的内存状态；Worker
 * 重建后从空表开始，由下一次按需查询重新填充。 */

/** 各群是否有关联频道的按需 TTL 缓存。 */
export const linkedChannels: Map<number, LinkedChannelCache> = new Map();
/** 进行中的关联频道信息拉取，按 chatId 去重。 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();
/**
 * 关联频道整表世代号；只在 reset 时递增，阻止清空前的网络结果写回新一代快照。
 * Worker 重建时从 0 开始；单个数字无容量增长，随 owner isolate 一起销毁。
 */
export const linkedChannelCacheGeneration: { current: number } = { current: 0 };

/** 某次拉取启动时记录的关联频道缓存世代是否仍有效。 */
export function isCurrentLinkedChannelCacheGeneration(
  generation: number
): boolean {
  return linkedChannelCacheGeneration.current === generation;
}

/** 在 500 群硬顶内落一份关联频道快照。 */
export function cacheLinkedChannel(chatId: number, hasLinked: boolean, fetchedAt: number = Date.now()): void {
  setBoundedMapValue({
    map: linkedChannels,
    key: chatId,
    value: { hasLinked, fetchedAt },
    maxEntries: ANTI_RAID_CHAT_CACHE_MAX,
  });
}

/** 获取或创建同群唯一一次关联频道拉取；settle 后自动释放在途槽位。 */
export function getOrCreateLinkedChannelFetch(chatId: number, create: () => Promise<void>): Promise<void> {
  const existing: Promise<void> | undefined = linkedChannelFetches.get(chatId);
  if (existing) return existing;
  const inFlight: Promise<void> = create().finally((): void => {
    if (linkedChannelFetches.get(chatId) === inFlight) {
      linkedChannelFetches.delete(chatId);
    }
  });
  linkedChannelFetches.set(chatId, inFlight);
  return inFlight;
}

/** 淘汰过期快照；仍在拉取的群保留旧值作为同步降级结果。 */
export function sweepLinkedChannelCache(now: number = Date.now()): number {
  return sweepExpiredSnapshots({
    snapshots: linkedChannels,
    inFlight: linkedChannelFetches,
    ttlMs: LINKED_CHANNEL_TTL_MS,
    now,
  });
}

/** Worker dispose/测试隔离时清空关联频道缓存及其在途状态。 */
export function resetLinkedChannelCache(): void {
  linkedChannels.clear();
  linkedChannelFetches.clear();
  linkedChannelCacheGeneration.current++;
}
