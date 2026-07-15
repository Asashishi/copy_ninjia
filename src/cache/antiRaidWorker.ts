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
export const joinWindows: Map<number, JoinWindow> = new Map();
export const lockdownEntries: Map<number, LockdownEntry> = new Map();
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
export const recentChannelComments: Map<string, { messageId: number; repliesToChannelPost: boolean; cleanup: ReturnType<typeof setTimeout> }> = new Map();
/** 进行中的全量管理员拉取，按 chatId 去重：短时间内连拉多人只发一次请求，结果共享。 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();
/** 进行中的关联频道信息拉取，按 chatId 去重（同 adminFetches 的思路）。 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();
