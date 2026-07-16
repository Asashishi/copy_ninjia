/** 媒体描述（src/ai/imageDescription.ts）的内存缓存，图片/贴纸/GIF 共用。 */

/**
 * 媒体描述缓存：按 file_unique_id 去重。同一份媒体无论被谁、在哪个聊天、
 * 重发多少次，Telegram 给的 file_id 都可能不同，但 file_unique_id 恒定——
 * 不用自己下载算 hash，Telegram 已经替我们算好了（file_unique_id 不能用于
 * 下载，所以下载仍要 file_id）。值存 Promise 而不是结果：同一份媒体短时间被
 * 刷屏时，第二条起直接挂在首条的在途解析上，连并发的重复下载/API 调用也
 * 合并掉。解析失败（resolve 为 null）就把条目摘掉，下次这份媒体重发时重试，
 * 不把一次偶发失败钉死成永久失败。淘汰双保险：超 MEDIA_DESCRIPTION_CACHE_MAX
 * 条按插入序淘汰最旧的，超 MEDIA_DESCRIPTION_CACHE_TTL_MS 则不论条数主动
 * 清掉（防低流量长期运行下条目数摸不到上限却一直占内存），见
 * ai/imageDescription.ts 的 describeMedia。
 */
export const descriptionCache: Map<string, Promise<string | null>> = new Map();
