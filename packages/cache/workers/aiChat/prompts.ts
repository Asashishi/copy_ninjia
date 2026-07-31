/**
 * AI 闲聊 Worker 的静态提示词缓存（owner 是
 * packages/workers/aiChat/geminiReply.ts）。
 */

/**
 * persona.md 首次用于回复时读取并填充；AI Worker 崩溃重建后重新读盘，
 * 进程内不失效。null 表示尚未成功读取，调用方必须现场加载并传播读取错误。
 * 容量固定为一份字符串。
 */
export const systemPromptHolder: { current: string | null } = { current: null };
