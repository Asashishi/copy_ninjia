import type { GenerateContentResponse } from "@google/genai";

/** Gemini generateContent 的结构化成功或安全失败结果。 */
export type GeminiRequestResult =
  | { ok: true; response: GenerateContentResponse }
  | {
    ok: false;
    /** SDK 已耗尽 HTTP 重试或调用方主动取消；没有可供业务层消费的响应。 */
    failureKind: "request";
    diagnostic: string;
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /** HTTP 成功但模型结果不可用；可由无副作用调用方决定是否重新采样。 */
    failureKind: "response";
    diagnostic: string;
    finishReason?: string;
    finishMessage?: string;
    /** 仅供异常分支做预算/重试判断；不得解析其中的文本或 functionCall。 */
    response: GenerateContentResponse;
  };

/**
 * 单次 Gemini 文本生成的业务结果。SDK 已耗尽 HTTP 重试时 retryable=false，
 * 防止调用方再套一层完整请求重试；HTTP 成功但正文不可用时才允许业务层重采样。
 */
export type GeminiTextGenerationResult =
  | { ok: true; text: string }
  | { ok: false; retryable: boolean };
