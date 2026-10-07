/**
 * 媒体输入能力错误的供应商中立分类。只把错误正文明确表达模型、端点或媒体输入
 * 模态不受支持的 4xx 记为能力结论；普通参数错误、内容过滤与单份坏媒体都保持可恢复，
 * 不关闭整个 Worker 生命周期的模态。
 *
 * 404/405 单独归为配置错误，不记为能力缺失：这条 API 路径不可调用，对应
 * config/dynamic/agent.json 里的 model 或 base_url。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  MEDIA_INPUT_CAPABILITY_PATTERN,
  MEDIA_INPUT_FILE_ERROR_PATTERN,
} from "../../../consts/aiChat/media";

/** 从供应商错误对象读取数值 HTTP 状态；不是数值时为 undefined。 */
export function numericErrorStatus(error: unknown): number | undefined {
  const candidate: { readonly status?: unknown } = error as { readonly status?: unknown };
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/**
 * 判断一次请求是否表明当前配置下这条 API 路径根本不可调用。
 *
 * 与模态无关，不限于 media 能力。
 *
 * 本判据与下面两个判据都不导出，统一经 classifyProviderApiFailure 按级联顺序使用。
 */
function isEndpointMisconfiguredError(status: number | undefined): boolean {
  return status === 404 || status === 405;
}

/**
 * 判断一次失败是否说明端点在故障，而不是这一次请求的内容被拒。
 *
 * 没有状态码（网络错误、DNS、超时、SDK 未归一化的异常）、408、429 与 5xx 算端点故障；
 * 其余 4xx 属于这一份输入被拒。
 */
function isEndpointFailureStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 判断一次媒体请求是否明确暴露模型的输入模态边界。
 *
 * 常见 4xx 必须同时具备拒绝、媒体与能力边界证据。格式、编码或损坏等输入问题
 * 不形成能力结论；路径级 404/405 由 isEndpointMisconfiguredError 单独归类。
 */
function isExplicitUnsupportedMediaError(
  status: number | undefined,
  message: string
): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  if (MEDIA_INPUT_FILE_ERROR_PATTERN.test(message) || !MEDIA_INPUT_CAPABILITY_PATTERN.test(message)) return false;

  const normalized: string = message.toLowerCase();
  const rejectsCapability: boolean = normalized.includes("unsupported") ||
    normalized.includes("not supported") ||
    normalized.includes("does not support") ||
    normalized.includes("doesn't support") ||
    normalized.includes("cannot process") ||
    normalized.includes("can't process") ||
    normalized.includes("not capable");
  if (!rejectsCapability) return false;
  return normalized.includes("media") ||
    normalized.includes("modality") ||
    normalized.includes("image") ||
    normalized.includes("vision") ||
    normalized.includes("audio") ||
    normalized.includes("voice") ||
    normalized.includes("input type") ||
    normalized.includes("content type");
}

/** 一次供应商 API 失败的归因档位；`endpointFailure` 表示端点在故障，交给调用方兜底。 */
export type ProviderApiFailureKind =
  | "misconfigured"
  | "unsupported"
  | "rejected"
  | "endpointFailure";

/**
 * 供应商 API 错误的归因级联，判定顺序固定，各模型客户端（aiChat/anthropic/client.ts、
 * aiChat/gemini/client.ts、aiChat/openai/client.ts、aiChat/openai/text.ts）共用同一条：
 *
 * 1. `misconfigured`——路径级 404/405 最先判，说明这条能力的 model 或 base_url 配置有误。
 * 2. `unsupported`——仅媒体能力，正文明确拒绝输入模态，且不包含单份媒体格式或内容错误。
 * 3. `rejected`——不是端点故障的其余状态：这一份输入被拒，不推动模态退避。
 * 4. `endpointFailure`——408/429/5xx 与拿不到状态码的网络层失败。
 *
 * 本函数不记日志；日志与返回值形态由各调用点处理，分别映射成自己的 `failureKind` /
 * `mediaFailure`。
 *
 * @param isMediaCapability 本次请求是否属于媒体能力；只有它为真才可能得出 unsupported。
 */
export function classifyProviderApiFailure(
  status: number | undefined,
  message: string,
  isMediaCapability: boolean
): ProviderApiFailureKind {
  if (isEndpointMisconfiguredError(status)) return "misconfigured";
  if (isMediaCapability && isExplicitUnsupportedMediaError(status, message)) {
    return "unsupported";
  }
  if (!isEndpointFailureStatus(status)) return "rejected";
  return "endpointFailure";
}

/**
 * 各模型客户端共用的失败结果形态。
 *
 * 本形态可直接赋值给 `GeminiRequestResult`、`OpenAiRequestResult` 与
 * `AnthropicRequestResult` 的对应 `ok: false` 成员（其余字段为可选的 `undefined` 占位）。
 */
export interface ProviderApiFailureResult {
  readonly ok: false;
  readonly failureKind: Exclude<ProviderApiFailureKind, "endpointFailure">;
}

/**
 * 把归因档位映射成各模型客户端共用的失败结果。级联判定
 * （classifyProviderApiFailure）与这一步映射收在同一个叶子模块，各家供应商对同一档
 * 结论返回同一个 `failureKind`。
 *
 * `endpointFailure` 不在这里映射：它不是一个可直接返回的结果，而是「继续走
 * 调用点自己的兜底路径」的信号（两个 client 都在那之后统一记一行日志并返回
 * `failureKind: "request"`）。返回 `undefined` 让调用点显式接住这一档。
 *
 * `aiChat/openai/text.ts` 的语音探测不走这里：它把归因档位交给 textResult.ts 的
 * `classifyAiTextFailure` 映射成 `mediaFailure`，形态本来就与结果联合不同。
 */
export function providerApiFailureResult(
  kind: ProviderApiFailureKind
): ProviderApiFailureResult | undefined {
  switch (kind) {
    case "misconfigured":
      return { ok: false, failureKind: kind };
    case "unsupported":
      return { ok: false, failureKind: kind };
    case "rejected":
      return { ok: false, failureKind: kind };
    case "endpointFailure":
      return undefined;
  }
}
