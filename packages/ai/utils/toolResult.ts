/**
 * function calling 工具返回给模型的 wire 格式。所有执行器（ai/tools/ 与
 * ai/tools/replyToolset/ 下的各个 tool）都必须经这里生成失败结果，不要各自
 * 手写 JSON.stringify：编排器会解析这份 JSON 结算动作预算（见
 * ai/tools/replyToolset/orchestrator.ts），失败结果不带 success 字段这一点
 * 是两侧共同依赖的约定。
 */

/** 一条工具失败结果。message 直接是给模型看的英文说明，不做本地化。 */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}
