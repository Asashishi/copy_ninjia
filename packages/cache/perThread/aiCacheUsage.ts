import type { AiCacheUsage, AiUsageWarningKey } from "../../types/aiCache";

/**
 * AI 缓存用量上报出口（packages/infra/aiCacheUsage.ts）的线程内 holder。
 *
 * perThread：AI 闲聊 Worker 与 Anti-Raid Worker 启动时各自装上把用量作为事件发回主线程的
 * 出口，停止时清除；主线程与未装出口的线程保持 null，无法上报时由边界给出一次诊断。容量恒为一个函数，
 * 不淘汰；Worker 重建后由新 isolate 重新安装。
 */
export const aiCacheUsageSink: { current: ((usage: AiCacheUsage) => void) | null } = { current: null };

/**
 * perThread 用量诊断去重集合：首次出现的原因填充，安装/卸下出口时清空。
 * 容量最多为 6 种能力 × 2 个供应商 × 5 种原因；不含可增长的模型名或响应字段。
 * Worker 重建后为空，同一出口生命周期内每种组合只记录一次。
 */
export const aiUsageWarningKeys: Set<AiUsageWarningKey> = new Set();
