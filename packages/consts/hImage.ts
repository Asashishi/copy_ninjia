/** 相册缓存最多保留的相册数，属 infra/mediaGroups.ts；满额时淘汰最久未写入的相册。 */
export const MEDIA_GROUP_CACHE_MAX: number = 256;

/** 一个相册最多记录的图片数，属 infra/mediaGroups.ts；等于 Telegram 相册的消息上限。 */
export const MEDIA_GROUP_ITEMS_MAX: number = 10;

/**
 * 一次 `/h_image add` 的总预算，属 commands/hImage/add.ts。超出后剩下的图记为失败，
 * 避免批量收图长时间占着延迟命令执行器的槽位。
 */
export const H_IMAGE_ADD_TASK_BUDGET_MS: number = 120_000;

/** `/h_image add` 取文件路径（getFile）的超时，属 commands/hImage/add.ts；与下载分开计时。 */
export const H_IMAGE_ADD_METADATA_TIMEOUT_MS: number = 10_000;

/** `/h_image add` 下载一张图的超时，属 commands/hImage/add.ts。 */
export const H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS: number = 25_000;

/** `/h_image` 收图子命令的参数，属 commands/hImage.ts；大小写敏感，前后空白已去掉。 */
export const H_IMAGE_ADD_ARGUMENT: string = "add";

/**
 * `/h_image` 全局滑动窗口限流的次数上限，属 commands/hImage.ts：每
 * H_IMAGE_RATE_LIMIT_WINDOW_MS（1 秒）最多受理 5 次，抽图、收图与用法提示共用同一份
 * 配额，不分群、不分用户合并计数。超额直接静默丢弃而非排队，也不发提示——限流时再回
 * 一条消息等于没限。队列见 cache/main/hImage.ts，判定见 libs/slidingWindowRateLimit.ts。
 */
export const H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 5;

/** `/h_image` 全局滑动限频窗口时长，属 commands/hImage.ts。 */
export const H_IMAGE_RATE_LIMIT_WINDOW_MS: number = 1_000;
