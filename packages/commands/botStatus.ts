import type { CommandContext, Context } from "grammy";
import { activeGagSessionCount } from "../cache/main/gag";
import { getAdDetectAgentConfig, getAgentDeploymentConfig } from "../config/agent";
import { adDetectConfigReadiness, aiChatConfigReadiness } from "../config/readiness";
import {
  BOT_STATUS_BYTES_PER_GIB,
  BOT_STATUS_BYTES_PER_KIB,
  BOT_STATUS_BYTES_PER_MIB,
  BOT_STATUS_DECIMAL_PLACES,
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
import type {
  AdDetectAgentConfig,
  AgentCapabilityConfig,
  AgentDeploymentConfig,
} from "../types/config";
import { formatUserLabel } from "../users/userLabel";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";

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

/** 只展示 provider/model，不输出 api_key、base_url 或配置失败细节。 */
export function buildBotStatusText(snapshot: BotStatusSnapshot): string {
  const lines: string[] = [
    "本天才的状态，杂鱼可要看仔细啦♡",
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
    `Telegram 出站：处理中 ${snapshot.telegramActive}，429 退避排队 ` +
      `${snapshot.telegramPending}/${snapshot.telegramCapacity}`,
    `正在被本天才调教的杂鱼：${snapshot.activeGagSessions}/${GAG_SESSION_MAX}`,
    "",
    "本机进程，本天才当然精神得很♡：",
    `• Bot 运行时长：${formatBotUptime(snapshot.processStatus.uptimeSeconds)}`,
    `• CPU：${formatPercent(snapshot.processStatus.averageCpuPercent)}`,
    snapshot.processStatus.memoryLimitBytes > 0
      ? `• 内存 RSS：${formatBotMemory(snapshot.processStatus.rssBytes)} / ` +
        `${formatBotMemory(snapshot.processStatus.memoryLimitBytes)}` +
        `（${formatPercent(snapshot.processStatus.memoryPercent)}）`
      : `• 内存 RSS：${formatBotMemory(snapshot.processStatus.rssBytes)}（本机上限不可用）`,
    "",
    "本群已开启，连这个都记不住吗，笨蛋♡："
  );
  const features: string[] = enabledGroupFeatures(snapshot.chatState);
  if (features.length === 0) lines.push("• 无");
  else {
    for (const feature of features) lines.push(`• ${feature}`);
  }
  return lines.join("\n");
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
  const text: string = buildBotStatusText({
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
    text,
    replyToMessageId: ctx.msgId,
  });
}
