import { logger } from "../logger";
import { GrammyError } from "grammy";
import { bot } from "../infra/telegram";
import { LinkedQueue } from "../libs/linkedQueue";
import { MAX_ATTEMPTS } from "../consts/reactionQueue";
import { chatQueues, consumingChats, pendingTasks } from "../cache/reactionQueue";
import type { CopyableReaction, ReactionTask } from "../types";

/**
 * 反应同步的可靠性保障层。经实测确认，复制反应的延迟大头在 Telegram 生成并
 * 投递 message_reaction 更新（日志里的 delivery），队列本身的耗时（queue）
 * 只是一次 HTTP 往返，因此这一层不为提速，只为三个保障：
 * 1. 同一条消息的多次反应变化（点了又取消、换了个表情）以 chatId:messageId
 *    为键合并，只保留最新状态，消除乱序写回过期反应的竞态。
 * 2. 429 限流按 retry_after 等待后重试，而不是直接丢弃。
 * 3. 队列按 chat 拆分：限流（及其 retry_after）基本是按 chat 生效的，一个群
 *    被限流只暂停该群自己的消费循环，不头部阻塞其他群的反应同步。
 *
 * 队列状态（pendingTasks / chatQueues / consumingChats）见 cache/reactionQueue.ts。
 */

/**
 * 把「将某条消息上的机器人反应设置为 reactions」这一任务入队（空数组表示
 * 清除反应）。同一条消息已有未消费任务时只覆盖其内容，不重复排队。
 * @param chatId 目标聊天 ID。
 * @param messageId 要回应的消息。
 * @param reactions 要应用的反应（最多 1 个——机器人无 Premium，一条消息只能设一个反应）。
 * @param updateId 产生本次调用的更新的 update_id（单调递增），用于新旧判断。
 * @param reactedAtUnix 目标点下反应的时刻（message_reaction 更新的 date 字段），用于延迟统计。
 */
export function enqueueReaction(chatId: number, messageId: number, reactions: CopyableReaction[], updateId: number, reactedAtUnix: number): void {
  const key: string = `${chatId}:${messageId}`;
  const existing: ReactionTask | undefined = pendingTasks.get(key);
  if (existing) {
    // reaction 更新是无约束并发处理的，入队顺序不保证等于真实顺序；date 只有
    // 秒级精度，这里用单调递增的 update_id 判断新旧，旧状态不许覆盖新状态。
    if (updateId < existing.updateId) {
      return;
    }
  } else {
    let order: LinkedQueue<string> | undefined = chatQueues.get(chatId);
    if (!order) {
      order = new LinkedQueue<string>();
      chatQueues.set(chatId, order);
    }
    order.push(key);
  }
  pendingTasks.set(key, { chatId, messageId, reactions, updateId, reactedAtUnix, enqueuedAtMs: Date.now() });
  if (!consumingChats.has(chatId)) {
    void consumeChatQueue(chatId);
  }
}

async function consumeChatQueue(chatId: number): Promise<void> {
  consumingChats.add(chatId);
  try {
    const order: LinkedQueue<string> | undefined = chatQueues.get(chatId);
    while (order && order.size > 0) {
      const key: string = order.shift()!;
      const task: ReactionTask | undefined = pendingTasks.get(key);
      pendingTasks.delete(key);
      if (task) {
        await applyReaction(key, task);
      }
    }
  } finally {
    consumingChats.delete(chatId);
    const order: LinkedQueue<string> | undefined = chatQueues.get(chatId);
    if (order && order.size === 0) {
      chatQueues.delete(chatId);
    }
  }
}

async function applyReaction(key: string, task: ReactionTask): Promise<void> {
  for (let attempt: number = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await bot.api.setMessageReaction(task.chatId, task.messageId, task.reactions);
      // 延迟拆解：delivery = 目标点反应到更新抵达机器人（Telegram 侧 + 轮询，
      // 我们控制不了），queue = 入队到调用完成（我们这边的耗时）。delivery 用
      // 本地时钟减 Telegram 服务器时间，轻微时钟偏差可能出现负数，夹到 0。
      const nowMs: number = Date.now();
      const deliveryMs: number = Math.max(0, task.enqueuedAtMs - task.reactedAtUnix * 1000);
      logger.log(
        `Reaction synced (chat ${task.chatId}, msg ${task.messageId}): ` +
        `delivery ${(deliveryMs / 1000).toFixed(1)}s, queue ${((nowMs - task.enqueuedAtMs) / 1000).toFixed(1)}s`
      );
      return;
    } catch (error: unknown) {
      if (error instanceof GrammyError && error.error_code === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfterSeconds: number = error.parameters.retry_after ?? 3;
        logger.warn(
          `setMessageReaction rate limited (chat ${task.chatId}, msg ${task.messageId}), ` +
          `waiting ${retryAfterSeconds}s before retry ${attempt + 1}/${MAX_ATTEMPTS}`
        );
        await new Promise<void>((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
        // 等待期间这条消息可能有了更新的反应状态（pendingTasks 里重新出现了
        // 同一个键）：放弃重试过期状态，让消费循环稍后直接应用新状态。
        if (pendingTasks.has(key)) {
          return;
        }
        continue;
      }
      if (error instanceof GrammyError) {
        // 目标点完立刻取消时，自定义表情不再「存在于消息上」，这里会收到
        // 400；属于正常竞态，记录后放弃即可，不影响后续任务。
        logger.error(`Failed to set message reaction: ${error.error_code} ${error.description}`);
      } else {
        logger.error("Error setting message reaction:", error);
      }
      return;
    }
  }
}
