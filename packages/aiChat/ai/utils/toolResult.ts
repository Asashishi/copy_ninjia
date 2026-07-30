/**
 * function calling 工具返回给模型的 wire 格式。所有执行器（aiChat/ai/tools/ 与
 * aiChat/ai/tools/replyToolset/ 下的各个 tool）都必须经这里生成失败结果，不要各自
 * 手写 JSON.stringify：编排器会解析这份 JSON 结算动作预算（见
 * aiChat/ai/tools/replyToolset/orchestrator.ts），失败结果不带 success 字段这一点
 * 是两侧共同依赖的约定。
 */

/**
 * 一条工具失败结果。message 直接是给模型看的英文说明，不做本地化。
 * @param extra 少数失败结果还要带上模型需要的附加字段（`retryable`、
 *   `retry_after_seconds`、`required_action` 等，见 replyToolset/imageGeneration.ts）。
 *   它们按传入顺序拼在 `error` 之后，输出与手写对象逐字节一致。绝不能为了
 *   统一形状把这些字段丢掉——模型靠 `retryable` 判断该不该重试。
 */
export function toolError(message: string, extra?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ error: message, ...extra });
}
