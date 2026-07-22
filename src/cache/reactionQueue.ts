import type { LinkedQueue } from "../libs/linkedQueue";
import type { ReactionTask } from "../types/reactionQueue";

/**
 * 反应同步队列（src/copy/reactionQueue.ts）的内存状态。
 *
 * pendingTasks 里始终是某条消息「最新」想要的反应状态（键为 chatId:messageId），
 * chatQueues 里各 chat 的队列只记录本群内各消息首次入队的先后顺序，
 * consumingChats 标记哪些 chat 的消费循环正在运行。
 */

export const pendingTasks: Map<string, ReactionTask> = new Map();
export const chatQueues: Map<number, LinkedQueue<string>> = new Map();
export const consumingChats: Set<number> = new Set();

/** 同 key 的 update settlement；新状态落地会一并结算被覆盖的旧状态。 */
export const pendingReactionWaiters: Map<string, Set<() => void>> = new Map();
/** 生命周期等待整个反应队列归零的回调。 */
export const reactionDrainWaiters: Set<() => void> = new Set();
export const reactionQueueRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
