/** 入群验证与反刷群私密模式（src/workers/antiRaidWorker.ts）的调参常量。 */

// —— 入群验证 ——

/** 验证按钮上显示的文案，新成员必须在 VERIFICATION_TIMEOUT_MS 内点击，否则会被踢出。 */
export const VERIFICATION_BUTTON_TEXT: string = "我是新人，别搞！";
/** 验证按钮 callback_data 的前缀，后面拼上待验证成员的 userId。 */
export const VERIFY_CALLBACK_PREFIX: string = "verify:";
export const VERIFICATION_TIMEOUT_MS: number = 90 * 1000;
/**
 * 私密模式下直接踢人的占位记录存活时长：只是给 chat_member 更新和
 * new_chat_members 服务消息（针对同一次入群各自触发）留出去重窗口，
 * 不是真的验证超时，所以远比 VERIFICATION_TIMEOUT_MS 短。
 */
export const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;
/**
 * 私密模式秒踢占位遇到新 join 事件时，用来判断"这是同一次物理入群的另一条
 * 投递（chat_member 更新 + 服务消息，间隔实测毫秒级）"还是"TA 真的重新
 * 申请了入群"（kickChatMember 只踢不封，本就能立刻重进）的分界线。
 * 远小于 LOCKDOWN_KICK_DEDUPE_MS——那个是占位整体存活时长，这个只区分
 * 同一次入群的两条腿，见 states/verification.ts 的 handleJoin。
 */
export const KICKED_REJOIN_GRACE_MS: number = 5 * 1000;
/** 验证通过后的欢迎消息在被自动清理前保持可见的时长。 */
export const WELCOME_AUTO_DELETE_MS: number = 30 * 1000;
/**
 * 管理员表缓存（管理员拉人免验证的同步判定依据）的过期时长。管理员任免
 * 事件会实时增删缓存，这个 TTL 只是兜底（比如错过更新的极端情况），
 * 所以可以放心地长。
 */
export const ADMIN_CACHE_TTL_MS: number = 60 * 60 * 1000;
/**
 * 「本群是否有关联频道」缓存的过期时长。关联/解绑频道是极罕见的管理操作，
 * 缓存过期只是兜底，可以放心地长。
 */
export const LINKED_CHANNEL_TTL_MS: number = 60 * 60 * 1000;
/** 管理员表/关联频道缓存最多保留的群数；过期条目还会被周期清理。 */
export const ANTI_RAID_CHAT_CACHE_MAX: number = 500;
/** 清理已过期管理员表与关联频道缓存的周期。 */
export const ANTI_RAID_CACHE_SWEEP_INTERVAL_MS: number = 5 * 60 * 1000;
/**
 * 「评论区留言 → 自动拉群」两个事件的关联窗口：评论消息和 chat_member
 * 入群更新由同一个动作触发、到达顺序不保证，评论先到时暂存这么久等
 * 入群更新来消费。实际间隔是毫秒级，取分钟级只是给限流/网络抖动留余量。
 */
export const COMMENT_JOIN_CORRELATE_MS: number = 2 * 60 * 1000;

// —— 反刷群私密模式 ——

/** 滑动计数窗口时长：最近这么长时间内的入群数超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 60 * 1000;
/**
 * 滑动窗口内触发私密模式的入群人数上限，超过（第 46 人起）才触发，见
 * workers/antiRaidWorker.ts 的 recordJoin（`length > JOIN_THRESHOLD`）。
 * 60 秒 45 人（0.75 人/秒）：正常群极少一分钟涌入这么多新人，而真实刷群
 * 通常远快于此——旧值 150 人/15 秒要求持续 10 人/秒，实际刷群到不了，
 * 形同虚设。
 */
export const JOIN_THRESHOLD: number = 45;
/** 私密模式（禁止普通成员拉人）持续时长。 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
