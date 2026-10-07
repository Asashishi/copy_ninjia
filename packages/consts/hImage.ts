/** 相册缓存最多保留的相册数，属 cache/main/mediaGroups.ts；满额时淘汰最久未写入的相册。 */
export const MEDIA_GROUP_CACHE_MAX: number = 256;

/** 一个相册最多记录的图片数，属 infra/mediaGroups.ts；等于 Telegram 相册的消息上限。 */
export const MEDIA_GROUP_ITEMS_MAX: number = 10;

/**
 * 一次 `/h_image add` 的总预算，属 commands/hImage/add.ts。超出后剩下的图记为失败。
 */
export const H_IMAGE_ADD_TASK_BUDGET_MS: number = 120_000;

/**
 * `/h_image add` 每页同时下载的张数上限，属 commands/hImage/add.ts。候选按这个数分页：
 * 一页内的 getFile、下载与尺寸检查同时进行，全部结算并逐张写盘后才开始下一页，
 * 因此内存里至多同时有这么多张图。
 */
export const H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE: number = 5;

/** `/h_image add` 取文件路径（getFile）的超时，属 commands/hImage/add.ts；与下载分开计时。 */
export const H_IMAGE_ADD_METADATA_TIMEOUT_MS: number = 10_000;

/** `/h_image add` 下载一张图的超时，属 commands/hImage/add.ts。 */
export const H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS: number = 25_000;

/** `/h_image` 收图子命令的参数，属 commands/hImage.ts；比较前已去掉前后空白并转为小写。 */
export const H_IMAGE_ADD_ARGUMENT: string = "add";

/**
 * `/h_image` 全局滑动窗口限流的次数上限，属 commands/hImage.ts：每个
 * H_IMAGE_RATE_LIMIT_WINDOW_MS 窗口内最多受理的次数，抽图、收图与用法提示共用同一份
 * 配额，不分群、不分用户合并计数。超额静默丢弃，不排队也不发提示。
 * 队列见 cache/main/hImage.ts，判定见 libs/slidingWindowRateLimit.ts。
 */
export const H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 5;

/** `/h_image` 全局滑动限频窗口时长，属 commands/hImage.ts。 */
export const H_IMAGE_RATE_LIMIT_WINDOW_MS: number = 1_000;
