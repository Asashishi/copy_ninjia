import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import { activeGagSessionCount } from "../cache/main/gag";
import { TRANSLATE_CHAT_USER_LIMIT } from "../consts/translate";
import { getAdDetectAgentConfig, getAgentDeploymentConfig } from "../config/agent";
import { adDetectConfigReadiness, aiChatConfigReadiness } from "../config/readiness";
import { BOT_CHAT_PERMISSION_KEYS, BOT_CHAT_PERMISSION_LABELS } from "../consts/botAdmin";
import { BOT_STATUS_BYTES_PER_GIB, BOT_STATUS_BYTES_PER_KIB, BOT_STATUS_BYTES_PER_MIB, BOT_STATUS_COLD_MEMORY_WEIGHT, BOT_STATUS_DECIMAL_PLACES, BOT_STATUS_FEATURE_KEYS, BOT_STATUS_HOT_MEMORY_WEIGHT, BOT_STATUS_JSON_INDENT, BOT_STATUS_JSON_LANGUAGE, BOT_STATUS_PERCENT_SCALE, BOT_STATUS_SECONDS_PER_DAY, BOT_STATUS_SECONDS_PER_HOUR, BOT_STATUS_SECONDS_PER_MINUTE } from "../consts/botStatus";

import { BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS } from "../consts/commands";
import { MARKDOWN_V2_PARSE_MODE } from "../consts/telegramMarkdown";
import { escapeMarkdownV2, markdownV2InlineCode, markdownV2Pre } from "../libs/telegramMarkdown";
import { MAX_SUMMARY_ROUNDS, VERBATIM_CONTEXT_MAX } from "../consts/aiChat/memory";
import { aiMemoryUsages } from "../cache/main/aiChat";
import { GAG_SESSION_MAX } from "../consts/gag";
import { readBotProcessStatus } from "../infra/processStatus";
import { getChatState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { telegramOutboundStats } from "../infra/telegram/outboundLifecycle";
import type { AiMemoryUsage } from "../types/aiChat/memory";
import type { CachedUser, ChatState } from "../types/chatState";
import type { BotProcessStatus } from "../types/botStatus";
import type { BotChatPermissions } from "../types/telegram";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  AgentTtsCapabilityConfig,
} from "../types/config";
import { rejectUnlessPermitted } from "./commandActor";

/** `/bot_status` 的完整回执：一段 MarkdownV2 正文。 */
export interface BotStatusMessage {
  readonly text: string;
}

export interface BotStatusSnapshot {
  /** 命令所在会话的 id，展示在本群一组的第一行。 */
  readonly chatId: number;
  readonly aiReady: boolean;
  readonly aiConfig: AgentDeploymentConfig | null;
  readonly adDetectReady: boolean;
  readonly adDetectConfig: AdDetectAgentConfig | null;
  readonly chatState: Readonly<ChatState>;
  readonly telegramActive: number;
  readonly telegramPending: number;
  readonly telegramCapacity: number;
  readonly activeGagSessions: number;
  readonly activeTranslateSessions: number;
  /** 本群 AI 上下文占用量镜像；无条目表示此刻没有可展示的上下文。 */
  readonly aiContextUsage: Readonly<AiMemoryUsage> | undefined;
  readonly processStatus: Readonly<BotProcessStatus>;
}

function statusLabel(value: string): string {
  const normalized: string = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS - 1)}…`;
}

/**
 * 只展示模型名：不带 provider，并去掉模型 id 里最后一个 `/` 之前的厂商命名空间
 * （`openai/gpt-6-luna` 展示为 `gpt-6-luna`）。
 */
function capabilityLine(label: string, model: string): string {
  const modelName: string = model.slice(model.lastIndexOf("/") + 1);
  return `• ${label}：${statusLabel(modelName)}`;
}

/** 语音合成行展示的名字：xai 协议没有模型名，展示音色。 */
function ttsStatusName(tts: AgentTtsCapabilityConfig): string {
  return tts.speechProtocol === "xai" ? tts.voice : tts.model;
}

/** 把进程 uptime 格式化为不会随本地时区变化的天与时分秒。 */
export function formatBotUptime(uptimeSeconds: number): string {
  const totalSeconds: number = Number.isFinite(uptimeSeconds) && uptimeSeconds > 0
    ? Math.floor(uptimeSeconds)
    : 0;
  const days: number = Math.floor(totalSeconds / BOT_STATUS_SECONDS_PER_DAY);
  const remainderAfterDays: number = totalSeconds % BOT_STATUS_SECONDS_PER_DAY;
  const hours: number = Math.floor(remainderAfterDays / BOT_STATUS_SECONDS_PER_HOUR);
  const remainderAfterHours: number = remainderAfterDays % BOT_STATUS_SECONDS_PER_HOUR;
  const minutes: number = Math.floor(remainderAfterHours / BOT_STATUS_SECONDS_PER_MINUTE);
  const seconds: number = remainderAfterHours % BOT_STATUS_SECONDS_PER_MINUTE;
  const clock: string = `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return days === 0 ? clock : `${days} 天 ${clock}`;
}

/** 以最短的二进制单位展示本机内存字节数。 */
export function formatBotMemory(bytes: number): string {
  const safeBytes: number = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes >= BOT_STATUS_BYTES_PER_GIB) {
    return `${(safeBytes / BOT_STATUS_BYTES_PER_GIB).toFixed(BOT_STATUS_DECIMAL_PLACES)} GiB`;
  }
  if (safeBytes >= BOT_STATUS_BYTES_PER_MIB) {
    return `${(safeBytes / BOT_STATUS_BYTES_PER_MIB).toFixed(BOT_STATUS_DECIMAL_PLACES)} MiB`;
  }
  if (safeBytes >= BOT_STATUS_BYTES_PER_KIB) {
    return `${(safeBytes / BOT_STATUS_BYTES_PER_KIB).toFixed(BOT_STATUS_DECIMAL_PLACES)} KiB`;
  }
  return `${Math.floor(safeBytes)} B`;
}

/** 百分比只在展示边界取两位小数，采样快照保留完整精度。 */
function formatPercent(value: number): string {
  const safeValue: number = Number.isFinite(value) && value > 0 ? value : 0;
  return `${safeValue.toFixed(BOT_STATUS_DECIMAL_PLACES)}%`;
}

/**
 * 本群上下文容量：两段记忆各自的占用率按 BOT_STATUS_HOT_MEMORY_WEIGHT /
 * BOT_STATUS_COLD_MEMORY_WEIGHT 加权求和，只给这一个百分比。
 *
 * 分母是两段记忆各自的领域上限（consts/aiChat/memory.ts 的 VERBATIM_CONTEXT_MAX
 * 与 MAX_SUMMARY_ROUNDS），不是模型的 token 预算：这一行（展示名「猫脑子利用率」）
 * 回答的是「本天才还记着这个群多少东西」，而轮换与摘要晋升都按条数触发。
 * 两段的原始条数不外露——
 * 那是记忆分层的内部机制，对群友一律不可见（见 docs/cn/04-invariants.md）。
 *
 * 没有镜像条目就是没有可展示的上下文，按 0 展示而不是沿用旧值（见
 * cache/main/aiChat.ts 的 aiMemoryUsages）。
 */
function contextCapacityLine(usage: Readonly<AiMemoryUsage> | undefined, atmosphere: AtmosphereTexts): string {
  const percent: number = (
    BOT_STATUS_HOT_MEMORY_WEIGHT * ((usage?.bufferedCount ?? 0) / VERBATIM_CONTEXT_MAX) +
    BOT_STATUS_COLD_MEMORY_WEIGHT * ((usage?.summaryCount ?? 0) / MAX_SUMMARY_ROUNDS)
  ) * BOT_STATUS_PERCENT_SCALE;
  return atmosphere.NOTICE_TEXTS.statusContextUsage(formatPercent(percent));
}

/**
 * 权限快照的展示体：**只列这个群里已经拥有的权限位**，键沿用 BotChatPermissions 的
 * 英文字段名，值给该位的中文名。没有的位不出现——「有什么」才是这块要回答的问题，逐项列
 * 出十八个「否」只会把真正有的那几条淹掉。
 *
 * 字段与顺序取自 BOT_CHAT_PERMISSION_KEYS（见 consts/botAdmin.ts），不另写一份
 * 会漂移的清单；缺省的可选权限在快照里已经收敛成布尔值，这里不再区分「没返回」
 * 与「确认没有」。一位都没有时给出空对象，那正是「什么都不能做」的如实回答。
 */
function permissionsJson(permissions: Readonly<BotChatPermissions>): string {
  const display: Record<string, string> = {};
  for (const key of BOT_CHAT_PERMISSION_KEYS) {
    if (permissions[key]) display[key] = BOT_CHAT_PERMISSION_LABELS[key];
  }
  return JSON.stringify(display, null, BOT_STATUS_JSON_INDENT);
}

/**
 * 群功能开关的展示体：**逐项列出本群全部可切换的能力此刻开没开**，键沿用 state 里的
 * 开关字段名，值是布尔。与只列「有什么」的权限块不同——开关一共就这几项，「哪几项是
 * 关的」本身就是这块要回答的问题。
 *
 * 字段与顺序取自 BOT_STATUS_FEATURE_KEYS（见 consts/botStatus.ts）。缺省（从没设过）与
 * 显式关闭都给 false：这块回答的是此刻的生效状态，不区分二者。
 */
function featuresJson(chatState: Readonly<ChatState>): string {
  const display: Record<string, boolean> = {};
  for (const key of BOT_STATUS_FEATURE_KEYS) display[key] = chatState[key] === true;
  return JSON.stringify(display, null, BOT_STATUS_JSON_INDENT);
}

/**
 * 模型能力只列当前可用的模型名（xai 语音协议没有模型名，展示音色）；没有可列项时
 * 省略整段，不输出 provider、api_key、base_url 或配置失败细节。
 *
 * 正文按 MarkdownV2 拼装（见 libs/telegramMarkdown.ts）：本群 id 是内联代码，权限块与功能块
 * 是 json 代码块，其余各段整段转义——模型名、文案里的 `.`、`-`、`(` 都是保留字符。
 */
export function buildBotStatusMessage(snapshot: BotStatusSnapshot): BotStatusMessage {
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const lines: string[] = [
    atmosphere.NOTICE_TEXTS.statusTitle,
    "",
    atmosphere.NOTICE_TEXTS.statusProcess,
    `• CPU：${formatPercent(snapshot.processStatus.averageCpuPercent)}` +
      ` (${snapshot.processStatus.availableCpuCount} Core)`,
    `• Bot 运行时长：${formatBotUptime(snapshot.processStatus.uptimeSeconds)}`,
    snapshot.processStatus.memoryFootprintBytes === null
      ? "• 当前内存占用：不可用"
      : snapshot.processStatus.memoryLimitBytes > 0
      ? `• 当前内存占用：${formatBotMemory(snapshot.processStatus.memoryFootprintBytes)} / ` +
        `${formatBotMemory(snapshot.processStatus.memoryLimitBytes)}` +
        `（${formatPercent(snapshot.processStatus.memoryPercent)}）`
      : `• 当前内存占用：${formatBotMemory(snapshot.processStatus.memoryFootprintBytes)}（本机上限不可用）`,
  ];
  const modelLines: string[] = [];
  if (snapshot.aiReady && snapshot.aiConfig !== null) {
    modelLines.push(capabilityLine("群聊正文", snapshot.aiConfig.text.model));
    modelLines.push(capabilityLine("记忆摘要", snapshot.aiConfig.summary.model));
    modelLines.push(capabilityLine("媒体理解", snapshot.aiConfig.media.model));
    if (snapshot.aiConfig.image !== undefined) {
      modelLines.push(capabilityLine("图片生成", snapshot.aiConfig.image.model));
    }
    if (snapshot.aiConfig.tts !== undefined) {
      modelLines.push(capabilityLine("语音合成", ttsStatusName(snapshot.aiConfig.tts)));
    }
    if (snapshot.aiConfig.webSearch !== undefined) {
      modelLines.push(capabilityLine("联网检索", snapshot.aiConfig.webSearch.model));
    }
  }
  if (snapshot.adDetectReady && snapshot.adDetectConfig !== null) {
    modelLines.push(capabilityLine("广告检测", snapshot.adDetectConfig.model));
  }
  if (modelLines.length > 0) lines.push("", atmosphere.NOTICE_TEXTS.statusModels, ...modelLines);
  lines.push(
    "",
    "Telegram 出站：",
    `• 处理中 ${snapshot.telegramActive}`,
    `• 429 退避排队 ${snapshot.telegramPending}/${snapshot.telegramCapacity}`,
    "",
    atmosphere.NOTICE_TEXTS.statusChatIdLabel
  );
  // 本群一组：id 在前（内联代码，点一下即可复制），其后是上下文、禁言与翻译会话占用。
  const chatGroup: string = [
    "",
    contextCapacityLine(snapshot.aiContextUsage, atmosphere),
    atmosphere.NOTICE_TEXTS.statusGag(snapshot.activeGagSessions, GAG_SESSION_MAX),
    atmosphere.NOTICE_TEXTS.statusTranslate(snapshot.activeTranslateSessions, TRANSLATE_CHAT_USER_LIMIT),
    "",
    atmosphere.NOTICE_TEXTS.statusPermissions,
    "",
  ].join("\n");
  // undefined 只表示尚未确证（见 types/chatState.ts）：确认不是管理员时快照仍在，
  // 只是全 false，那种情况照常出 JSON。
  const permissions: BotChatPermissions | undefined = snapshot.chatState.botPermissions;
  const text: string =
    escapeMarkdownV2(lines.join("\n")) +
    markdownV2InlineCode(String(snapshot.chatId)) +
    escapeMarkdownV2(chatGroup) +
    (permissions === undefined
      ? escapeMarkdownV2(atmosphere.NOTICE_TEXTS.statusPermissionsUnknown)
      : markdownV2Pre(permissionsJson(permissions), BOT_STATUS_JSON_LANGUAGE)) +
    escapeMarkdownV2(`\n\n${atmosphere.NOTICE_TEXTS.statusFeatures}\n`) +
    markdownV2Pre(featuresJson(snapshot.chatState), BOT_STATUS_JSON_LANGUAGE);
  return { text };
}

/** 处理群内 `/bot_status`；命令正文与其它群命令一致在 30 秒后统一清理。 */
export async function handleBotStatusCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanViewBotStatus",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.statusRejected(actorLabel)
  );
  if (actor === undefined) return;
  const aiReady: boolean = aiChatConfigReadiness().ok;
  const adDetectReady: boolean = adDetectConfigReadiness().ok;
  const stats: ReturnType<typeof telegramOutboundStats> = telegramOutboundStats();
  const message: BotStatusMessage = buildBotStatusMessage({
    chatId: ctx.chat.id,
    aiReady,
    aiConfig: aiReady ? getAgentDeploymentConfig() : null,
    adDetectReady,
    adDetectConfig: adDetectReady ? getAdDetectAgentConfig() : null,
    chatState: getChatState(ctx.chat.id),
    telegramActive: stats.active,
    telegramPending: stats.pending,
    telegramCapacity: stats.capacity,
    activeGagSessions: activeGagSessionCount(),
    activeTranslateSessions: getChatState(ctx.chat.id).translate?.length ?? 0,
    aiContextUsage: aiMemoryUsages.get(ctx.chat.id),
    processStatus: readBotProcessStatus(),
  });
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: message.text,
    parseMode: MARKDOWN_V2_PARSE_MODE,
    replyToMessageId: ctx.msgId,
  });
}
