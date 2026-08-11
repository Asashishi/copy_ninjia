import type { GenerateContentResponse } from "@google/genai";

/** Gemini generateContent 的结构化成功或安全失败结果。 */
export type GeminiRequestResult =
  | { ok: true; response: GenerateContentResponse }
  | {
    ok: false;
    /**
     * 端点在故障：网络错误、超时、408/429/5xx，SDK 已耗尽 HTTP 重试；也包括调用方
     * 主动取消。没有可供业务层消费的响应。媒体探测据此进入退避而不是下结论。
     */
    failureKind: "request";
    diagnostic: string;
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /**
     * 端点以普通 4xx 拒绝了**这一次请求的内容**（参数不合、图片坏了等）。与
     * "request" 分开是因为它不是端点故障：拿另一份输入再来多半就成功了，因此
     * 既不该推动媒体探测退避，也不该被当成模型能力缺失。
     */
    failureKind: "rejected";
    diagnostic: string;
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /** 端点以确定性的 4xx 说明它不接受这种输入模态。 */
    failureKind: "unsupported";
    diagnostic: string;
    finishReason?: undefined;
    finishMessage?: undefined;
    response?: undefined;
  }
  | {
    ok: false;
    /**
     * 端点以 404/405 表示这条 API 路径根本不可调用。这多半是 model 写错或
     * base_url 指错，不是模型缺少某项模态能力——两者都该停止重复请求，但只有
     * 分开记录才看得出该去改配置还是换模型。
     */
    failureKind: "misconfigured";
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
