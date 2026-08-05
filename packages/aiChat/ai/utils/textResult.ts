/**
 * 文本生成结果的收尾判定，两家实现包共用。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import type { AiTextResult } from "../../../types/aiChat/provider";

/**
 * 把清洗后的正文收窄成业务结果。
 *
 * 「清洗后为空」必须算作**可重采样**的失败：那多半是模型这一次空转，而不是它
 * 判断出「没什么可说的」——两者对调用方不可区分，当成成功交回去就成了一次没有
 * 任何日志痕迹的静默降级（摘要变空、媒体描述退化成占位）。
 *
 * 抽出来共用而不是两家各写一遍：这条口径若在一侧被改成「空串也算成功」，另一侧
 * 不会有任何编译或测试信号，而症状要到线上才看得出来。
 */
export function finalizeAiTextResult(normalizedText: string): AiTextResult {
  return normalizedText.length > 0
    ? { ok: true, text: normalizedText }
    : { ok: false, retryable: true };
}
