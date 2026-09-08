/**
 * 媒体输入能力错误的供应商中立分类。只把错误正文明确同时表达「某种媒体输入不受
 * 支持」的 4xx 记为能力结论；普通参数错误、内容过滤与单份坏媒体都保持可恢复，
 * 不能因此关闭整个 Worker 生命周期的模态。
 *
 * 404/405 单独归为**配置错误**而不是能力缺失：这条 API 路径压根不可调用，最常见
 * 的成因是 model 写错或 base_url 指错。两者都该停止重复下载与请求，但把部署笔误
 * 记成「这个模型没有视觉能力」会让运维照着错误的方向查——他会去换模型，而要改的
 * 是 config/agent.json 里的一行。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

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
 */
export function isEndpointMisconfiguredError(status: number | undefined): boolean {
  return status === 404 || status === 405;
}

/**
 * 判断一次失败是否说明**端点在故障**，而不是这一次请求的内容被拒。
 *
 * 没有状态码（网络错误、DNS、超时、SDK 未归一化的异常）一律算故障：SDK 的重试
 * 已经耗尽，还是拿不到 HTTP 响应。408/429/5xx 同理。其余 4xx 是「这一份输入不
 * 合适」，换一份多半就成了——把它算成端点故障会让一张坏图把整条模态推进退避。
 */
export function isEndpointFailureStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 判断一次媒体请求是否明确暴露模型的输入模态边界。
 *
 * 常见 4xx 必须由错误正文同时命中“不支持”和“媒体输入”两类语义，不能仅凭状态码
 * 猜测；路径级的 404/405 由 isEndpointMisconfiguredError 单独归类。
 */
export function isExplicitUnsupportedMediaError(
  status: number | undefined,
  message: string
): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;

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
 * 2. `unsupported`——仅媒体能力，且错误正文同时表达「不支持」和「媒体输入」。
 * 3. `rejected`——不是端点故障的其余状态：这一份输入不合适，换一份多半就成了，
 *    不推动模态退避。
 * 4. `endpointFailure`——408/429/5xx 与拿不到状态码的网络层失败。
 *
 * 本函数**不记日志**：三个调用点的日志各自带着不同的 errorLabel 与状态码渲染
 * 口径（gemini 的 `ApiError.status` 恒为 number，OpenAI 侧是 `number | undefined`
 * 且要渲染成 `?`），合并会改变已有的日志文本。返回值形态同理留在调用点，
 * 各自映射成自己的 `failureKind` / `mediaFailure`。
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
