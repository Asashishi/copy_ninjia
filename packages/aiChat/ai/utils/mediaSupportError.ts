/**
 * 媒体输入能力错误的供应商中立分类。只把错误正文明确表达模型、端点或媒体输入
 * 模态不受支持的 4xx 记为能力结论；普通参数错误、内容过滤与单份坏媒体都保持可恢复，
 * 不能因此关闭整个 Worker 生命周期的模态。
 *
 * 404/405 单独归为**配置错误**而不是能力缺失：这条 API 路径压根不可调用，最常见
 * 的成因是 model 写错或 base_url 指错。两者都该停止重复下载与请求，但把部署笔误
 * 记成「这个模型没有视觉能力」会让运维照着错误的方向查——他会去换模型，而要改的
 * 是 config/dynamic/agent.json 里的一行。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  MEDIA_INPUT_CAPABILITY_PATTERN,
  MEDIA_INPUT_FILE_ERROR_PATTERN,
} from "../../../consts/aiChat/media";

/** 从供应商错误对象安全读取数值 HTTP 状态，避免兼容 SDK 把字段暴露成 any。 */
export function numericErrorStatus(error: unknown): number | undefined {
  const candidate: { readonly status?: unknown } = error as { readonly status?: unknown };
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/**
 * 判断一次请求是否表明当前配置下这条 API 路径根本不可调用。
 *
 * 与模态无关，因此不限于 media 能力：任何能力配错 model 或 base_url 都会撞上
 * 同一个 404/405。
 *
 * 与下面两个判据一样**不导出**：级联顺序本身是语义（见
 * classifyProviderApiFailure），单拿一档出去判就绕开了那个顺序。
 */
function isEndpointMisconfiguredError(status: number | undefined): boolean {
  return status === 404 || status === 405;
}

/**
 * 判断一次失败是否说明**端点在故障**，而不是这一次请求的内容被拒。
 *
 * 没有状态码（网络错误、DNS、超时、SDK 未归一化的异常）一律算故障：SDK 的重试
 * 已经耗尽，还是拿不到 HTTP 响应。408/429/5xx 同理。其余 4xx 是「这一份输入不
 * 合适」，换一份多半就成了——把它算成端点故障会让一张坏图把整条模态推进退避。
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
 * 供应商 API 错误的归因级联。**判定顺序本身是语义**，三个模型客户端
 * （aiChat/gemini/client.ts、aiChat/openai/client.ts、aiChat/openai/text.ts）
 * 必须走同一条，否则同一个 HTTP 状态在不同供应商上会得出不同结论：
 *
 * 1. `misconfigured`——路径级 404/405 最先判。它说明这条能力的 model 或 base_url
 *    写错了，与「这个模型不支持读图」不该混在一起；先判它才不会把部署笔误记成
 *    模态缺失，把运维引去换模型。
 * 2. `unsupported`——仅媒体能力，正文明确拒绝输入模态，且不包含单份媒体格式或内容错误。
 * 3. `rejected`——不是端点故障的其余状态：这一份输入不合适，换一份多半就成了，
 *    不推动模态退避。
 * 4. `endpointFailure`——408/429/5xx 与拿不到状态码的网络层失败。
 *
 * 本函数**不记日志**：三个调用点各自带着自己的 errorLabel 与状态码口径（gemini 记
 * `error.status error.message`，OpenAI 侧只记 `error.message`）。返回值形态同理留在
 * 调用点，各自映射成自己的 `failureKind` / `mediaFailure`。
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
 * 两个模型客户端共用的失败结果形态。
 *
 * `GeminiRequestResult` 与 `OpenAiRequestResult` 的这三个 `ok: false` 成员逐字段
 * 同构（其余字段都是可选的 `undefined` 占位），因此同一个对象对两个联合都可赋值。
 */
export interface ProviderApiFailureResult {
  readonly ok: false;
  readonly failureKind: Exclude<ProviderApiFailureKind, "endpointFailure">;
}

/**
 * 把归因档位映射成两个模型客户端共用的失败结果。级联判定
 * （classifyProviderApiFailure）与这一步映射收在同一个叶子模块，两家供应商对同一档
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
