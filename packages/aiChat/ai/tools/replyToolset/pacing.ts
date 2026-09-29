/**
 * 动作执行的两种节奏（见 types/aiChat/replies.ts 的 ReplyActionPause）：都先切到动作对应的挡位，
 * 心跳还在静默期时停顿顺延剩余静默（见 aiChat/ai/chatActionHeartbeat.ts），可见时长不被吃掉。
 * 有序并行轮在串行链上对每个动作做拟人停顿；直接轮只有「正在输入」请求交回的第一条文字沿用请求
 * 期间亮着的挡位、不再停顿，其余动作照常停顿，逐个发出。发送工具只调用注入的停顿，不区分轮次。
 */

import { pauseForToolAction } from "../../utils/toolPause";
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
 * 直接轮：请求模型期间亮调用方给的挡位。「正在输入」请求交回的第一个动作是文字时，它的第一次停顿
 * 只切挡——模型写这句话的请求期间已经亮着「正在输入」；其余停顿切挡并照常等待。挑贴纸的那次请求
 * 很短，选择状态撑不起一段可见的时长，因此贴纸总是停顿。每个动作开始时接走请求亮着的挡位，执行完
 * 收回挡位并开始静默；模型阶段结束时最后一次请求亮的挡位若没被动作接走（那次请求没再交回动作），
 * 同样收回。
 */
export function createDirectPacing(chatAction: ChatActionControl, signal?: AbortSignal): DirectReplyPacing {
  const simulated: ReplyActionPause = createSimulatedPause(chatAction, signal);
  // 最后一次请求亮着、还没被动作接走的挡位；idle 表示没有。
  let requestPhase: ChatActionPhase = "idle";
  return {
    beforeModelRequest: (phase: ChatActionPhase): void => {
      requestPhase = phase;
      if (phase !== "idle") chatAction.set(phase);
    },
    startAction: (text: boolean): ReplyActionPause => {
      let continuing: boolean = text && requestPhase === "typing";
      requestPhase = "idle";
      return (phase: ChatActionPhase, delayMs: number): Promise<string | null> => {
        if (!continuing) return simulated(phase, delayMs);
        continuing = false;
        chatAction.set(phase);
        return Promise.resolve(null);
      };
    },
    endAction: (): void => {
      chatAction.set("idle");
    },
    endModel: (): void => {
      if (requestPhase === "idle") return;
      requestPhase = "idle";
      chatAction.set("idle");
    },
  };
}
