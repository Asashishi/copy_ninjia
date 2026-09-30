/**
 * 动作执行的两种节奏（见 types/aiChat/replies.ts 的 ReplyActionPause）：都先切到动作对应的挡位，
 * 心跳还在静默期时停顿顺延剩余静默（见 aiChat/ai/chatActionHeartbeat.ts），可见时长不被吃掉。
 * 两种轮次的动作都在串行链上执行：有序并行轮对每个动作做拟人停顿；直接轮只有「正在输入」请求交回
 * 的第一条文字沿用请求期间亮着的挡位、不再停顿，其余动作照常停顿，逐个发出。发送工具只调用注入的
 * 停顿，不区分轮次；五个发送工具共用 pauseThenSettle 完成「停顿 → 切回 idle 并落定 → 复核本轮」。
 */

import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { pauseForToolAction } from "../../utils/toolPause";
import { toolError } from "../../utils/toolResult";
import type { ChatActionControl, ChatActionPhase } from "../../../../types/aiChat/chatAction";
import type { DirectReplyPacing, ReplyActionPause } from "../../../../types/aiChat/replies";

/** 有序并行轮：亮 phase 挡，再做一次可中止的拟人停顿（含剩余静默）。 */
export function createSimulatedPause(chatAction: ChatActionControl, signal?: AbortSignal): ReplyActionPause {
  return (phase: ChatActionPhase, delayMs: number): Promise<string | null> => {
    const rest: number = chatAction.set(phase);
    return pauseForToolAction({ delayMs: rest + delayMs, signal });
  };
}

/**
 * 直接轮：串行链空闲时亮本次请求要的挡位，链忙时由链上正在执行的那一步掌管状态，链排空后再亮
 * 仍在进行的请求要的挡位。动作在接纳时（按工具调用顺序）接走请求亮着的挡位：「正在输入」请求交回
 * 的第一个动作是文字时，它的第一次停顿只切挡——模型写这句话的请求期间已经亮着「正在输入」；其余
 * 停顿切挡并照常等待。挑贴纸的那次请求很短，选择状态撑不起一段可见的时长，因此贴纸总是停顿。模型
 * 阶段结束时，请求亮着、还没被动作接走的挡位同样收回。
 */
export function createDirectPacing(chatAction: ChatActionControl, signal?: AbortSignal): DirectReplyPacing {
  const simulated: ReplyActionPause = createSimulatedPause(chatAction, signal);
  // 当前模型请求要亮的挡位；idle 表示不亮或已被动作接走。
  let requestPhase: ChatActionPhase = "idle";
  // requestPhase 此刻由请求亮着（没被链上的步骤盖掉）。
  let lit: boolean = false;
  // 链上有已接纳、未结束的步骤。
  let chainBusy: boolean = false;
  return {
    beforeModelRequest: (phase: ChatActionPhase): void => {
      requestPhase = phase;
      if (chainBusy) return;
      if (phase !== "idle") {
        chatAction.set(phase);
        lit = true;
      } else if (lit) {
        chatAction.set("idle");
        lit = false;
      }
    },
    startAction: (text: boolean): ReplyActionPause => {
      let continuing: boolean = text && requestPhase === "typing" && lit;
      requestPhase = "idle";
      return (phase: ChatActionPhase, delayMs: number): Promise<string | null> => {
        if (!continuing) return simulated(phase, delayMs);
        continuing = false;
        chatAction.set(phase);
        return Promise.resolve(null);
      };
    },
    chainStarted: (): void => {
      chainBusy = true;
      lit = false;
    },
    chainDrained: (): void => {
      chainBusy = false;
      if (requestPhase === "idle") return;
      chatAction.set(requestPhase);
      lit = true;
    },
    endModel: (): void => {
      requestPhase = "idle";
      if (!lit) return;
      lit = false;
      chatAction.set("idle");
    },
  };
}

/** pauseThenSettle 的入参：本轮有效性判定、状态控制、注入的停顿与这一次停顿的挡位和时长。 */
export interface PauseThenSettleOptions {
  readonly isActive: () => boolean;
  readonly chatAction: ChatActionControl;
  readonly pause: ReplyActionPause;
  readonly phase: ChatActionPhase;
  readonly delayMs: number;
}

/**
 * 发送前的统一节奏：按 phase 停顿，切回 idle 并等状态请求落定，再复核本轮是否仍有效。停顿
 * 被作废时返回停顿给出的回执，落定后本轮已作废时返回作废回执；可以发送时返回 null。
 */
export async function pauseThenSettle({
  isActive,
  chatAction,
  pause,
  phase,
  delayMs,
}: PauseThenSettleOptions): Promise<string | null> {
  const invalidated: string | null = await pause(phase, delayMs);
  if (invalidated !== null) return invalidated;
  chatAction.set("idle");
  await chatAction.settle();
  return isActive() ? null : toolError(REPLY_INVALIDATED_TOOL_ERROR);
}
