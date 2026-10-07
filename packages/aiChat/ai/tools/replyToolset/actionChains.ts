import { SEND_MESSAGE_TOOL } from "../../../../consts/tools";
import { logger } from "../../../../infra/logger";
import { trackInflight } from "../../../../libs/inflight";
import { raceAbort } from "../../../../libs/abortSignal";
import { parseToolResult } from "../../utils/toolResult";
import { createSimulatedPause } from "./pacing";
import type { ParsedToolResult } from "../../utils/toolResult";
import type {
  DirectReplyPacing,
  ReplyActionChains,
  ReplyActionPause,
  ReplyActionRun,
  ReplyToolContext,
} from "../../../../types/aiChat/replies";

/**
 * 本轮唯一的串行动作链。接纳回执由各执行器在调用时给出，这里只负责投递：已接纳动作
 * 依照轮次与工具调用顺序串联，全部经本轮心跳句柄 ctx.chatAction 切挡——链上的步骤
 * 按工具顺序依次亮「正在输入 / 选择贴纸 / 录音 / 发送图片」；每一步结束后切回
 * idle。转入后台的动作（defer）不占链，结算出执行函数时排到当时的链尾。
 *
 * 有序并行轮不传 pacing，每一步都用拟人停顿（createSimulatedPause）。直接轮传入本轮的
 * DirectReplyPacing（链不设闸）：start 在接纳时向它领这一步的停顿（只有 send_message 算文字），
 * 链由空闲转为有步骤时调用 chainStarted、排空时调用 chainDrained，让请求期间的挡位只在链空闲时
 * 亮；后台补发的步骤用拟人停顿，不接走请求的挡位。容量由动作预算约束；生命周期约束见
 * docs/cn/04-invariants.md。
 */
export function createReplyActionChains(
  ctx: ReplyToolContext,
  ready: Promise<void> = Promise.resolve(),
  pacing: DirectReplyPacing | null = null
): ReplyActionChains {
  const inflight: Set<Promise<unknown>> = new Set();
  let tail: Promise<void> = ready;
  let completed: number = 0;
  // 已排入、尚未结束的步骤数。
  let queued: number = 0;
  const pause: ReplyActionPause = createSimulatedPause(ctx.chatAction, ctx.signal);

  function record(name: string, result: string): void {
    const parsed: ParsedToolResult = parseToolResult(result);
    completed += parsed.actionsUsed;
    if (parsed.error !== null && ctx.isActive()) {
      logger.error(`AI reply action failed (chat ${ctx.chatId}, tool ${name}): ${parsed.error}`);
    }
  }

  function enqueue(name: string, run: ReplyActionRun, stepPause: ReplyActionPause): void {
    queued++;
    if (queued === 1) pacing?.chainStarted();
    const task: Promise<void> = raceAbort(tail, {
      signal: ctx.signal,
      cancelled: undefined,
      rejected: undefined,
    }).then(async (): Promise<void> => {
      try {
        // run 内部负责释放接纳时认领的资源，并在发送前再次核对本轮有效性。
        record(name, await run(ctx.chatAction, stepPause));
      } finally {
        ctx.chatAction.set("idle");
      }
    }).catch((error: unknown): void => {
      if (ctx.isActive()) logger.error(`AI reply action chain failed (chat ${ctx.chatId}, tool ${name}):`, error);
    }).finally((): void => {
      queued--;
      if (queued === 0) pacing?.chainDrained();
    });
    tail = task;
    void trackInflight(inflight, task);
  }

  return {
    start: (name: string, run: ReplyActionRun): void => {
      enqueue(name, run, pacing === null ? pause : pacing.startAction(name === SEND_MESSAGE_TOOL));
    },
    defer: (name: string, pending: Promise<ReplyActionRun | null>): void => {
      void trackInflight(inflight, pending.then(
        (run: ReplyActionRun | null): void => {
          if (run !== null) enqueue(name, run, pause);
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
