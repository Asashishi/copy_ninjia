/**
 * 机器人自发消息回环识别（packages/infra/selfSentTracker.ts）的内存状态。
 *
 * perThread：主线程、AI 闲聊 Worker、Anti-Raid Worker 都会经 infra/telegram 发消息，
 * 各自在本线程登记自己刚发出的那条，互不共享也不需要共享——判回环只看本线程发过什么。
 */

import type { SelfSentWaiter } from "../../types/telegram";

/** 登记中的「机器人自己刚发出的消息」，键见 selfSentTracker.ts 的 key()，TTL 到期自动清理。 */
export const sentMessages: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * 尚在等待 Worker `sent` 回执的频道 update。键与 sentMessages 相同，同一频道帖
 * 的原帖与自动转发可各有一个 waiter；标记到达或超时即删除，因此容量只等于
 * 最近一个 rendezvous 窗口内尚未判定的频道 update 数，线程重建后清空。
 */
export const pendingSelfSentWaiters: Map<string, Set<SelfSentWaiter>> = new Map();
