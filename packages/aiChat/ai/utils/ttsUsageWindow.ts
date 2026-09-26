/**
 * 语音合成每日计数的窗口判定与额度口径，纯函数叶子模块：AI Worker 的 tts 门面、登记与
 * 余量计算（aiChat/provider.ts、aiChat/ai/ttsUsage.ts）共用，不接触任何缓存。
 */

import { TTS_USAGE_WINDOW_MS } from "../../../consts/aiChat/voiceMessage";
import type { AgentTtsCapabilityConfig } from "../../../types/config";
import type { TtsDailyUsage, TtsQuotaScope } from "../../../types/aiChat/voiceMessage";

/**
 * now 时刻仍计入当前窗口的请求数；从没用过、或距窗口起点已满 TTS_USAGE_WINDOW_MS
 * 时为 0。
 */
export function activeTtsUsageCount(usage: TtsDailyUsage | null, now: number): number {
  if (usage === null || now - usage.windowStartedAt >= TTS_USAGE_WINDOW_MS) return 0;
  return usage.count;
}

/** 按 `agent.tts` 配置取某个额度口径的每日上限：`operator` 为 dailyLimit，`ai` 为 dailyLimit - dailyReserveQuota。 */
export function ttsQuotaLimit(tts: AgentTtsCapabilityConfig, scope: TtsQuotaScope): number {
  return scope === "ai" ? tts.dailyLimit - tts.dailyReserveQuota : tts.dailyLimit;
}
