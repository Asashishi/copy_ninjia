import { adDetectPrompts } from "../../../cache/workers/antiRaid/adDetect";
import { adDetectGeminiContextCache } from "../../../cache/workers/antiRaid/geminiContextCache";
import { adDetectGoogleClientHolder } from "../../../cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../cache/workers/antiRaid/openai";
import { adDetectAnthropicClientHolder } from "../../../cache/workers/antiRaid/anthropic";
import { adoptAdSampleConfig } from "../../../config/adSamples";
import { adDetectAgentConfigSnapshot, adoptAdDetectAgentConfig } from "../../../config/agent";
import type { AntiRaidAgentConfigMessage } from "../../../types/antiRaid/protocol";

/**
 * Anti-Raid Worker 接管主线程投递的广告检测配置（AntiRaidAgentConfigMessage）；
 * 初始化、Worker 重建与 config/dynamic/ 热重载都走这里，本线程从不读盘。
 *
 * 整体替换 holder 后丢弃按旧快照建立的各家 SDK 客户端；agent.ad_detect 有变化时同时丢弃
 * 显式缓存的登记表，下一次判定按新客户端重新扫描。示例清单替换时清空提示词缓存，下一次
 * 判定按新快照重建；在途判定继续持有旧客户端直至结算。adSamples 为 null 表示广告检测
 * 不可用，示例 holder 保持不动。
 */
export function adoptAdDetectConfigMessage(msg: AntiRaidAgentConfigMessage): void {
  if (!Bun.deepEquals(adDetectAgentConfigSnapshot(), msg.adDetect)) adDetectGeminiContextCache.current = null;
  adoptAdDetectAgentConfig(msg.adDetect);
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectAnthropicClientHolder.current = null;
  if (msg.adSamples !== null) {
    adoptAdSampleConfig(msg.adSamples);
    adDetectPrompts.current = null;
  }
}
