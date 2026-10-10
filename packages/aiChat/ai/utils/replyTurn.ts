/**
 * 回复轮次结果的共用构造，供没有「服务端工具调用过多」信号的实现包使用。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import { EMPTY_FUNCTION_CALLS } from "../../../consts/aiChat/tools";
import type { AiReplyTurn } from "../../../types/aiChat/provider";

/**
 * 一轮失败的回复；与成功分支按同一顺序初始化同一组字段，保持对象 shape 一致。
 * toolCallLimitHit 恒为 false，其 fail-safe 含义是「不触发关掉检索的那次额外重试」。
 */
export function failedReplyTurn(
  webSearchCalls: number,
  finishReason: string | undefined,
  finishDetails: string | undefined
): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: EMPTY_FUNCTION_CALLS,
    webSearchCalls,
    finishReason,
    finishDetails,
    toolCallLimitHit: false,
  };
}
