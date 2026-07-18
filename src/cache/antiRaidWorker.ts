import type { ChatAdminCache, JoinWindow, LinkedChannelCache } from "../types";
import type { VerificationState } from "../states/verification";
import type { LockdownState } from "../states/lockdown";

/**
 * 入群守卫流水线（src/workers/antiRaidWorker.ts）的内存状态。
 * 本模块只被 Worker 线程 import。均仅存于内存中，符合需求——验证状态、
 * 计数窗口和私密模式状态都不需要在重启后保留。
 */

/**
 * 一条验证状态机条目：纯状态（src/states/verification.ts）+ 解释器
 * 持有的活动计时器（pending 是验证超时，exempt/kicked 是去重窗口到期）。
 */
export interface VerificationEntry {
  state: VerificationState;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 一条私密模式状态机条目：纯状态（src/states/lockdown.ts）+ 解释器
 * 持有的恢复计时器（由 scheduleRestore 副作用设置，applying 刚占位时短暂为空）。
 */
export interface LockdownEntry {
  state: LockdownState;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// 以 "chatId:userId" 为键，这样同一个人在不同群里会被独立追踪。
export const verificationEntries: Map<string, VerificationEntry> = new Map();
/** 当前主线程分配的 Worker 代际；0 表示尚未收到 adoptVerifications。 */
export const verificationGeneration: { current: number } = { current: 0 };
/** 每个 key 在当前代际内最后使用的 revision；retiredAt 到期后由统一 sweeper 清理。 */
export const verificationRevisions: Map<string, { revision: number; retiredAt?: number }> = new Map();
export const joinWindows: Map<number, JoinWindow> = new Map();
export const lockdownEntries: Map<number, LockdownEntry> = new Map();
/**
 * 私密模式加锁/恢复/纠偏三类 setChatPermissions 调用按 chatId 串行化的链，
 * 保证同一个群的这些调用严格按 dispatch 顺序一个个落地在 Telegram 上，不会
 * 因为各自独立的网络往返乱序，让后发起的调用抢在先发起的调用之前完成，见
 * workers/antiRaid/lockdownRuntime.ts 的 runLockdownApiCall。
 */
export const lockdownApiChains: Map<number, Promise<void>> = new Map();
/** 按需拉取的各群管理员表，供「管理员拉人免验证」同步判定；丢了只是缓存，重新拉即可。 */
export const chatAdmins: Map<number, ChatAdminCache> = new Map();
/** 按需拉取的各群「是否有关联频道」，评论区判定的按群开关；丢了只是缓存，重新拉即可。 */
export const linkedChannels: Map<number, LinkedChannelCache> = new Map();
/**
 * 最近发过评论区留言/线程回复、但当时本群没有 TA 的验证状态记录的用户
 * （"chatId:userId" → 该消息的 messageId 及是否直接回复频道帖）。关联窗口
 * 由来见 COMMENT_JOIN_CORRELATE_MS；入群时由 Worker 消费成 join 事件的
 * recentComment 字段，处置逻辑见 states/verification.ts。
 */
export const recentChannelComments: Map<string, { messageId: number; repliesToChannelPost: boolean; observedAt: number }> = new Map();
/** 进行中的全量管理员拉取，按 chatId 去重：短时间内连拉多人只发一次请求，结果共享。 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();
/** 进行中的关联频道信息拉取，按 chatId 去重（同 adminFetches 的思路）。 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();
/**
 * 一次全量拉取（antiRaid/adminCache.ts 的 fetchAdminIds）进行中期间到达的
 * 管理员增量变化：chatId -> (userId -> isAdmin)，落地时（无论此刻有没有
 * 已有缓存条目）都会记一份在这里，全量拉取的结果落地后立即在新快照基础上
 * 重放、再清空，见 fetchAdminIds 与 applyAdminChange。避免"迟到的全量快照
 * resolve 时直接整份覆盖缓存"把拉取在途期间已经发生的、更新的增量变化
 * 悄悄冲掉——尤其是缓存此刻还完全没有条目（第一次拉取还没落地）的情形：
 * 不缓冲的话 applyAdminChange 会因为 !cached 直接静默丢弃这次变化，且不像
 * 有缓存条目时那样能事后从「原地增删」里看出丢了什么，只能等到
 * ADMIN_CACHE_TTL_MS（1 小时）后下一次全量刷新才纠正。
 */
export const pendingAdminChangesDuringFetch: Map<number, Map<number, boolean>> = new Map();
