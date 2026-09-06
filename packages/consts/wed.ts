/** /wed 主线程群交互缓存容量；命中刷新顺序，满额淘汰最久未使用的群。 */
export const WED_CHAT_CACHE_MAX_ENTRIES: number = 1_024;
/** /wed 每群已发言成员集合的硬上限；满额保留已有 ID，退群腾位后才接纳新 ID。 */
export const WED_MEMBER_LIMIT: number = 150_000;
/** /wed 成员复核跨群共用的请求起始间隔；全局每秒最多检查 5 个 ID，不补发积压。 */
export const WED_MEMBER_REVIEW_INTERVAL_MS: number = 200;
/** /wed 每群并存的发起人会话上限，每位用户只保留一张结果。 */
export const WED_SESSION_LIMIT: number = 512;
/** /wed 主线程交互的全局并发上限，出站等待仍占用原执行槽。 */
export const WED_MAX_CONCURRENT: number = 32;
/** /wed 尚未开始的交互全局上限；队列只保留交互上下文，不预取头像。 */
export const WED_MAX_PENDING: number = 512;
/** /wed 每轮最多核实的候选用户数，限制不可用头像造成的请求量。 */
export const WED_DRAW_ATTEMPTS: number = 8;
/** /wed 按钮回调所属领域前缀。 */
export const WED_CALLBACK_PREFIX: string = "wed:";
/** /wed 候选查询、头像下载与图片发送/编辑的请求预算；删除和提示复用统一出站生命周期。 */
export const WED_OPERATION_TIMEOUT_MS: number = 30_000;
/** /wed 昵称展示长度上限，保证双昵称图注不超过 Telegram 限额。 */
export const WED_NAME_MAX_CHARS: number = 128;
/** /wed 单排按钮文字，确认后仍允许更换。 */
export const WED_BUTTON_TEXTS: Readonly<{
  remove: string;
  marry: string;
  confirmed: string;
  change: string;
}> = { remove: "移除", marry: "娶老婆!", confirmed: "已确认♡", change: "换一只" };
/** /wed 校验和交互反馈；群内文字提示经统一 30 秒清理边界发送。 */
export const WED_TEXTS: Readonly<{
  groupOnly: string;
  usage: string;
  busy: string;
  full: string;
  queueFull: string;
  empty: string;
  unavailable: string;
  expired: string;
  updated: string;
  ownerOnly: string;
  failed: string;
  confirmed: string;
}> = {
  groupOnly: "频道怎么娶老婆呀，用个人身份在群里发送 /wed 啦。",
  usage: "连抽老婆都不会呀，杂鱼♡ 直接发送 /wed 就好，后面不用加东西啦。",
  busy: "本天才正在帮你抽呢，急着娶老婆也要乖乖等一下，杂鱼♡",
  full: "本群的抽取会话已经塞满啦，先移除不需要的结果再来，贪心的杂鱼♡",
  queueFull: "抽老婆的队伍都排满啦，杂鱼乖乖等会儿再来♡",
  empty: "连其他可抽的群友都没有，杂鱼也太心急啦♡ 等大家发言后再来。",
  unavailable: "这次没找到头像可用的群友哦♡ 运气真差呢，杂鱼稍后再抽啦。",
  expired: "这条抽取早就结束啦，还戳呀，笨蛋♡ 重新发送 /wed 再来。",
  updated: "老婆都换过啦，还惦记旧按钮呢，杂鱼♡ 用这条消息上的最新按钮啦。",
  ownerOnly: "别乱碰别人的老婆啦，杂鱼♡ 只有发起人能操作，想要就自己发 /wed。",
  failed: "这次操作没完成啦，杂鱼先别急，稍后再试一次♡",
  confirmed: "好啦，就认定这位群友老婆了♡ 杂鱼可要好好珍惜哦。",
};
