import type { LinkedQueue } from "../libs/linkedQueue";
import type { ReactionTask } from "../types/reactionQueue";

/**
 * 反应同步队列（packages/copy/reactionQueue.ts）的内存状态。
 *
 * pendingTasks 里始终是某条消息「最新」想要的反应状态（键为 chatId:messageId），
 * chatQueues 里各 chat 的队列只记录本群内各消息首次入队的先后顺序，
 * consumingChats 标记哪些 chat 的消费循环正在运行。
 */

/** 以 "chatId:messageId" 为键的当前生效反应任务；enqueueReaction 写入或
 *  原地覆盖为更新版本，任务结算、超出单群硬顶被丢弃或停机 abort 时删除。 */
export const pendingTasks: Map<string, ReactionTask> = new Map();
/** 每群待消费消息 key 的有界 FIFO；任务完成或停机时清空。 */
export const chatQueues: Map<number, LinkedQueue<string>> = new Map();
/** 当前已有消费循环的群；循环 finally 或停机时删除。 */
export const consumingChats: Set<number> = new Set();

/** 同 key 的 update settlement；新状态落地会一并结算被覆盖的旧状态。 */
export const pendingReactionWaiters: Map<string, Set<() => void>> = new Map();
/** 生命周期等待整个反应队列归零的回调。 */
export const reactionDrainWaiters: Set<() => void> = new Set();
/** 队列接入闸与统一 abort owner；init 重建 controller，quiesce/abort 时关闭。 */
export const reactionQueueRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
