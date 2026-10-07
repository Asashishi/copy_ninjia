/** 刷屏禁言（packages/workers/antiRaid/floodControl.ts）的调参常量。 */

/**
 * 统计单人发言频率的滑动窗口时长。窗口边界语义由
 * libs/slidingWindowRateLimit.ts 统一定义，这里只给长度。
 */
export const FLOOD_WINDOW_MS: number = 60_000;

/**
 * 一个窗口内达到这个条数即判定为刷屏（达到即触发，不要求超过）。
 *
 * 与反刷群入群阈值（consts/antiRaid/lockdown.ts 的 ANTI_RAID_PER_MINUTE_LIMIT）不同：
 * 本值计的是单人发言条数。
 */
export const FLOOD_MESSAGE_LIMIT: number = 15;

/**
 * 一次刷屏禁言的时长，到点由 Telegram 自动恢复发言权限，机器人不排恢复计时器。
 *
 * 须高于 Bot API 把 until_date 当成永久限制的官方下限。
 */
export const FLOOD_MUTE_DURATION_MS: number = 3 * 60_000;

/**
 * 禁言请求从「算好 until_date」到「真的发出去」的容忍上限；超过就放弃这次禁言
 * （抑制位回滚，下一个满窗口重来）。
 *
 * until_date 是**入队前**算好的绝对时刻。restrict 请求不进发送调度器，
 * 但 Telegram 返回 429 时仍会在 restrict 类独立车道按 retry_after 等待；
 * 本模块不排恢复计时器、也不落盘，until_date 距发出时刻不足官方下限时
 * 会被当成永久限制。
 *
 * 取值保证真正发出去的那一刻 until_date 离当下明显大于该下限，
 * 不直接取 FLOOD_MUTE_DURATION_MS 的原值。
 */
export const FLOOD_MUTE_DISPATCH_TIMEOUT_MS: number = FLOOD_MUTE_DURATION_MS - 60_000;

/**
 * 禁言公告从「禁言已落地」到「真的发出去」的容忍上限；超过就不发这条公告，
 * 但禁言本身仍然照做——被按住的人到点自行恢复，不依赖这条公告。
 *
 * 公告与欢迎语、验证提醒等聊天消息排在发送调度器里本群的同一条发送车道；
 * 超时的公告被丢弃。kick/restrict 走独立 429 域，不在这条发送车道上。
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
