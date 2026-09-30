/**
 * 语音合成的每日计数：AI 语音工具在工具调用时经 reserveAiTtsUsage 预留一次 `ai` 口径额度，
 * TTS 调用成功时经 settleAiTtsReservation 登记 agentCount，失败或取消时只释放预留；tts 门面
 * （aiChat/provider.ts）对 `operator` 请求在发起供应商请求前经 claimOperatorTtsUsage 登记
 * reserveCount。超出对应上限时拒绝；AI 回复的提示词与语音工具回执经
 * aiTtsRemaining 读取模型可见余量（按 `agent.tts` 的 `ai` 口径计算，在途预留计入已用）。
 *
 * 权威值在 cache/workers/aiChat/ttsUsage.ts；每次登记后以 ttsUsage 事件把新值交给主线程，
 * 由主线程写进 memory/global/state.json 的 `ttsUsage`，并在 Worker 启动与崩溃重建时经
 * hydrateTtsUsage 灌回。
 *
 * 所属线程：AI 闲聊 Worker。线程与持久化顺序见 docs/cn/04-invariants.md。
 */

import { pendingAiTtsReservations, ttsDailyUsage } from "../../cache/workers/aiChat/ttsUsage";
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

/** 按 scope 在当前窗口上加一次计数并回传全量计数；窗口过期或从没用过时两项计数从零起步，以 now 开始新窗口。 */
function recordTtsUsage(scope: TtsQuotaScope, now: number): void {
  const current: TtsDailyUsage | null = activeTtsUsage(ttsDailyUsage.current, now);
  const usage: TtsDailyUsage = {
    windowStartedAt: current?.windowStartedAt ?? now,
    agentCount: (current?.agentCount ?? 0) + (scope === "ai" ? 1 : 0),
    reserveCount: (current?.reserveCount ?? 0) + (scope === "operator" ? 1 : 0),
  };
  ttsDailyUsage.current = usage;
  self.postMessage({ type: "ttsUsage", usage } satisfies AiTtsUsageEvent);
}

/** 窗口内已登记的 agentCount 加在途预留。 */
function aiTtsUsed(now: number): number {
  return (activeTtsUsage(ttsDailyUsage.current, now)?.agentCount ?? 0) + pendingAiTtsReservations.current;
}

/**
 * 登记一次 `operator` 口径的合成请求：只检查并增加 reserveCount，达到 dailyLimit 时不改状态；
 * 登记后回传全量计数。
 */
export function claimOperatorTtsUsage(dailyLimit: number, now: number = Date.now()): boolean {
  if ((activeTtsUsage(ttsDailyUsage.current, now)?.reserveCount ?? 0) >= dailyLimit) return false;
  recordTtsUsage("operator", now);
  return true;
}

/**
 * AI 语音工具准入时预留一次 `ai` 口径额度：已登记数加在途预留达到 dailyLimit 时拒绝。预留只在
 * 内存里，不改 agentCount、不落盘；每次成功预留都必须恰好经 settleAiTtsReservation 结清一次。
 */
export function reserveAiTtsUsage(dailyLimit: number, now: number = Date.now()): boolean {
  if (aiTtsUsed(now) >= dailyLimit) return false;
  pendingAiTtsReservations.current++;
  return true;
}

/**
 * 结清一次预留：TTS 调用成功时按 `ai` 口径登记并回传全量计数（预留已占位，不再检查上限），
 * 失败、取消或意外异常时只释放。
 */
export function settleAiTtsReservation(succeeded: boolean, now: number = Date.now()): void {
  pendingAiTtsReservations.current--;
  if (succeeded) recordTtsUsage("ai", now);
}

/**
 * AI 语音工具此刻还能发起的次数：本 isolate 当前 `agent.tts` 的 `ai` 口径上限减去窗口内
 * agentCount 与在途预留，不小于 0；reserveCount 不占 AI 额度；`agent.tts` 缺省时为 0。
 */
export function aiTtsRemaining(now: number = Date.now()): number {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined) return 0;
  return Math.max(0, ttsQuotaLimit(tts, "ai") - aiTtsUsed(now));
}
