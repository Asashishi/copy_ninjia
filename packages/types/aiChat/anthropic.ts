import type Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic Messages 请求的结构化成功或安全失败结果。形状与 types/aiChat/openai.ts 的
 * OpenAiRequestResult 保持一致：「请求本身失败」与「HTTP 成功但产出不可用」是同一套业务语义。
 */
export type AnthropicRequestResult =
  | { ok: true; message: Anthropic.Message }
  | {
    ok: false;
    /** 端点在故障（网络/超时/408/429/5xx）或调用方主动取消；口径同 OpenAiRequestResult。 */
    failureKind: "request" | "rejected" | "unsupported" | "misconfigured";
    message?: undefined;
  }
  | {
    ok: false;
    /** HTTP 成功但产出不可用（截断、拒答、上下文超长或暂停续发用尽）。 */
    failureKind: "response";
    /** 原样的收尾原因，如 `max_tokens`、`refusal`。 */
    stopReason: string | undefined;
    /** 仅供检索计数等预算判断；不得解析其中的正文或工具调用。 */
    message: Anthropic.Message;
  };
