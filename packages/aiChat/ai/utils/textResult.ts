/**
 * 文本生成结果的收尾判定，各家实现包共用。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import type { AiTextResult } from "../../../types/aiChat/provider";

/**
 * 各实现包共用的请求失败归因，取值与各自 `RequestResult.failureKind` 一致。
 */
export type AiRequestFailureKind =
  | "request"
  | "rejected"
  | "response"
  | "refused"
  | "unsupported"
  | "misconfigured";

/**
 * 把一次失败的请求收窄成业务结果，并带出对整条媒体模态的结论。
 *
 * 五条口径各自独立：
 * - `response`（HTTP 成功但产出不可用）只说明这一次采样不行，允许业务层重采样。
 * - `rejected`（普通 4xx 拒绝这次请求内容）说明这一份输入被拒，不可重采样。
 * - `refused`（Anthropic 模型拒答，配置了回退模型时回退模型也拒答）说明这一份输入被安全策略拒绝，
 *   不可重采样，结果带 `refused: true`。
 *   三者都不带 mediaFailure。
 * - `unsupported` / `misconfigured` 是确定性模态结论；模态状态机据此阻止新下载与请求，
 *   同配置代次的在途成功仍可恢复支持结论。
 * - `request`（端点故障：网络、超时、408/429/5xx）对媒体是瞬时结论：模态结论
 *   不变，只按次数退避，不永久关闭。
 *
 * 非媒体流水线（摘要、贴纸整包简介）一律不带 mediaFailure。
 */
export function classifyAiTextFailure(
  failureKind: AiRequestFailureKind,
  capability: "summary" | "media" | "text"
): AiTextResult {
  if (failureKind === "response") return { ok: false, retryable: true };
  if (failureKind === "refused") return { ok: false, retryable: false, refused: true };
  if (capability !== "media" || failureKind === "rejected") return { ok: false, retryable: false };
  if (failureKind === "unsupported") return { ok: false, retryable: false, mediaFailure: "unsupported" };
  if (failureKind === "misconfigured") return { ok: false, retryable: false, mediaFailure: "misconfigured" };
  return { ok: false, retryable: false, mediaFailure: "transient" };
}

/**
 * 把清洗后的正文收窄成业务结果。
 *
 * 清洗后为空算作可重采样的失败（`retryable: true`），非空为成功。各实现包共用这一口径。
 */
export function finalizeAiTextResult(normalizedText: string): AiTextResult {
  return normalizedText.length > 0
    ? { ok: true, text: normalizedText }
    : { ok: false, retryable: true };
}
