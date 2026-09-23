/** 刷屏禁言（packages/antiRaid/floodControl.ts）的调参常量。 */

/**
 * 统计单人发言频率的滑动窗口时长。窗口边界语义由
 * libs/slidingWindowRateLimit.ts 统一定义，这里只给长度。
 */
export const FLOOD_WINDOW_MS: number = 60_000;

/**
 * 一个窗口内达到这个条数即判定为刷屏（达到即触发，不要求超过）。
 *
 * 与反刷群入群阈值（consts/antiRaid/lockdown.ts）是两件事：那条数的是「多少人
 * 进来」，这条数的是「一个人说了多少」，两者互不替代。
 */
export const FLOOD_MESSAGE_LIMIT: number = 15;

/**
 * 一次刷屏禁言的时长，到点由 Telegram 自动恢复发言权限，机器人不排恢复计时器
 * ——恢复不靠本进程活着，重启也不会把人永久按住。
 *
 * 不能低于 30 秒：Bot API 把「距现在不足 30 秒」的 until_date 当成永久限制。
 */
export const FLOOD_MUTE_DURATION_MS: number = 3 * 60_000;

/**
 * 禁言请求从「算好 until_date」到「真的发出去」的容忍上限；超过就放弃这次禁言
 * （抑制位回滚，下一个满窗口重来）。
 *
 * until_date 是**入队前**算好的绝对时刻。restrict 请求不走消息 throttler，
 * 但若 Telegram 返回 429，它仍会在 restrict 类独立车道按 retry_after 等待；
 * 排到 until_date 距当下不足 30 秒时，Bot API 把它当成**永久限制**，而本模块
 * 明确不排恢复计时器、也不落盘，那个人就被无声地永久禁言了，只能人工解除。
 *
 * 取值必须保证真正发出去的那一刻 until_date 离当下明显大于 30 秒的永久限制
 * 红线，不得直接取 FLOOD_MUTE_DURATION_MS 的原值。
 */
export const FLOOD_MUTE_DISPATCH_TIMEOUT_MS: number = FLOOD_MUTE_DURATION_MS - 60_000;

/**
 * 禁言公告从「禁言已落地」到「真的发出去」的容忍上限；超过就不发这条公告，
 * 但禁言本身仍然照做——被按住的人到点自行恢复，不依赖这条公告。
 *
 * 公告与欢迎语、验证提醒等聊天消息共用 grammY 的同群发送桶；超时的公告被丢弃
 * 时，也给验证提醒等功能性消息腾出了发送位。kick/restrict 走独立 429 域，不受
 * 这个消息桶影响。
 */
export const FLOOD_NOTICE_DISPATCH_TIMEOUT_MS: number = 30_000;

/**
 * 发言窗口表（cache/workers/antiRaid/flood.ts）的条目硬顶，键是「群 + 成员」。
 *
 * 越界按 LRU 淘汰最早写入的那条，被淘汰的人下次发言从空窗口重新开始计数。
 * 单条队列长度受 FLOOD_MESSAGE_LIMIT 封顶（达到即清空），因此整表占用是
 * 「条目数 × 阈值」这个常数上界，不需要额外的全局到期清扫计时器。
 */
export const FLOOD_WINDOW_MAX_MEMBERS: number = 25_000;
