import { logger } from "../../../../infra/logger";
import { trackInflight } from "../../../../libs/inflight";
import { raceAbort } from "../../../../libs/abortSignal";
import { parseToolResult } from "../../utils/toolResult";
import { createSimulatedPause } from "./pacing";
import type { ParsedToolResult } from "../../utils/toolResult";
import type { ReplyActionChains, ReplyActionPause, ReplyActionRun, ReplyToolContext } from "../../../../types/aiChat/replies";

/**
 * 本轮唯一的串行动作链。接纳回执由各执行器在调用时给出，这里只负责投递：已接纳动作
 * 依照轮次与工具调用顺序串联，全部经本轮心跳句柄 ctx.chatAction 切挡——任一时刻只有
 * 链上正在执行的那一步能改聊天状态，「正在输入 / 选择贴纸 / 录音 / 发送图片」按工具
 * 顺序依次出现，互不竞态；每一步结束后切回 idle。转入后台的动作（defer）不占链，结算
 * 出执行函数时排到当时的链尾。直接轮的动作不排这条链，在工具调用内执行后只经 record 记账；
 * 它转入后台的语音仍经 defer 排进链（直接轮的链不设闸）。容量由动作预算约束；生命周期约束
 * 见 docs/cn/04-invariants.md。
 */
export function createReplyActionChains(
  ctx: ReplyToolContext,
  ready: Promise<void> = Promise.resolve()
): ReplyActionChains {
  const inflight: Set<Promise<unknown>> = new Set();
  let tail: Promise<void> = ready;
  let completed: number = 0;
  const pause: ReplyActionPause = createSimulatedPause(ctx.chatAction, ctx.signal);

  function record(name: string, result: string): void {
    const parsed: ParsedToolResult = parseToolResult(result);
    completed += parsed.actionsUsed;
    if (parsed.error !== null && ctx.isActive()) {
      logger.error(`AI reply action failed (chat ${ctx.chatId}, tool ${name}): ${parsed.error}`);
    }
  }

  function start(name: string, run: ReplyActionRun): void {
    const task: Promise<void> = raceAbort(tail, {
      signal: ctx.signal,
      cancelled: undefined,
      rejected: undefined,
    }).then(async (): Promise<void> => {
      try {
        // run 内部负责释放接纳时认领的资源，并在发送前再次核对本轮有效性。
        record(name, await run(ctx.chatAction, pause));
      } finally {
        ctx.chatAction.set("idle");
      }
    }).catch((error: unknown): void => {
      if (ctx.isActive()) logger.error(`AI reply action chain failed (chat ${ctx.chatId}, tool ${name}):`, error);
    });
    tail = task;
    void trackInflight(inflight, task);
  }

  return {
    start,
    record,
    defer: (name: string, pending: Promise<ReplyActionRun | null>): void => {
      void trackInflight(inflight, pending.then(
        (run: ReplyActionRun | null): void => {
          if (run !== null) start(name, run);
        },
        (error: unknown): void => {
          if (ctx.isActive()) logger.error(`AI reply background action failed (chat ${ctx.chatId}, tool ${name}):`, error);
        }
      ));
    },
    settle: async (): Promise<void> => {
      // 后台动作结算时才把投递步骤排进链，逐批等到集合清空。
      while (inflight.size > 0) await Promise.allSettled(inflight);
    },
    completed: (): number => completed,
  };
}
