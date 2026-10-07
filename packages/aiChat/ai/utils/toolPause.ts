/**
 * 拟人停顿的可取消等待；取消归一为工具错误 JSON，交给调用方（串行动作链或直接轮的
 * 工具调用）结算。
 */

import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../consts/tools";
import { sleep } from "../../../libs/sleep";
import { toolError } from "./toolResult";

/** pauseForToolAction 的入参。 */
export interface PauseForToolActionParams {
  /** 停顿时长（ms）。 */
  delayMs: number;
  /** 本轮生成的取消信号；未提供时停顿不可中止。 */
  signal?: AbortSignal;
}

/**
 * 等待一次可中止的拟人停顿。
 * @returns 停顿期间轮次被作废时交给调用链结算的工具错误 JSON；正常走完返回 null。
 *   非 abort 原因的 reject 照常上抛。
 */
export async function pauseForToolAction({ delayMs, signal }: PauseForToolActionParams): Promise<string | null> {
  try {
    await sleep(delayMs, signal);
  } catch (error: unknown) {
    if (signal?.aborted === true) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    throw error;
  }
  return null;
}
