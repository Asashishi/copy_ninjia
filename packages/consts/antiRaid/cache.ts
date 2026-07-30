/** Anti-Raid 的管理员、关联频道与评论关联缓存边界。 */

/**
 * 非匿名管理员邀请豁免表的过期时长。管理员任免及匿名模式切换会实时增删；
 * 匿名管理员仍有管理权限，但因操作者身份不可可靠归因，故意不进入此表。
 * 这个 TTL 只是兜底（比如错过更新的极端情况）。
 */
export const ADMIN_CACHE_TTL_MS: number = 60 * 60 * 1000;
/** “本群是否有关联频道”缓存的过期时长。关联/解绑频道是极罕见的管理操作。 */
export const LINKED_CHANNEL_TTL_MS: number = 60 * 60 * 1000;
/** 管理员邀请豁免表/关联频道缓存最多保留的群数；过期条目还会被周期清理。 */
export const ANTI_RAID_CHAT_CACHE_MAX: number = 500;
/** 清理已过期管理员邀请豁免表与关联频道缓存的周期。 */
export const ANTI_RAID_CACHE_SWEEP_INTERVAL_MS: number = 5 * 60 * 1000;
/**
 * “评论区留言 → 自动拉群”两个事件的关联窗口。实际间隔是毫秒级，取分钟级
 * 给限流和网络抖动留出余量。
 */
export const COMMENT_JOIN_CORRELATE_MS: number = 2 * 60 * 1000;
/** 最近评论关联缓存的全局条目硬顶；满载时优先清过期，再淘汰最早到期项。 */
export const RECENT_COMMENT_CACHE_MAX: number = 5_000;
/**
 * 冷缓存评论区确认最多同时占用的成员键数；同一成员只保留一个可更新 owner，
 * 满载时拒绝新 owner 并保持普通待验证语义，避免被淘汰回调仍挂在 Promise 上。
 */
export const THREAD_COMMENT_CONFIRMATION_MAX: number = 5_000;
/**
 * 关联频道 getChat owner 的结算上限；只限制本地等待，底层请求迟到也不得再写缓存。
 */
export const LINKED_CHANNEL_FETCH_TIMEOUT_MS: number = 15_000;
