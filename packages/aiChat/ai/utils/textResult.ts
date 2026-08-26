/**
 * 文本生成结果的收尾判定，两家实现包共用。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import type { AiTextResult } from "../../../types/aiChat/provider";

/**
 * 两家实现包共用的请求失败归因。名字与各自 `RequestResult.failureKind` 一致：
 * 那是同一套业务语义，不该在收窄成 AiTextResult 时各写一份映射。
 */
export type AiRequestFailureKind =
  | "request"
  | "rejected"
  | "response"
  | "unsupported"
  | "misconfigured";

/**
 * 把一次失败的请求收窄成业务结果，并把**对整条媒体模态的结论**一起带出去。
 *
 * 四条口径各自独立，不能合并：
 * - `response`（HTTP 成功但产出不可用）只说明这一次采样不行，允许业务层重采样。
 * - `rejected`（普通 4xx 拒绝这次请求内容）说明这一份输入不合适；SDK 重试已耗尽，
 *   不得再套一层完整请求。两者都**不带** mediaFailure——单份坏媒体既不该关闭整条
 *   模态，也不该推动退避。
 * - `unsupported` / `misconfigured` 是确定性终局；模态状态机据此停止后续下载。
 * - `request`（端点故障：网络、超时、408/429/5xx）对媒体是**瞬时**结论：模态结论
 *   不变，只按次数退避，绝不永久关闭。
 *
 * 非媒体流水线（摘要、贴纸整包简介）一律不带 mediaFailure：那条路上的失败与
 * media 端点能力无关，混进去会让一次摘要超时推动媒体模态进退避。
 */
export function classifyAiTextFailure(
  failureKind: AiRequestFailureKind,
  capability: "summary" | "media"
): AiTextResult {
  if (failureKind === "response") return { ok: false, retryable: true };
  if (capability !== "media" || failureKind === "rejected") return { ok: false, retryable: false };
  if (failureKind === "unsupported") return { ok: false, retryable: false, mediaFailure: "unsupported" };
  if (failureKind === "misconfigured") return { ok: false, retryable: false, mediaFailure: "misconfigured" };
  return { ok: false, retryable: false, mediaFailure: "transient" };
}

/**
 * 把清洗后的正文收窄成业务结果。
 *
 * 「清洗后为空」必须算作**可重采样**的失败：那多半是模型这一次空转，而不是它
 * 判断出「没什么可说的」——两者对调用方不可区分，当成成功交回去就成了一次没有
 * 任何日志痕迹的静默降级（摘要变空、媒体描述退化成占位）。
 *
 * OpenAI 与 Gemini 共用这一口径，避免一侧把空串误判为成功。
 */
export function finalizeAiTextResult(normalizedText: string): AiTextResult {
  return normalizedText.length > 0
    ? { ok: true, text: normalizedText }
    : { ok: false, retryable: true };
}
