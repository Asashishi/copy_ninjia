/**
 * 机器人自发消息回环识别（packages/infra/selfSentTracker.ts）的内存状态。
 *
 * perThread：主线程、AI 闲聊 Worker、Anti-Raid Worker 都会经 infra/telegram 发消息，
 * 各自在本线程登记自己刚发出的那条，互不共享也不需要共享——判回环只看本线程发过什么。
 */

/** 登记中的「机器人自己刚发出的消息」，键见 selfSentTracker.ts 的 key()，TTL 到期自动清理。 */
export const sentMessages: Map<string, ReturnType<typeof setTimeout>> = new Map();
