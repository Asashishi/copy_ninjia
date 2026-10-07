/** owner: workers/aiChat。非本地贴纸目录媒体描述的临时内存缓存。 */

import type { SharedResult } from "../../../libs/sharedResult";
import { LruCache } from "../../../libs/lruCache";
import { MEDIA_DESCRIPTION_CACHE_MAX } from "../../../consts/aiChat/media";

/**
 * 临时媒体描述缓存，按 file_unique_id 去重：同一份媒体的 file_id 可能不同，file_unique_id 不变
 * （file_unique_id 不能用于下载，下载仍使用 file_id）。值存 Promise：同一份媒体短时间重复出现时，
 * 后续消息挂在首条的在途解析上，合并并发的下载与 API 调用。解析失败（resolve 为 null）时摘掉条目，
 * 下次该媒体重发时重试。淘汰：超 MEDIA_DESCRIPTION_CACHE_MAX 条时淘汰最久未使用的一个
 * （命中即刷新使用顺序，见 libs/lruCache.ts）；不设 TTL。Worker 崩溃后从空缓存重建。
 *
 * config/dynamic/stickers.json 白名单包的描述不属于这份缓存：它们从 memory/stickers/ 恢复进
 * stickerCatalog 的常驻内存目录，只在线上贴纸包对账发现增删时更新。消息记录先查该目录，
 * 未命中才走这里；生成目录新条目时也不经过这里。
 */
export const transientDescriptionCache: LruCache<string, Promise<string | null>> = new LruCache(MEDIA_DESCRIPTION_CACHE_MAX);

/**
 * 在途描述的可取消订阅。imageDescription.ts 建立任务时填充、结算时删除；任务数由
 * 媒体执行与等待额度共同约束，LRU 淘汰不释放仍有消费者的任务。取消立即摘除订阅，
 * 最后一个消费者离开时由任务 owner 中止底层请求。Worker 崩溃后随 isolate 清空。
 * 无条目表示任务已结算，此时直接读取缓存 Promise。
 */
export const transientDescriptionTasks: WeakMap<Promise<string | null>, SharedResult<string | null>> =
  new WeakMap<Promise<string | null>, SharedResult<string | null>>();
