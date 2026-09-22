import { MEDIA_GROUP_CACHE_MAX } from "../../consts/hImage";
import { LruCache } from "../../libs/lruCache";
import type { MediaGroupImages } from "../../types/hImage";

/**
 * Owner: 主线程。最近见过的相册里能收进随机图库的图，键是 Telegram 的 media_group_id
 * （infra/mediaGroups.ts）。
 *
 * 相册的每张图是一条独立消息，回复只拿得到被回复的那一条，Bot API 也没有按相册取整组的
 * 接口；`/h_image add` 靠这里补齐同一相册的其余几张。消息流水线每见到一条相册里的图就
 * 写入（非私聊，按 chatId 核对归属，每组至多 MEDIA_GROUP_ITEMS_MAX 张）；容量
 * MEDIA_GROUP_CACHE_MAX 组，满额淘汰最久未写入的一组，不随群 teardown 清理（只存文件
 * 标识，被 teardown 的群也发不出 `/h_image add`）。不跨线程、不持久化；进程重启后为空，
 * 那时回复相册只收得到被回复的那一张。
 */
export const mediaGroupImages: LruCache<string, MediaGroupImages> =
  new LruCache<string, MediaGroupImages>(MEDIA_GROUP_CACHE_MAX);
