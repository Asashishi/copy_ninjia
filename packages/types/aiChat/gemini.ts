import type { GenerateContentResponse } from "@google/genai";

/** Gemini generateContent 的结构化成功或安全失败结果。 */
export type GeminiRequestResult =
  | { ok: true; response: GenerateContentResponse }
  | {
    ok: false;
    /**
     * 端点故障：网络错误、超时、408/429/5xx 且 SDK 已耗尽 HTTP 重试，或调用方
     * 主动取消。没有可供业务层消费的响应；媒体探测据此进入退避，不下结论。
     */
    failureKind: "request";
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /**
     * 端点以普通 4xx 拒绝了这一次请求的内容（参数不合、图片坏了等）。不属于端点故障，
     * 不推动媒体探测退避，也不计为模型能力缺失。
     */
    failureKind: "rejected";
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /** 端点以确定性的 4xx 说明它不接受这种输入模态。 */
    failureKind: "unsupported";
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /**
     * 端点以 404/405 表示这条 API 路径不可调用，指向 model 或 base_url 配置有误；
     * 与模型缺少某项模态能力分开记录。
     */
    failureKind: "misconfigured";
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /** HTTP 成功但模型结果不可用；可由无副作用调用方决定是否重新采样。 */
    failureKind: "response";
    finishReason?: string;
    finishMessage?: string;
    /** 仅供异常分支做预算/重试判断；不得解析其中的文本或 functionCall。 */
    response: GenerateContentResponse;
  };
