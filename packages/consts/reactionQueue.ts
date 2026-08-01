/** 反应同步队列（packages/copy/reactionQueue.ts）的调参常量。 */

/** 单群最多积压的不同消息反应任务；API 长尾时防止队列无限持有更新。 */
export const MAX_PENDING_TASKS_PER_CHAT: number = 150;
