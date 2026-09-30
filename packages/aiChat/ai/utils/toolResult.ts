/**
 * function calling 工具返回给模型的 wire 格式。所有执行器（aiChat/ai/tools/ 与
 * aiChat/ai/tools/replyToolset/ 下的各个 tool）都必须经这里生成失败结果，不要各自
 * 手写 JSON.stringify；编排器、串行动作链与兜底发送都经 parseToolResult 读回结果（见
 * aiChat/ai/tools/replyToolset/orchestrator.ts），失败结果不带 success 字段这一点
 * 是两侧共同依赖的约定。
 */

/** 工具结果 JSON 里编排侧读取的字段；结果只由本地执行器构造。 */
interface ToolResultWire {
  success?: boolean;
  actions_used?: number;
  error?: unknown;
}

/** 一条工具结果里编排侧读取的两项。 */
export interface ParsedToolResult {
  /** 占用的动作额度：成功结果按 actions_used（缺省 1）；失败、拒绝与重复跳过为 0。 */
  readonly actionsUsed: number;
  /** 失败说明；不是失败结果时为 null。 */
  readonly error: string | null;
}

/**
 * 一条工具失败结果。message 直接是给模型看的英文说明，不做本地化。
 * @param extra 少数失败结果还要带上模型需要的附加字段（`retryable`、
 *   `retry_after_seconds`、`required_action` 等，见 replyToolset/imageGeneration.ts）。
 *   它们按传入顺序拼在 `error` 之后。绝不能为了
 *   统一形状把这些字段丢掉——模型靠 `retryable` 判断该不该重试。
 */
export function toolError(message: string, extra?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** 解析一条工具结果，只解析一次。 */
export function parseToolResult(result: string): ParsedToolResult {
  const parsed: ToolResultWire = JSON.parse(result) as ToolResultWire;
  return {
    actionsUsed: parsed.success === true ? parsed.actions_used ?? 1 : 0,
    error: typeof parsed.error === "string" ? parsed.error : null,
  };
}
