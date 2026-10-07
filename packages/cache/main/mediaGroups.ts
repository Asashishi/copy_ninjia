/** owner: main。 */

import { MEDIA_GROUP_CACHE_MAX } from "../../consts/hImage";
import { LruCache } from "../../libs/lruCache";
import type { MediaGroupImages } from "../../types/hImage";

/**
 * 最近见过的相册里能收进随机图库的图，键是 Telegram 的 media_group_id
 * （infra/mediaGroups.ts）。
 *
 * `/h_image add` 据此补齐被回复图片所在相册的其余几张。消息流水线每见到一条相册里的图就
 * 写入（非私聊，按 chatId 核对归属，每组至多 MEDIA_GROUP_ITEMS_MAX 张）；容量
 * MEDIA_GROUP_CACHE_MAX 组，满额淘汰最久未写入的一组，不随群 teardown 清理。
 * 不跨线程、不持久化；进程重启后为空，此时只收得到被回复的那一张。
 */
export const mediaGroupImages: LruCache<string, MediaGroupImages> =
  new LruCache<string, MediaGroupImages>(MEDIA_GROUP_CACHE_MAX);
