import { adDetectSystemPrompts } from "../../../cache/workers/antiRaid/adDetect";
import { adDetectGoogleClientHolder } from "../../../cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../cache/workers/antiRaid/openai";
import { adoptAdSampleConfig } from "../../../config/adSamples";
import { adoptAdDetectAgentConfig } from "../../../config/agent";
import type { AntiRaidAgentConfigMessage } from "../../../types/antiRaid/protocol";

/**
 * Anti-Raid Worker 接管主线程投递的广告检测配置（AntiRaidAgentConfigMessage）；
 * 初始化、Worker 重建与 config/dynamic/ 热重载都走这里，本线程从不读盘。
 *
 * 整体替换 holder 后丢弃按旧快照建立的两家 SDK 客户端，示例清单替换时同时清空
 * system prompt 缓存，下一次判定按新快照重建；在途判定继续持有旧客户端直至
 * 结算。adSamples 为 null 表示广告检测不可用，示例 holder 保持不动。
 */
export function adoptAdDetectConfigMessage(msg: AntiRaidAgentConfigMessage): void {
  adoptAdDetectAgentConfig(msg.adDetect);
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  if (msg.adSamples !== null) {
    adoptAdSampleConfig(msg.adSamples);
    adDetectSystemPrompts.clear();
  }
}
