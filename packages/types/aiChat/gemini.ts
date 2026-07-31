import type { GenerateContentResponse } from "@google/genai";

/** Gemini generateContent 的结构化成功或安全失败结果。 */
export type GeminiRequestResult =
  | { ok: true; response: GenerateContentResponse }
  | {
    ok: false;
    diagnostic: string;
    finishReason?: string;
    finishMessage?: string;
    /** 仅供异常分支做预算/重试判断；不得解析其中的文本或 functionCall。 */
    response?: GenerateContentResponse;
  };
