import type Anthropic from "@anthropic-ai/sdk";

/**
 * 按一项能力配置建好的 Anthropic 客户端（aiChat/anthropic/sdkClient.ts 的 createAnthropicClient），
 * 与其回退中间件所用的 fallback_model 成对缓存；没有配置回退时 fallbackModel 为 undefined。
 */
export interface AnthropicClient {
  readonly sdk: Anthropic;
  readonly fallbackModel: string | undefined;
}

/**
 * Anthropic Messages 请求的结构化成功或安全失败结果。形状与 types/aiChat/openai.ts 的
 * OpenAiRequestResult 保持一致：「请求本身失败」与「HTTP 成功但产出不可用」是同一套业务语义。
 */
export type AnthropicRequestResult =
  | { ok: true; message: Anthropic.Beta.BetaMessage }
  | {
    ok: false;
    /** 请求本身失败；各取值的含义同 OpenAiRequestResult 的同名 failureKind。 */
    failureKind: "request" | "rejected" | "unsupported" | "misconfigured";
    stopReason?: undefined;
    stopDetails?: undefined;
    message?: undefined;
  }
  | {
    ok: false;
    /**
     * HTTP 成功但产出不可用：`refused` 是拒答（配置了 fallback_model 时回退模型也拒答），
     * `response` 是截断、上下文超长或暂停续发用尽。
     */
    failureKind: "response" | "refused";
    /** 原样的收尾原因，如 `max_tokens`、`refusal`。 */
    stopReason: string | undefined;
    /**
     * `stop_details` 去掉 `fallback_credit_token` 后的诊断串（见 aiChat/anthropic/response.ts 的
     * anthropicStopDetailsJson）。拒答时它是 `{ type: "refusal", category, explanation }`，category 与
     * explanation 可以为 null；请求带 fallback-credit beta 时另有 `fallback_has_prefill_claim`。收尾原因没有
     * 附加详情（字段为 null）或兼容网关不带该字段时为 undefined。
     */
    stopDetails: string | undefined;
    /** 仅供检索计数等预算判断；不得解析其中的正文或工具调用。 */
    message: Anthropic.Beta.BetaMessage;
  };
