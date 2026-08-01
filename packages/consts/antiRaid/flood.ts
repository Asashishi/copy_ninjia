/** 刷屏禁言（packages/antiRaid/floodControl.ts）的调参常量。 */

/**
 * 统计单人发言频率的滑动窗口时长。窗口边界语义由
 * libs/slidingWindowRateLimit.ts 统一定义，这里只给长度。
 */
export const FLOOD_WINDOW_MS: number = 60_000;

/**
 * 一个窗口内达到这个条数即判定为刷屏。取「达到」而不是「超过」：阈值本身
 * 就是一分钟 15 条，正常聊天（含连发短句、接龙）通常够不到，而真刷屏的号一秒
 * 就能顶上去，差一条的区分没有意义。
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
 * 禁言请求从「算好 until_date」到「真的发出去」的容忍上限；超过就放弃这次禁言。
 *
 * until_date 是**入队前**算好的绝对时刻，而请求还要过 joinVerificationApi 的
 * 每群限流桶（20 req/min、maxConcurrent 1）。一场突袭里，验证欢迎语、提醒、
 * 删消息、踢人、广告处置全挤在同一个群的那条队列上，禁言请求可能排上好几分钟；
 * 排到 until_date 距当下不足 30 秒时，Bot API 把它当成**永久限制**，而本模块
 * 明确不排恢复计时器、也不落盘，那个人就被无声地永久禁言了，只能人工解除，
 * 群里那条公告还写着「禁言 3 分钟」。
 *
 * 取 FLOOD_MUTE_DURATION_MS - 60 秒：留出一分钟余量，保证真发出去的那一刻
 * until_date 离当下至少还有一分钟，离那条 30 秒的红线足够远。超时的代价只是
 * 这次没禁成（抑制位回滚，下一个满窗口重来），远小于一次不可逆的永久禁言。
 */
export const FLOOD_MUTE_DISPATCH_TIMEOUT_MS: number = FLOOD_MUTE_DURATION_MS - 60_000;

/**
 * 禁言公告从「禁言已落地」到「真的发出去」的容忍上限；超过就不发这条公告。
 *
 * 与禁言请求不同，公告排太久不会造成不可逆后果，问题在**它占着谁的位置**：
 * 公告与入群验证的踢人、欢迎语、提醒共用 joinVerificationApi 的同一条按群限流
 * 队列（20 req/min、maxConcurrent 1）。协同突袭里几十个号各自越过阈值，每个都要
 * 花掉「禁言 + 公告」两个请求额，而队列是 FIFO：排在后面的验证 kickChatMember
 * 只能等前面的公告一个个发完——未验证的突袭号因此活过 VERIFICATION_TIMEOUT_MS，
 * 群里反倒多出几十条点名成员的机器人消息。**机器人自己的碎嘴不该把安全动作
 * 顶到窗口之后**。
 *
 * 超时的公告被丢掉时也就腾出了那个位置，因此这个值同时是「验证动作最多被公告
 * 挡多久」的上界。取 30 秒：正常群里队列很短，30 秒绰绰有余；真排到 30 秒之后，
 * 说明这个群此刻正被突袭，那时保持安静恰恰是对的。禁言本身仍然照做——被按住的
 * 人到点自行恢复，不依赖这条公告。
 */
export const FLOOD_NOTICE_DISPATCH_TIMEOUT_MS: number = 30_000;

/**
 * 发言窗口表（cache/workers/antiRaid/flood.ts）的条目硬顶，键是「群 + 成员」。
 *
 * 越界按 LRU 淘汰最早写入的那条，被淘汰的人下次发言从空窗口重新开始计数——
 * 代价只是极端情况下少判一次刷屏，换来这张表不随历史发言者无限增长。单条
 * 队列长度天然被 FLOOD_MESSAGE_LIMIT 封顶（达到即清空），因此整表占用是
 * 「条目数 × 阈值」这个常数上界，不必再养一个全局到期清扫计时器。
 */
export const FLOOD_WINDOW_MAX_MEMBERS: number = 25_000;
