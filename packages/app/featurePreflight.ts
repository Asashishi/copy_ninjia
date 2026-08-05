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
import { AD_DETECT_DEEPSEEK_API_KEY } from "../infra/config";
import { hasAiChatCredentials, hasGeminiChatCredentials, hasOpenAiChatCredentials } from "../aiChat/credentials";
import { getAllChatStates, getChatProviderOverride, getImageProviderOverride } from "../infra/storage/stateStore";
import type { AiProviderName } from "../types/aiChat/provider";
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
    requirement: (): string | null => !hasAiChatCredentials()
      ? "neither AI_CHAT_GEMINI_API_KEY nor AI_CHAT_OPENAI_API_KEY is set"
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

/** 一项全局模型选取的启动前提。 */
interface ModelPrerequisite {
  /** state.json 里的字段路径，直接写进报错让运维知道改哪一行。 */
  readonly path: string;
  /** 写下它的命令名。 */
  readonly command: string;
  /** 当前显式选定的供应商；undefined 表示从没设过，本项不设防。 */
  readonly selected: () => AiProviderName | undefined;
}

/** 一家供应商的 env 名与「有没有」，报错里要点名是哪一把。 */
interface ProviderCredential {
  readonly env: string;
  readonly has: () => boolean;
}

const PROVIDER_CREDENTIALS: Readonly<Record<AiProviderName, ProviderCredential>> = {
  gemini: { env: "AI_CHAT_GEMINI_API_KEY", has: hasGeminiChatCredentials },
  openai: { env: "AI_CHAT_OPENAI_API_KEY", has: hasOpenAiChatCredentials },
};

const MODEL_PREREQUISITES: readonly ModelPrerequisite[] = [
  { path: "state.global.model.image", command: "/image_model", selected: getImageProviderOverride },
  { path: "state.global.model.chat", command: "/chat_model", selected: getChatProviderOverride },
];

/**
 * 全局模型选取的启动闸：**显式选过**的那一家，它的 key 必须在，否则拒绝启动。
 *
 * 与上面那三条同一个道理——`state.global.model` 里的供应商名是超管当初用
 * `/image_model`、`/chat_model` 明确按下的，命令当时还要求两把 key 都在。
 * 之后 key 被从 `.env` 里撤掉，只有两种解释：撤错了，或者忘了先切回去。
 * 两种都该当场说破，而不是静默换一家继续跑——那会让同一个群的回复口径无预警
 * 漂移，正是 aiChat/provider.ts 头注拒绝的事。
 *
 * 从没设过的那一项不设防：缺省本就跟随 activeAiProvider()（默认 Gemini，缺席时
 * 降级 OpenAI），给它设防等于让只配了 OpenAI 一把 key 的部署起不来。
 */
function preflightGlobalModelSelection(): void {
  for (const prerequisite of MODEL_PREREQUISITES) {
    const selected: AiProviderName | undefined = prerequisite.selected();
    if (selected === undefined) continue;
    const credential: ProviderCredential = PROVIDER_CREDENTIALS[selected];
    if (credential.has()) continue;
    throw new Error(
      `${prerequisite.path} is "${selected}" but ${credential.env} is not set. ` +
      `Restore the key, or remove ${prerequisite.path} from state.json to fall back to the default provider ` +
      `(the bot cannot start to accept ${prerequisite.command} while the key is missing).`
    );
  }
}

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
  // 先查全局模型选取：它与「哪个群开着什么」无关，是一条更靠前的硬前提。
  preflightGlobalModelSelection();
  for (const prerequisite of FEATURE_PREREQUISITES) {
    const chatIds: number[] = chatsWithToggle(prerequisite.toggle);
    if (chatIds.length === 0) continue;
    const missing: string | null = prerequisite.requirement();
    if (missing === null) continue;
    throw new Error(
      `${prerequisite.feature} is enabled in ${chatIds.length} chat(s) (${chatIds.join(", ")}) but ${missing}. ` +
      `Restore the prerequisite, or turn the feature off with ${prerequisite.disableCommand} before removing it.`
    );
  }
}
