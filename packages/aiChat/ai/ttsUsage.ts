/**
 * 语音合成的每日计数：tts 门面（aiChat/provider.ts）在发起供应商请求前经 claimTtsUsage
 * 登记一次，超出调用方口径的上限时拒绝；AI 回复的提示词与语音工具回执经 aiTtsRemaining
 * 读取模型可见的余量（按 `agent.tts` 的 `ai` 口径上限计算）。
 *
 * 权威值在 cache/workers/aiChat/ttsUsage.ts；每次登记后以 ttsUsage 事件把新值交给主线程，
 * 由主线程写进 memory/global/state.json 的 `ttsUsage`，并在 Worker 启动与崩溃重建时经
 * hydrateTtsUsage 灌回。
 *
 * 所属线程：AI 闲聊 Worker。
 */

import { ttsDailyUsage } from "../../cache/workers/aiChat/ttsUsage";
import { agentTtsConfig } from "../../config/agent";
import { activeTtsUsageCount, ttsQuotaLimit } from "./utils/ttsUsageWindow";
import type { AgentTtsCapabilityConfig } from "../../types/config";
import type { AiTtsUsageEvent } from "../../types/aiChat/protocol";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";

declare const self: Worker;

/** 接管主线程恢复或重放的计数；null 表示从没用过。 */
export function hydrateTtsUsage(usage: TtsDailyUsage | null): void {
  ttsDailyUsage.current = usage;
}

/**
 * 登记一次合成请求。窗口内已达 dailyLimit 时返回 false，不改计数；否则计数加一
 * （窗口已过期或从没用过时以 now 为新起点、从 1 计），把新值回传主线程并返回 true。
 * @param dailyLimit 本调用方可用到的每日上限。
 */
export function claimTtsUsage(dailyLimit: number, now: number = Date.now()): boolean {
  const current: TtsDailyUsage | null = ttsDailyUsage.current;
  const used: number = activeTtsUsageCount(current, now);
  if (used >= dailyLimit) return false;
  const usage: TtsDailyUsage = current === null || used === 0
    ? { windowStartedAt: now, count: 1 }
    : { windowStartedAt: current.windowStartedAt, count: used + 1 };
  ttsDailyUsage.current = usage;
  self.postMessage({ type: "ttsUsage", usage } satisfies AiTtsUsageEvent);
  return true;
}

/**
 * AI 语音工具此刻还能发起的次数：本 isolate 当前 `agent.tts` 的 `ai` 口径上限减去窗口内
 * 已用次数，不小于 0；`agent.tts` 缺省时为 0。
 */
export function aiTtsRemaining(now: number = Date.now()): number {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined) return 0;
  return Math.max(0, ttsQuotaLimit(tts, "ai") - activeTtsUsageCount(ttsDailyUsage.current, now));
}
