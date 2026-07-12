/** 反应同步队列（src/copy/reactionQueue.ts）的调参常量。 */

/** 单个任务遇到 429 限流时的最大重试次数，防止极端限流下队列被一个任务卡死。 */
export const MAX_ATTEMPTS: number = 3;
