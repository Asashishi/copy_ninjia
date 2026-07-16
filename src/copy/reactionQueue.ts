import { logger } from "../infra/logger";
import { GrammyError } from "grammy";
import { bot, logApiError } from "../infra/telegram";
import { LinkedQueue } from "../libs/linkedQueue";
import { sleep } from "../libs/sleep";
import { DEFAULT_RETRY_AFTER_SECONDS, MAX_ATTEMPTS } from "../consts/reactionQueue";
import { chatQueues, consumingChats, pendingTasks } from "../cache/reactionQueue";
import type { CopyableReaction, ReactionTask } from "../types";

/**
 * 反应同步的可靠性保障层。经实测确认，复制反应的延迟大头在 Telegram 生成并
 * 投递 message_reaction 更新（日志里的 delivery），队列本身的耗时（queue）
 * 正常情况下只是一次 HTTP 往返，429 限流下会叠加 retry_after 的等待——因此
 * 这一层不为提速，只为三个保障：
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
 * @param reactions 要应用的反应（数组最多 1 个，见 handleReaction 中的选择逻辑）。
 * @param updateId 产生本次调用的更新的 update_id（单调递增），用于新旧判断。
 * @param reactedAtUnix 目标点下反应的时刻（见 ReactionTask.reactedAtUnix），用于延迟统计。
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
    // applyReaction 内部全捕获，正常不会 reject；这层 catch 只是防御——万一
    // 将来漏出异常，finally 已保证 consumingChats 清理，这里别让它变成
    // unhandled rejection。
    consumeChatQueue(chatId).catch((error: unknown) => {
      logger.error("Error in reaction queue consumer:", error);
    });
  }
}

async function consumeChatQueue(chatId: number): Promise<void> {
  consumingChats.add(chatId);
  try {
    const order: LinkedQueue<string> | undefined = chatQueues.get(chatId);
    while (order && order.size > 0) {
      const key: string = order.shift()!;
      // 不在出队时就删 pendingTasks[key]：处理期间（尤其是 429 重试的等待
      // 中，也可能是发起 setMessageReaction 那次网络往返本身）若又有更新的
      // 反应变化到达同一条消息，enqueueReaction 会看到这个 key 仍在
      // pendingTasks 里、原地覆盖成新版本，而不是重新入队——这正是我们要的
      // 合并语义，但也意味着 applyReaction 已经在途的这次调用可能是拿着
      // 旧版本发出去的。applyReaction 返回 false 表示这种情况发生了：把
      // key 重新排回队尾，用（此刻已经是最新的）pendingTasks[key] 再处理
      // 一轮，不能直接删掉——删了就等于丢了这份更新，见 applyReaction 注释。
      const settled: boolean = await applyReaction(key);
      if (settled) {
        pendingTasks.delete(key);
      } else {
        order.push(key);
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

/**
 * 应用一次反应同步。每次实际发起 setMessageReaction 调用前都重新读取
 * pendingTasks[key] 的当下版本（而不是在函数入口处只读一次、全程沿用同一份
 * 快照）——它可能在上一轮 429 重试的睡眠期间，或本次调用的网络往返期间，
 * 被 enqueueReaction 原地更新成更新的版本（见 consumeChatQueue 注释）。
 * @returns 本次调用结束时，pendingTasks[key] 是否仍是发起这次真正 API 调用
 *   时读到的那个版本——true 表示可以放心删除（要么确实是最新版本、要么已
 *   彻底放弃重试），false 表示处理期间被更新的版本覆盖过，调用方需要把这
 *   条 key 重新排回队尾、用最新数据再走一轮。
 */
async function applyReaction(key: string): Promise<boolean> {
  for (let attempt: number = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const task: ReactionTask | undefined = pendingTasks.get(key);
    if (!task) return true; // 理论不可达（key 还在处理中就不该被删掉），防御性放行。
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
      return pendingTasks.get(key) === task;
    } catch (error: unknown) {
      if (error instanceof GrammyError && error.error_code === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfterSeconds: number = error.parameters.retry_after ?? DEFAULT_RETRY_AFTER_SECONDS;
        logger.warn(
          `setMessageReaction rate limited (chat ${task.chatId}, msg ${task.messageId}), ` +
          `waiting ${retryAfterSeconds}s before retry ${attempt + 1}/${MAX_ATTEMPTS}`
        );
        await sleep(retryAfterSeconds * 1000);
        continue; // 下一轮循环开头会重新读取 pendingTasks[key]，天然拿到最新版本。
      }
      // 目标点完立刻取消时，自定义表情不再「存在于消息上」，这里会收到
      // 400；属于正常竞态，记录后放弃即可。若处理期间已经被更新的版本覆盖
      // 过，交回调用方重新排队、用新版本再试一遍，而不是连同新版本一起放弃。
      logApiError("set message reaction", error);
      return pendingTasks.get(key) === task;
    }
  }
  return true;
}
