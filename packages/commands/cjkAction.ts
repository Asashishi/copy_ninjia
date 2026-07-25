import type { Context, NextFunction } from "grammy";
import type { Message, MessageEntity } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import {
  CJK_ACTION_COMMAND_PATTERN,
  CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  CJK_ACTION_RATE_LIMIT_WINDOW_MS,
} from "../consts/commands";
import { recentActionCallTimestamps } from "../cache/cjkAction";
import { sendMessage } from "../infra/telegram";
import { tryConsumeSlidingWindow } from "../libs/slidingWindowRateLimit";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { resolveSenderIdentity, seedSenderCache } from "../users/senderIdentity";
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
  /** 动作字本身，如「咬」。 */
  actionWord: string;
  /** `/咬@BotUsername` 里的定向后缀；没写 @ 时为 undefined。 */
  addressedBotUsername: string | undefined;
  /** 命令词之后的参数原文，已去掉首尾空白；没带参数时为空串。 */
  rawArgument: string;
}

/**
 * 从消息原文解析 `/<单个中文字>` 动作命令，兼容 `/咬@BotUsername` 写法。
 * 与 bot.hears 用的是同一条正则（见 consts/commands.ts），因此能匹配进
 * handler 的消息在这里必定也能解析出来。
 * @returns 不是单字中文动作命令时为 undefined。
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
 * 全局滑动窗口配额：任意一个中文字都能触发动作命令，没有命令菜单那层天然
 * 约束，因此不分群、不分用户合并计数（窗口与上限见 consts/commands.ts，
 * 队列见 cache/cjkAction.ts）。超额立即拒绝、不排队。
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
 * 的 UTF-16 code unit 口径累计，而 JS 的 String#length 正好是同一口径，所以
 * 昵称里的 emoji（代理对）会自然占 2 个单位，不必额外换算。
 */
function buildActionMessage(segments: readonly ActionSegment[]): ActionMessage {
  const parts: string[] = [];
  const entities: MessageEntity[] = [];
  let offset: number = 0;
  for (const segment of segments) {
    // 空文本不能挂实体：Telegram 会以 length 为 0 的实体整条拒收。
    if (segment.url !== undefined && segment.text.length > 0) {
      entities.push({ type: "text_link", offset, length: segment.text.length, url: segment.url });
    }
    parts.push(segment.text);
    offset += segment.text.length;
  }
  return { text: parts.join(""), entities };
}

/**
 * 菜单占位项 `/x` 的处理器。`/x` 自己不是动作命令——它只为把「把 x 换成任意
 * 一个中文字」这个用法曝光进命令菜单（非 ASCII 命令名进不了菜单，见
 * consts/commands.ts 的 BOT_COMMANDS）。但点菜单会真的把 `/x` 发出去，所以它
 * 必须回一句用法：沉默会让用户完全不知道发生了什么；而放行到消息兜底则会让
 * 这条命令被当成普通消息进入 AI/复读流水线，正是注册它要避免的事。
 */
export async function handleCjkActionUsageCommand(ctx: Context): Promise<void> {
  const chatId: number | undefined = ctx.chat?.id;
  if (chatId === undefined) return;
  await sendMessage({
    chatId,
    text: `笨蛋，/x 只是菜单里的用法说明啦——把 x 换成任意一个中文字直接发，比如 /咬、/摸，再回复 TA 的消息或者加 @username 指定对象♡`,
    replyToMessageId: ctx.msg?.message_id,
  });
}

/**
 * 处理 `/<单个中文字>` 动作命令（`/咬`、`/摸`……）：回复「发起人 X了 目标！」，
 * 两个名字都用 first_name last_name 形式，并各自挂上 t.me 主页链接（只有公开
 * username 的人才有链接，其余是纯文本）。链接靠显式 entities 表达而非
 * parse_mode，昵称里的标记字符不会被解析（见 infra/telegram/actions.ts）。
 * 目标解析与 /copy、/kick 共用 targetResolution.ts：回复 TA 的消息优先，
 * 也可以写成 `/咬 @username`（要求本天才此前缓存过该用户）。
 * 动作字进不了 Telegram 命令菜单——命令名只收 ASCII，这类命令也因此拿不到
 * bot_command 实体，只能由 bot.hears 按原文匹配；菜单里的 `/x` 只是一条不做
 * 任何处理的占位说明项，见 consts/commands.ts 的 BOT_COMMANDS。
 * @param next 命令并非发给本机器人（`/咬@OtherBot`）或消息形态异常时放行，
 * 让消息回到普通消息流水线，不被这里静默吞掉。
 */
export async function handleCjkActionCommand(ctx: Context, next: NextFunction): Promise<void> {
  const message: Message | undefined = ctx.msg;
  const chatId: number | undefined = ctx.chat?.id;
  if (!message || chatId === undefined) return next();

  // 只认纯文本，不认 caption。bot.hears 对 text 和 caption 都会匹配，但认领一条
  // 带图消息意味着它不再流进 handleIncomingMessage，那张图就不会进 AI 滚动记忆
  // 与视觉流水线；真正的 Telegram 命令也只在 text 上产生 bot_command 实体。
  // caption 形态在这里 next() 放行，回到普通消息流水线。
  const command: CjkActionCommand | undefined = parseCjkActionCommand(message.text);
  if (!command) return next();

  // 必须早于任何输出：本 handler 注册在消息流水线之前，拿不到它那道自发消息
  // 门禁。机器人在自己管理的频道发的帖子会被原样推回（见 infra/selfSentTracker.ts），
  // 而回复正文里的昵称/频道名可以由对方设成 `/咬` 开头，从而再次匹配本命令，
  // 形成自问自答的刷屏循环。
  if (isBotOwnMessage(message)) return next();

  // 群里可能同时有多个本机器人的实例，`/咬@SomeoneElse` 明确指名了别人。
  if (
    command.addressedBotUsername !== undefined &&
    command.addressedBotUsername.toLowerCase() !== ctx.me.username.toLowerCase()
  ) {
    return next();
  }

  const actor: CachedUser | undefined = resolveSenderIdentity(message);
  if (!actor) return next();
  // 被本 handler 认领的消息不会再流经 handleIncomingMessage，而 cacheSender 只在
  // 那里调用。不在这里补一次，发言以动作命令为主的人就永远进不了 username 缓存，
  // 明明刚在群里说过话，/copy @TA 却会答「都还没说过话呢」。
  seedSenderCache(actor);

  // 配额在这里消耗：往下每条路径（含目标解析失败的嘲讽）都会发出一条消息。
  // 超额静默丢弃，也不再 next()——限流的意义就是不为这条更新做任何输出。
  if (!tryConsumeCjkActionRateLimit()) return;

  const { actionWord }: CjkActionCommand = command;
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message,
    botUserId: ctx.me.id,
    rawArgument: command.rawArgument,
    messages: {
      missingTarget: `笨蛋，要 ${actionWord} 谁呀？回复 TA 的一条消息，或者写成 /${actionWord} @username 再来♡`,
      invalidUsername: (rawArgument: string): string =>
        `笨蛋，${rawArgument} 才不是完整合法的 Telegram 用户名，本天才可不会对着空气 ${actionWord}♡`,
      unknownUsername: (rawUsername: string): string =>
        `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再 ${actionWord} 吧♡`,
      selfTarget: `哼，本天才可不给杂鱼 ${actionWord}，想得美♡`,
    },
  });
  if (!target) return;

  const { text, entities }: ActionMessage = buildActionMessage([
    { text: formatFullName(actor), url: formatProfileUrl(actor) },
    { text: ` ${actionWord}了 `, url: undefined },
    { text: formatFullName(target), url: formatProfileUrl(target) },
    { text: "！", url: undefined },
  ]);
  await sendMessage({
    chatId,
    text,
    entities,
    replyToMessageId: message.message_id,
    // 两个名字都挂了 t.me 链接，不关预览的话每条回复底下都会跟一张主页卡片。
    disableLinkPreview: true,
  });
}
