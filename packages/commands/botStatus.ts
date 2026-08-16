import type { MessageEntity } from "@grammyjs/types";
import type { CommandContext, Context } from "grammy";
import { activeGagSessionCount } from "../cache/main/gag";
import { getAdDetectAgentConfig, getAgentDeploymentConfig } from "../config/agent";
import { adDetectConfigReadiness, aiChatConfigReadiness } from "../config/readiness";
import { BOT_CHAT_PERMISSION_KEYS } from "../consts/botAdmin";
import {
  BOT_STATUS_BYTES_PER_GIB,
  BOT_STATUS_BYTES_PER_KIB,
  BOT_STATUS_BYTES_PER_MIB,
  BOT_STATUS_DECIMAL_PLACES,
  BOT_STATUS_PERMISSION_JSON_INDENT,
  BOT_STATUS_PERMISSION_JSON_LANGUAGE,
  BOT_STATUS_PERMISSION_LABELS,
  BOT_STATUS_SECONDS_PER_DAY,
  BOT_STATUS_SECONDS_PER_HOUR,
  BOT_STATUS_SECONDS_PER_MINUTE,
} from "../consts/botStatus";
import { BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS } from "../consts/commands";
import { GAG_SESSION_MAX } from "../consts/gag";
import { readBotProcessStatus } from "../infra/processStatus";
import { getChatState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { telegramOutboundStats } from "../infra/telegram/outboundGate";
import type { CachedUser, ChatState } from "../types/chatState";
import type { BotProcessStatus } from "../types/botStatus";
import type { BotChatPermissions } from "../types/telegram";
import type {
  AdDetectAgentConfig,
  AgentCapabilityConfig,
  AgentDeploymentConfig,
} from "../types/config";
import { formatUserLabel } from "../users/userLabel";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";

/** `/bot_status` 的完整回执：正文加上权限块的 `pre` 实体。 */
export interface BotStatusMessage {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
}

export interface BotStatusSnapshot {
  readonly aiReady: boolean;
  readonly aiConfig: AgentDeploymentConfig | null;
  readonly adDetectReady: boolean;
  readonly adDetectConfig: AdDetectAgentConfig | null;
  readonly chatState: Readonly<ChatState>;
  readonly telegramActive: number;
  readonly telegramPending: number;
  readonly telegramCapacity: number;
  readonly activeGagSessions: number;
  readonly processStatus: Readonly<BotProcessStatus>;
}

function statusLabel(value: string): string {
  const normalized: string = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS - 1)}…`;
}

function capabilityLine(
  label: string,
  config: AgentCapabilityConfig | undefined
): string {
  if (config === undefined) return `• ${label}：未配置`;
  return `• ${label}：已配置 · ${config.provider} / ${statusLabel(config.model)}`;
}

function enabledGroupFeatures(chatState: Readonly<ChatState>): string[] {
  const features: string[] = [];
  if (chatState.isInitEnabled === true) features.push("机器人监听");
  if (chatState.isAIChatEnabled === true) features.push("AI 闲聊");
  if (chatState.isJATranslationEnabled === true) features.push("日语翻译");
  if (chatState.isAdDetectEnabled === true) features.push("广告检测");
  if (chatState.isFloodControlEnabled === true) features.push("防刷屏禁言");
  if (chatState.isAntiRaidEnabled === true) features.push("入群验证与防冲群");
  if (chatState.isProxySendEnabled === true) features.push("超级管理员消息中转");
  return features;
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
 * 权限快照的展示体：**只列这个群里已经拥有的权限位**，键沿用 Bot API 的英文字段
 * 名，值给该位的中文名。没有的位不出现——「有什么」才是这块要回答的问题，逐项列
 * 出十八个「否」只会把真正有的那几条淹掉。
 *
 * 字段与顺序取自 BOT_CHAT_PERMISSION_KEYS（见 consts/botAdmin.ts），不另写一份
 * 会漂移的清单；缺省的可选权限在快照里已经收敛成布尔值，这里不再区分「没返回」
 * 与「确认没有」。一位都没有时给出空对象，那正是「什么都不能做」的如实回答。
 */
function permissionsJson(permissions: Readonly<BotChatPermissions>): string {
  const display: Record<string, string> = {};
  for (const key of BOT_CHAT_PERMISSION_KEYS) {
    if (permissions[key]) display[key] = BOT_STATUS_PERMISSION_LABELS[key];
  }
  return JSON.stringify(display, null, BOT_STATUS_PERMISSION_JSON_INDENT);
}

/**
 * 只展示 provider/model，不输出 api_key、base_url 或配置失败细节。
 *
 * 权限块用 `pre` 实体标出范围而不是拼 ``` 围栏：本项目的发送边界一律不设
 * parse_mode（见 infra/telegram/actions/messages.ts），围栏只会原样显示成三个
 * 反引号。偏移按 UTF-16 码元计算，与 Telegram 对 entities 的口径一致。
 */
export function buildBotStatusMessage(snapshot: BotStatusSnapshot): BotStatusMessage {
  const lines: string[] = [
    "本天才的状态，杂鱼可要看仔细啦♡",
    "",
    "本机进程，本天才当然精神得很♡：",
    `• CPU：${formatPercent(snapshot.processStatus.averageCpuPercent)}` +
      ` (${snapshot.processStatus.availableCpuCount} Core)`,
    `• Bot 运行时长：${formatBotUptime(snapshot.processStatus.uptimeSeconds)}`,
    snapshot.processStatus.memoryLimitBytes > 0
      ? `• 内存 RSS：${formatBotMemory(snapshot.processStatus.rssBytes)} / ` +
        `${formatBotMemory(snapshot.processStatus.memoryLimitBytes)}` +
        `（${formatPercent(snapshot.processStatus.memoryPercent)}）`
      : `• 内存 RSS：${formatBotMemory(snapshot.processStatus.rssBytes)}（本机上限不可用）`,
    "",
    "全局模型能力，本天才会的可多着呢♡：",
  ];
  if (!snapshot.aiReady || snapshot.aiConfig === null) {
    lines.push("• AI 对话能力：不可用（部署配置未就绪）");
  } else {
    lines.push(capabilityLine("群聊正文", snapshot.aiConfig.text));
    lines.push(capabilityLine("记忆摘要", snapshot.aiConfig.summary));
    lines.push(capabilityLine("媒体理解", snapshot.aiConfig.media));
    lines.push(capabilityLine("图片生成", snapshot.aiConfig.image));
    lines.push(capabilityLine("歌曲生成", snapshot.aiConfig.song));
  }
  lines.push(
    snapshot.adDetectReady && snapshot.adDetectConfig !== null
      ? capabilityLine("广告检测", snapshot.adDetectConfig)
      : "• 广告检测：不可用（部署配置未就绪）"
  );
  lines.push(
    "",
    "Telegram 出站：",
    `• 处理中 ${snapshot.telegramActive}`,
    `• 429 退避排队 ${snapshot.telegramPending}/${snapshot.telegramCapacity}`,
    "",
    `正在被本天才调教的杂鱼：${snapshot.activeGagSessions}/${GAG_SESSION_MAX}`,
    "",
    "本天才在这个群的权柄："
  );
  const permissions: BotChatPermissions | undefined =
    snapshot.chatState.botPermissions;
  const entities: MessageEntity[] = [];
  if (permissions === undefined) {
    // undefined 只表示尚未确证（见 types/chatState.ts）：确认不是管理员时快照仍在，
    // 只是全 false，那种情况照常出 JSON。
    lines.push("• 还没确证呢，等本天才在这个群有了身份再来看吧♡");
  } else {
    const json: string = permissionsJson(permissions);
    entities.push({
      type: "pre",
      offset: `${lines.join("\n")}\n`.length,
      length: json.length,
      language: BOT_STATUS_PERMISSION_JSON_LANGUAGE,
    });
    lines.push(json);
  }
  lines.push("", "本群已开启，连这个都记不住吗，笨蛋♡：");
  const features: string[] = enabledGroupFeatures(snapshot.chatState);
  if (features.length === 0) lines.push("• 无");
  else {
    for (const feature of features) lines.push(`• ${feature}`);
  }
  return { text: lines.join("\n"), entities };
}

/** 处理群内 `/bot_status`；命令正文与其它群命令一致在 30 秒后统一清理。 */
export async function handleBotStatusCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  if (!hasCommandPermission(ctx, "isCanViewBotStatus")) {
    const actor: CachedUser | undefined = resolveCommandActor(ctx);
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: `就 ${actor === undefined ? "哪个杂鱼" : formatUserLabel(actor)} ` +
        "也想看本天才的全局状态？哪来的资格呀，笨蛋♡",
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const aiReady: boolean = aiChatConfigReadiness().ok;
  const adDetectReady: boolean = adDetectConfigReadiness().ok;
  const stats: ReturnType<typeof telegramOutboundStats> = telegramOutboundStats();
  const message: BotStatusMessage = buildBotStatusMessage({
    aiReady,
    aiConfig: aiReady ? getAgentDeploymentConfig() : null,
    adDetectReady,
    adDetectConfig: adDetectReady ? getAdDetectAgentConfig() : null,
    chatState: getChatState(ctx.chat.id),
    telegramActive: stats.active,
    telegramPending: stats.pending,
    telegramCapacity: stats.capacity,
    activeGagSessions: activeGagSessionCount(),
    processStatus: readBotProcessStatus(),
  });
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: message.text,
    entities: message.entities,
    replyToMessageId: ctx.msgId,
  });
}
