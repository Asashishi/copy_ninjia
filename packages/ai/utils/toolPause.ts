/**
 * 工具执行器里那段「切挡 → 拟人停顿 → 继续」的等待。
 *
 * 停顿本身是可中止的：`/ai_chat disable`、群拆除、记忆容量驱逐都会
 * `invalidateChatReplies`，abort 掉本轮的 AbortController，而 libs/sleep.ts 会以
 * abort 原因 reject。**这个 reject 绝不能逃出 `toolset.execute()`**：
 * `replyToolset/orchestrator.ts` 的 dispatch/execute 与 `callGemini` 里那句
 * `await toolset.execute(...)` 都没有 try/catch，一次逃逸展开的不是这一次调用，
 * 而是整个 `for (const call of functionCalls)` 循环——同一轮里模型发出的其余调用
 * 一个都不执行，`contents.push({ role: "user", parts: responseParts })` 也不会跑，
 * 留下一个带未应答 `functionCall` 的 model 轮。
 *
 * 三个执行器（send_message、view_sticker_pack、send_sticker）用的是同一段逻辑，
 * 因此收在这里而不是各写一遍 try/catch：漏掉任何一处都只在 `replyRound` 外层
 * 那句「aborted 就静默吞掉」的 catch 底下才看不出来，换一个 abort 源就会变成
 * 一条没头没尾的「Error in AI reply task」。
 */

import { REPLY_INVALIDATED_TOOL_ERROR } from "../../consts/tools";
import { sleep } from "../../libs/sleep";
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
 * @returns 停顿期间轮次被作废时返回给模型的工具错误 JSON；正常走完返回 null。
 *   非 abort 原因的 reject 照常上抛——那是真正的异常，不该被伪装成作废。
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
