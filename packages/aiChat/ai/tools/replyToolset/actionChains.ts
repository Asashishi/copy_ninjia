import { startChatActionHeartbeat } from "../../chatActionHeartbeat";
import { logger } from "../../../../infra/logger";
import { settleInflight, trackInflight } from "../../../../libs/inflight";
import { raceAbort } from "../../../../libs/abortSignal";
import type { ChatActionHeartbeatControl } from "../../../../types/aiChat/chatAction";
import type { PreparedReplyAction, ReplyActionChains, ReplyToolContext } from "../../../../types/aiChat/replies";

/** 工具结果只由本地执行器构造；拒绝与重复跳过不占动作额度。 */
export function toolResultActions(result: string): number {
  const parsed: { success?: boolean; actions_used?: number; } = JSON.parse(result) as {
    success?: boolean;
    actions_used?: number;
  };
  return parsed.success === true ? parsed.actions_used ?? 1 : 0;
}

/** 接纳回执立即返回；动作依照轮次与工具调用顺序串联，容量由动作预算约束。
 *  生命周期约束见 docs/cn/04-invariants.md。 */
export function createReplyActionChains(
  ctx: ReplyToolContext,
  ready: Promise<void> = Promise.resolve()
): ReplyActionChains {
  const inflight: Set<Promise<unknown>> = new Set();
  let tail: Promise<void> = ready;
  let completed: number = 0;
  return {
    start: (name: string, action: PreparedReplyAction): void => {
      const task: Promise<void> = raceAbort(tail, {
        signal: ctx.signal,
        cancelled: undefined,
        rejected: undefined,
      }).then(async (): Promise<void> => {
        const chatAction: ChatActionHeartbeatControl = startChatActionHeartbeat({
          chatId: ctx.chatId,
          messageThreadId: ctx.messageThreadId,
          signal: ctx.signal,
        });
        try {
          // run 内部负责释放接纳时认领的资源，并在发送前再次核对本轮有效性。
          const result: string = await action.run(chatAction);
          completed += toolResultActions(result);
          const parsed: { error?: string; } = JSON.parse(result) as { error?: string };
          if (parsed.error !== undefined && ctx.isActive()) {
            logger.error(`AI reply action failed (chat ${ctx.chatId}, tool ${name}): ${parsed.error}`);
          }
        } finally {
          await chatAction.stop();
        }
      }).catch((error: unknown): void => {
        if (ctx.isActive()) logger.error(`AI reply action chain failed (chat ${ctx.chatId}, tool ${name}):`, error);
      });
      tail = task;
      void trackInflight(inflight, task);
    },
    settle: (): Promise<void> => settleInflight(inflight),
    completed: (): number => completed,
  };
}
