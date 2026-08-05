import type OpenAI from "openai";

/**
 * OpenAI Responses 请求的结构化成功或安全失败结果。形状与
 * types/aiChat/gemini.ts 的 GeminiRequestResult 保持一致——两个实现包对
 * 「请求本身失败」与「HTTP 成功但产出不可用」的区分是同一套业务语义，
 * 上层的重试边界据此判断。
 */
export type OpenAiRequestResult =
  | { ok: true; response: OpenAI.Responses.Response }
  | {
    ok: false;
    /** SDK 已耗尽 HTTP 重试或调用方主动取消；没有可供业务层消费的响应。 */
    failureKind: "request";
    diagnostic: string;
    finishReason?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /** HTTP 成功但模型结果不可用；可由无副作用调用方决定是否重新采样。 */
    failureKind: "response";
    diagnostic: string;
    /** 归一化后的收尾原因，如 `incomplete:max_output_tokens`。 */
    finishReason?: string;
    /** 仅供异常分支做预算/重试判断；不得解析其中的正文或函数调用。 */
    response: OpenAI.Responses.Response;
  };
