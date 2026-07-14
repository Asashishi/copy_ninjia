import type { ChatAdminCache, JoinWindow, LinkedChannelCache, Lockdown, PendingVerification } from "../types";

/**
 * 入群守卫流水线（src/workers/antiRaidWorker.ts）的内存状态。
 * 本模块只被 Worker 线程 import。均仅存于内存中，符合需求——待验证记录、
 * 计数窗口和私密模式状态都不需要在重启后保留。
 */

// 以 "chatId:userId" 为键，这样同一个人在不同群里会被独立追踪。
export const pendingVerifications: Map<string, PendingVerification> = new Map();
export const joinWindows: Map<number, JoinWindow> = new Map();
export const activeLockdowns: Map<number, Lockdown> = new Map();
/** 按需拉取的各群管理员表，供「管理员拉人免验证」同步判定；丢了只是缓存，重新拉即可。 */
export const chatAdmins: Map<number, ChatAdminCache> = new Map();
/** 按需拉取的各群「是否有关联频道」，评论区判定的按群开关；丢了只是缓存，重新拉即可。 */
export const linkedChannels: Map<number, LinkedChannelCache> = new Map();
/**
 * 最近发过评论区留言/线程回复、但当时本群没有 TA 的待验证记录的用户
 * （"chatId:userId" → 该消息的 messageId 及是否直接回复频道帖）。关联窗口
 * 由来见 COMMENT_JOIN_CORRELATE_MS；消费逻辑见 ensureVerificationStarted：
 * 直接回复频道帖的按豁免处理，楼中楼回复的把验证提醒追发到 TA 的回复下。
 */
export const recentChannelComments: Map<string, { messageId: number; repliesToChannelPost: boolean; cleanup: ReturnType<typeof setTimeout> }> = new Map();
/** 进行中的全量管理员拉取，按 chatId 去重：短时间内连拉多人只发一次请求，结果共享。 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();
/** 进行中的关联频道信息拉取，按 chatId 去重（同 adminFetches 的思路）。 */
export const linkedChannelFetches: Map<number, Promise<void>> = new Map();
