import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { Context, NextFunction } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import type { CachedUser } from "../types/chatState";
import {
  CJK_ACTION_COMMAND_PATTERN,
  CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  CJK_ACTION_RATE_LIMIT_WINDOW_MS,
} from "../consts/commands";
import { recentActionCallTimestamps } from "../cache/main/cjkAction";
import { sendCommandMessage } from "../infra/telegram";
import { forumTopicThreadId } from "../libs/forumTopic";
import { tryConsumeSlidingWindow } from "../libs/slidingWindowRateLimit";
import {
  isBotOwnMessage,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../infra/selfSentTracker";
import { resolveSenderIdentity, updateCachedIdentity } from "../users/senderIdentity";
import { formatFullName, formatProfileUrl } from "../users/userLabel";
import { resolveCommandTarget } from "./targetResolution";

/** 一段待拼接的回复文本；带 url 的段会挂上 t.me 链接。 */
interface ActionSegment {
  text: string;
  url: string | undefined;
}

/** 拼好的动作回复：纯文本，外加逐段算好偏移的链接实体。 */
interface ActionMessage {
  text: string;
  entities: MessageEntity[];
}

/** parseCjkActionCommand 的解析结果。 */
export interface CjkActionCommand {
  /** 动作词本身（字数由 CJK_ACTION_COMMAND_PATTERN 限定的中文字），如「咬」「贴贴」。 */
  actionWord: string;
  /** `/咬@BotUsername` 里的定向后缀；没写 @ 时为 undefined。 */
  addressedBotUsername: string | undefined;
  /** 命令词之后的参数原文，已去掉首尾空白；没带参数时为空串。 */
  rawArgument: string;
}

/**
 * 从消息原文解析 `/<动作词>` 动作命令，兼容 `/咬@BotUsername` 写法。
 * 与 bot.hears 用的是同一条正则（CJK_ACTION_COMMAND_PATTERN，见 consts/commands.ts），
 * 能匹配进 handler 的消息在这里必定也能解析出来。
 * @returns 不是中文动作命令时为 undefined。
 */
export function parseCjkActionCommand(text: string | undefined): CjkActionCommand | undefined {
  if (text === undefined) return undefined;
  const match: RegExpExecArray | null = CJK_ACTION_COMMAND_PATTERN.exec(text);
  if (!match) return undefined;
  return {
    actionWord: match[1]!,
    addressedBotUsername: match[2],
    rawArgument: text.slice(match[0].length).trim(),
  };
}

/**
 * 全局滑动窗口配额：不分群、不分用户合并计数（窗口与上限见 consts/commands.ts 的
 * CJK_ACTION_RATE_LIMIT_WINDOW_MS 与 CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW，
 * 队列见 cache/main/cjkAction.ts）。超额立即拒绝、不排队。
 * @param now 当前时刻；默认取墙钟，测试可注入固定值。
 * @returns 仍在配额内为 true，本次调用已记账；超额为 false。
 */
export function tryConsumeCjkActionRateLimit(now: number = Date.now()): boolean {
  return tryConsumeSlidingWindow({
    timestamps: recentActionCallTimestamps,
    windowMs: CJK_ACTION_RATE_LIMIT_WINDOW_MS,
    maxCalls: CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
    now,
  });
}

/**
 * 把各段文本拼成一条消息，并为带链接的段生成 text_link 实体。偏移按 Telegram
 * 的 UTF-16 code unit 口径累计，与 JS 的 String#length 同口径，昵称里的 emoji
 * （代理对）占 2 个单位。
 */
function buildActionMessage(segments: readonly ActionSegment[]): ActionMessage {
  const parts: string[] = [];
  const entities: MessageEntity[] = [];
  let offset: number = 0;
  for (const segment of segments) {
    // 空文本不挂实体：length 为 0 的实体会被 Telegram 拒收。
    if (segment.url !== undefined && segment.text.length > 0) {
      entities.push({ type: "text_link", offset, length: segment.text.length, url: segment.url });
    }
    parts.push(segment.text);
    offset += segment.text.length;
  }
  return { text: parts.join(""), entities };
}

/**
 * 菜单占位项 `/x` 的处理器。`/x` 本身不是动作命令，只用于在命令菜单里展示动作命令
 * 的用法（非 ASCII 命令名进不了菜单，见 consts/atmosphere/teasing/commands.ts 的
 * BOT_COMMANDS）。收到 `/x` 时回复 actionUsage，不放行到普通消息流水线。
 */
export async function handleCjkActionUsageCommand(ctx: Context): Promise<void> {
  const chatId: number | undefined = ctx.chat?.id;
  if (chatId === undefined) return;
  await sendCommandMessage({
    chatId,
    text: chatAtmosphere().NOTICE_TEXTS.actionUsage,
    replyToMessageId: ctx.msg?.message_id,
  });
}

/**
 * 处理 `/<动作词>` 动作命令（`/咬`、`/贴贴`……）：回复「发起人 X了 目标！」，
 * 两个名字都用 first_name last_name 形式，并各自挂上 t.me 主页链接（只有公开
 * username 的人才有链接，其余是纯文本）。链接靠显式 entities 表达，不使用 parse_mode。
 * 目标解析与 /copy、/block 共用 targetResolution.ts：支持回复目标或当前缓存中的
 * 用户名（如 `/咬 @username`）；回复与参数同时给出时必须指向同一身份。
 * 成功动作结果属获授权的长期保留例外，与 `/permission help`、`/permission query`
 * 一样显式设置 preserveInGroup；目标解析失败与 `/x` 用法提示仍走默认自动清理。
 * 命令名只收 ASCII，动作命令拿不到 bot_command 实体，由 bot.hears 按原文匹配；
 * 菜单里的 `/x` 是占位说明项，见 handleCjkActionUsageCommand 与
 * consts/atmosphere/teasing/commands.ts 的 BOT_COMMANDS。
 * @param next 命令并非发给本机器人（`/咬@OtherBot`）或消息形态不符时放行，
 * 回到普通消息流水线。
 */
export async function handleCjkActionCommand(ctx: Context, next: NextFunction): Promise<void> {
  const message: Message | undefined = ctx.msg;
  const chatId: number | undefined = ctx.chat?.id;
  if (!message || chatId === undefined) return next();

  // 只认纯文本，不认 caption：bot.hears 对 text 和 caption 都会匹配，caption 形态在这里
  // next() 放行，回到普通消息流水线（handleIncomingMessageMiddleware）；
  // Telegram 命令也只在 text 上产生 bot_command 实体。
  const command: CjkActionCommand | undefined = parseCjkActionCommand(message.text);
  if (!command) return next();

  // 自发消息门禁必须早于任何输出：本 handler 注册在消息流水线之前，用
  // infra/selfSentTracker.ts 的 isBotOwnMessage 与 waitForBotOwnMessage 自行判定，
  // 机器人自己的消息 next() 放行。
  if (isBotOwnMessage(message)) return next();
  if (needsBotOwnMessageWait(message) && await waitForBotOwnMessage(message)) return next();

  // `/咬@SomeoneElse` 指名了其它机器人时放行。
  if (
    command.addressedBotUsername !== undefined &&
    command.addressedBotUsername.toLowerCase() !== ctx.me.username.toLowerCase()
  ) {
    return next();
  }

  const actor: CachedUser | undefined = resolveSenderIdentity(message);
  if (!actor) return next();
  // 被本 handler 认领的消息不再流经 handleIncomingMessageMiddleware（cacheSender 只在
  // 那里调用），这里用 updateCachedIdentity 补记发起人的身份缓存。
  updateCachedIdentity(actor);

  // 配额在这里消耗：往下每条路径（含目标解析失败的提示）都会发出一条消息。
  // 超额静默丢弃，不 next()。
  if (!tryConsumeCjkActionRateLimit()) return;

  const { actionWord }: CjkActionCommand = command;
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message,
    botUserId: ctx.me.id,
    rawArgument: command.rawArgument,
    messages: {
      missingTarget: chatAtmosphere().NOTICE_TEXTS.actionMissingTarget(actionWord, actionWord),
      invalidUsername: (rawArgument: string): string =>
        chatAtmosphere().NOTICE_TEXTS.actionInvalidTarget(rawArgument, actionWord),
      unknownUsername: (rawUsername: string): string =>
        chatAtmosphere().NOTICE_TEXTS.actionUnknownTarget(rawUsername, actionWord),
      conflictingTarget: (rawArgument: string): string =>
        chatAtmosphere().NOTICE_TEXTS.actionConflictingTarget(rawArgument, actionWord),
      selfTarget: chatAtmosphere().NOTICE_TEXTS.actionSelfTarget(actionWord),
    },
  });
  if (!target) return;

  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const { text, entities }: ActionMessage = buildActionMessage([
    { text: formatFullName(actor, atmosphere), url: formatProfileUrl(actor) },
    { text: ` ${actionWord}了 `, url: undefined },
    { text: formatFullName(target, atmosphere), url: formatProfileUrl(target) },
    { text: "！", url: undefined },
  ]);
  await sendCommandMessage({
    chatId,
    text,
    entities,
    replyToMessageId: message.message_id,
    // 关闭链接预览，t.me 主页链接不展开预览卡片。
    disableLinkPreview: true,
    // 获授权的长期保留例外：仅成功动作结果保留；目标校验提示仍自动清理。
    preserveInGroup: true,
    // 长期保留的内容必须自己带话题（见 SendMessageParams.messageThreadId），
    // 目标校验提示不适用。
    messageThreadId: forumTopicThreadId(message),
  });
}
