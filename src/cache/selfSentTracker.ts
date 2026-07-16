/** 机器人自发消息回环识别（src/infra/selfSentTracker.ts）的内存状态。 */

/** 登记中的「机器人自己刚发出的消息」，键见 selfSentTracker.ts 的 key()，TTL 到期自动清理。 */
export const sentMessages: Map<string, ReturnType<typeof setTimeout>> = new Map();
