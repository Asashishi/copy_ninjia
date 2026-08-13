/** 非本地贴纸目录媒体描述（packages/aiChat/ai/imageDescription.ts）的临时内存缓存。 */

import { LruCache } from "../../../libs/lruCache";
import { MEDIA_DESCRIPTION_CACHE_MAX } from "../../../consts/aiChat/media";

/**
 * 临时媒体描述缓存：按 file_unique_id 去重。同一份媒体无论被谁、在哪个聊天、
 * 重发多少次，Telegram 给的 file_id 都可能不同，但 file_unique_id 恒定——
 * 不用自己下载算 hash，Telegram 已经替我们算好了（file_unique_id 不能用于
 * 下载，所以下载仍要 file_id）。值存 Promise 而不是结果：同一份媒体短时间被
 * 刷屏时，第二条起直接挂在首条的在途解析上，连并发的重复下载/API 调用也
 * 合并掉。解析失败（resolve 为 null）就把条目摘掉，下次这份媒体重发时重试，
 * 不把一次偶发失败钉死成永久失败。淘汰：超 MEDIA_DESCRIPTION_CACHE_MAX 条
 * 淘汰最久未使用的一个（真 LRU——命中即续命，见 libs/lruCache.ts），热门
 * 媒体不会被刷屏之外的新条目挤掉；不再另设 TTL，容量本身足够小
 * （上限 * 一行短描述可忽略不计），没必要为「长期占内存」多开一层定时器。
 *
 * config/stickers.json 白名单包的描述不属于这份缓存：它们从
 * memory/stickers/ 恢复进 stickerCatalog 的常驻内存目录，只有线上贴纸包
 * 对账发现增删时才更新。消息记录会先查该目录，未命中才走这里；生成目录
 * 新条目时也绕过这里，避免本地条目占用 MEDIA_DESCRIPTION_CACHE_MAX 额度、
 * 挤掉真正需要缓存的临时媒体，或在目录对账删除后仍从临时缓存读到旧描述。
 */
export const transientDescriptionCache: LruCache<string, Promise<string | null>> = new LruCache(MEDIA_DESCRIPTION_CACHE_MAX);

/**
 * 一份在途描述的消费者取消状态。controller 只属于 AI Worker；每个带 signal 的
 * 调用按引用计数登记，最后一个可取消消费者离开且没有无信号消费者时才中止底层
 * 下载/供应商请求，避免同一 file_unique_id 的一个聊天取消后误杀另一个聊天。
 */
export interface TransientDescriptionAbortState {
  readonly controller: AbortController;
  /**
   * 本任务在 transientDescriptionCache 里占的键。中止时要按这个键连带摘除条目：
   * 中止后到底层请求回卷完之间，条目仍指向一份注定为 null 的 Promise，这段窗口里
   * 进来的新消费者会命中它并拿到与自身取消无关的 null。
   */
  readonly fileUniqueId: string;
  readonly consumers: Map<AbortSignal, number>;
  /**
   * 不带 signal、因而无法退出等待的消费者数。只增不减是有意的：它仅在 settled
   * 为 false 的窗口里被读，而这类消费者恰好一直等到 Promise 结算——结算时
   * settled 先置真，中止判定已经短路，计数是否归零不再影响任何决策。
   */
  uncancellableConsumers: number;
  settled: boolean;
}

/**
 * 在途描述 Promise 到取消状态的弱映射。由 imageDescription.ts 在创建 Promise 时
 * 填充、结算时删除；Worker 崩溃后随线程整体重建。容量由
 * transientDescriptionCache 的上限间接约束，弱键也不会阻止已淘汰 Promise 回收。
 * 无条目表示 Promise 已结算或不是当前实现创建的在途项，此时只读取其结果，绝不
 * 猜测并沿用旧 controller。
 */
export const transientDescriptionAbortStates: WeakMap<
  Promise<string | null>,
  TransientDescriptionAbortState
> = new WeakMap<Promise<string | null>, TransientDescriptionAbortState>();
