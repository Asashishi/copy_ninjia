/**
 * 「已经开着的功能，前提必须齐备」的启动闸。
 *
 * 可选功能的凭据与部署配置不再在启动阶段统一预热（见 config/readiness.ts）：
 * 谁都没开的功能缺了前提，只该关掉它自己，不该让 copy、抽奖、入群验证、黑名单
 * 一起离线。但**已经开着**是另一回事——`state.json` 里那个 `true` 是管理员当初
 * 明确按下的，把它悄悄降级成「静默不干活」，群里看到的就是机器人从某次重启起
 * 再也不闲聊/不抓广告/不翻译，而日志里只有一行谁也没在看的诊断。
 *
 * 因此这道闸只对**当前状态里确实开着**的功能生效，缺前提就按老规矩拒绝启动，
 * 让进程管理器把失败暴露出来。运维有两条出路，报错里都写着：补回前提，或者
 * 直接改 `state.json` 把那个开关关掉。
 *
 * 位置在 loadState 之后、Telegram 客户端与任何 Worker 之前（见 app/lifecycle.ts）：
 * 判定要读群状态，而失败时只该有实例锁需要释放。
 */

import { adDetectConfigReadiness, aiChatConfigReadiness, jaTranslateConfigReadiness } from "../config/readiness";
import { AD_DETECT_DEEPSEEK_API_KEY, AI_CHAT_GEMINI_API_KEY } from "../infra/config";
import { getAllChatStates } from "../infra/storage/stateStore";
import type { ConfigReadiness } from "../types/config";

/** 单个可选功能的启动前提；requirement 返回缺失说明（英文），齐备时返回 null。 */
interface FeaturePrerequisite {
  /** 出现在错误信息里的功能名。 */
  readonly feature: string;
  /** ChatState 上表示「本群开着」的布尔字段。 */
  readonly toggle: "isAIChatEnabled" | "isAdDetectEnabled" | "isJATranslationEnabled";
  /** 关掉它的命令名，写进错误信息给运维当出路。 */
  readonly disableCommand: string;
  readonly requirement: () => string | null;
}

/** 把 readiness 的失败收敛成一句缺失说明。 */
function describeReadiness(readiness: ConfigReadiness): string | null {
  return readiness.ok ? null : `${readiness.failure.file} is unusable (${readiness.failure.reason})`;
}

const FEATURE_PREREQUISITES: readonly FeaturePrerequisite[] = [
  {
    feature: "AI chat",
    toggle: "isAIChatEnabled",
    disableCommand: "/ai_chat disable",
    requirement: (): string | null => AI_CHAT_GEMINI_API_KEY === undefined
      ? "AI_CHAT_GEMINI_API_KEY is not set"
      : describeReadiness(aiChatConfigReadiness()),
  },
  {
    feature: "Ad detection",
    toggle: "isAdDetectEnabled",
    disableCommand: "/ad_detect disable",
    requirement: (): string | null => AD_DETECT_DEEPSEEK_API_KEY === undefined
      ? "AD_DETECT_DEEPSEEK_API_KEY is not set"
      : describeReadiness(adDetectConfigReadiness()),
  },
  {
    feature: "Japanese translation",
    toggle: "isJATranslationEnabled",
    disableCommand: "/ja_copy disable",
    requirement: (): string | null => describeReadiness(jaTranslateConfigReadiness()),
  },
];

/** 收集当前状态里开着某个功能的群 id。 */
function chatsWithToggle(toggle: FeaturePrerequisite["toggle"]): number[] {
  const chatIds: number[] = [];
  for (const [chatId, state] of getAllChatStates()) {
    if (state[toggle] === true) chatIds.push(chatId);
  }
  return chatIds;
}

/**
 * 逐个功能核对；任一「开着但前提缺失」立刻抛出，由 ApplicationLifecycle 的
 * 失败路径释放实例锁。全部通过时静默返回。
 *
 * 一次只报第一个：三个功能同时坏掉的概率远低于「运维照着第一条改完再重启」，
 * 而把三条堆进一个异常只会让真正要修的那一条更难认。
 */
export function preflightEnabledFeatures(): void {
  for (const prerequisite of FEATURE_PREREQUISITES) {
    const chatIds: number[] = chatsWithToggle(prerequisite.toggle);
    if (chatIds.length === 0) continue;
    const missing: string | null = prerequisite.requirement();
    if (missing === null) continue;
    throw new Error(
      `${prerequisite.feature} is enabled in ${chatIds.length} chat(s) (${chatIds.join(", ")}) but ${missing}. ` +
      `Restore it, or turn the feature off with ${prerequisite.disableCommand} before removing it.`
    );
  }
}
