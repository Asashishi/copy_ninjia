/**
 * 语音合成的每日计数：tts 门面（aiChat/provider.ts）在发起供应商请求前经 claimTtsUsage
 * 按 ai/operator 分别登记 agentCount/reserveCount，超出对应上限时拒绝；AI 回复的提示词与
 * 语音工具回执经 aiTtsRemaining 读取模型可见余量（按 `agent.tts` 的 `ai` 口径计算）。
 *
 * 权威值在 cache/workers/aiChat/ttsUsage.ts；每次登记后以 ttsUsage 事件把新值交给主线程，
 * 由主线程写进 memory/global/state.json 的 `ttsUsage`，并在 Worker 启动与崩溃重建时经
 * hydrateTtsUsage 灌回。
 *
 * 所属线程：AI 闲聊 Worker。线程与持久化顺序见 docs/cn/04-invariants.md。
 */

import { ttsDailyUsage } from "../../cache/workers/aiChat/ttsUsage";
import { agentTtsConfig } from "../../config/agent";
import { activeTtsUsage, ttsQuotaLimit } from "./utils/ttsUsageWindow";
import type { AgentTtsCapabilityConfig } from "../../types/config";
import type { AiTtsUsageEvent } from "../../types/aiChat/protocol";
import type { TtsDailyUsage, TtsQuotaScope } from "../../types/aiChat/voiceMessage";

declare const self: Worker;

/** 接管主线程恢复或重放的计数；null 表示从没用过。 */
export function hydrateTtsUsage(usage: TtsDailyUsage | null): void {
  ttsDailyUsage.current = usage;
}

/**
 * 登记一次合成请求。只检查并增加 scope 对应的计数，达到 dailyLimit 时不改状态。
 * 窗口过期或从没用过时两项计数从零起步，以 now 开始新窗口；登记后回传全量计数。
 */
export function claimTtsUsage(scope: TtsQuotaScope, dailyLimit: number, now: number = Date.now()): boolean {
  const current: TtsDailyUsage | null = activeTtsUsage(ttsDailyUsage.current, now);
  const agentCount: number = current?.agentCount ?? 0;
  const reserveCount: number = current?.reserveCount ?? 0;
  const used: number = scope === "ai" ? agentCount : reserveCount;
  if (used >= dailyLimit) return false;
  const usage: TtsDailyUsage = {
    windowStartedAt: current?.windowStartedAt ?? now,
    agentCount: agentCount + (scope === "ai" ? 1 : 0),
    reserveCount: reserveCount + (scope === "operator" ? 1 : 0),
  };
  ttsDailyUsage.current = usage;
  self.postMessage({ type: "ttsUsage", usage } satisfies AiTtsUsageEvent);
  return true;
}

/**
 * AI 语音工具此刻还能发起的次数：本 isolate 当前 `agent.tts` 的 `ai` 口径上限减去窗口内
 * agentCount，不小于 0；reserveCount 不占 AI 额度；`agent.tts` 缺省时为 0。
 */
export function aiTtsRemaining(now: number = Date.now()): number {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined) return 0;
  return Math.max(0, ttsQuotaLimit(tts, "ai") - (activeTtsUsage(ttsDailyUsage.current, now)?.agentCount ?? 0));
}
