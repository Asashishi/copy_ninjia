import type { ChatAdminCache, JoinWindow, Lockdown, PendingVerification } from "../types";

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
/**
 * 最近发过评论区留言/线程回复、但当时本群没有 TA 的待验证记录的用户
 * （"chatId:userId" → 该消息的 messageId 及是否直接回复频道帖）。用于
 * 「评论先到、入群更新后到」的乱序补偿：评论触发的自动拉群，其
 * chat_member 更新可能晚于评论消息到达，入群时从这里消费——直接回复
 * 频道帖的按豁免处理，楼中楼回复的把验证提醒追发到 TA 的回复下。
 * 条目在 COMMENT_JOIN_CORRELATE_MS 后自动清理。
 */
export const recentChannelComments: Map<string, { messageId: number; repliesToChannelPost: boolean; cleanup: ReturnType<typeof setTimeout> }> = new Map();
