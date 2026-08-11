import { InlineKeyboard } from "grammy";
import {
  GAG_DEFAULT_DURATION_MINUTES,
  GAG_DEFAULT_TOOL,
  GAG_DURATION_MINUTES,
  GAG_DURATION_TOKEN_PATTERN,
  GAG_ELLIPSIS_FILLER,
  GAG_ELLIPSIS_PROBABILITY,
  GAG_INLINE_QUERY_MAX_CHARS,
  GAG_INLINE_QUERY_PREFIX,
  GAG_INLINE_SPEAK_BUTTON_TEXT,
  GAG_INLINE_TOKEN_BYTES,
  GAG_INLINE_TOKEN_PATTERN,
  GAG_INLINE_TOKEN_SEPARATOR,
  GAG_REPLACEMENT_CHARACTERS,
} from "../../consts/gag";
import {
  CHAT_ID_ARG_PATTERN,
  USER_ID_ARG_PATTERN,
  USERNAME_ARG_PATTERN,
} from "../../consts/commands";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import type {
  GagDurationMinutes,
  GagSession,
  ParsedGagCommand,
  ParsedGagInlineQuery,
  RenderGagSpeechOptions,
} from "../../types/gag";
import { sanitizeDisplayName, sanitizeInline, splitGraphemes } from "../../libs/text";

/** inline 文本开头的唯一格式；消息落群时复用它核对当前用具。 */
export function gagSpeechPrefix(tool: string): string {
  return `（透过${tool}）`;
}

/**
 * 生成一条会话的 inline 令牌。频道入口靠它绑定「看得见群内按钮的人」，
 * 理由见 consts/gag.ts 的 GAG_INLINE_TOKEN_BYTES。
 */
export function createGagInlineToken(): string {
  const bytes: Uint8Array = new Uint8Array(GAG_INLINE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let token: string = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

/**
 * 构造开始提示的发言入口。普通用户按钮只携带 gag 保留前缀并在查询时核对
 * 查询者 id；频道身份额外携带频道 id 与会话令牌，再在消息落群后核对 sender_chat。
 * 令牌只出现在按钮预填里，不进 inline 结果文本、也不进 text_link 标记——那条
 * 标记随消息公开可见，把令牌写进去等于当众发放。
 * 无前缀查询始终进入运势，两个 inline 领域不能同时应答。
 */
export function buildGagSpeakKeyboard(session: GagSession): InlineKeyboard {
  if (session.targetId > 0) {
    return new InlineKeyboard().switchInlineCurrent(
      GAG_INLINE_SPEAK_BUTTON_TEXT,
      `${GAG_INLINE_QUERY_PREFIX} `
    );
  }
  return new InlineKeyboard().switchInlineCurrent(
    GAG_INLINE_SPEAK_BUTTON_TEXT,
    `${GAG_INLINE_QUERY_PREFIX}${session.targetId}` +
    `${GAG_INLINE_TOKEN_SEPARATOR}${session.inlineToken} `
  );
}

/**
 * 解析 gag 按钮预填的查询。普通用户在前缀后直接跟正文；频道入口额外携带
 * 规范负数 id 与会话令牌，两者缺一即视为伪造。伪造的保留前缀由 gag 静默认领为
 * 空结果，不能退回运势。
 */
export function parseGagInlineQuery(
  query: string
): ParsedGagInlineQuery | undefined {
  if (!query.startsWith(GAG_INLINE_QUERY_PREFIX)) return undefined;
  const scopeStart: number = GAG_INLINE_QUERY_PREFIX.length;
  const separatorIndex: number = query.indexOf(" ", scopeStart);
  const scopeEnd: number = separatorIndex === -1 ? query.length : separatorIndex;
  const scope: string = query.slice(scopeStart, scopeEnd);
  const text: string = separatorIndex === -1 ? "" : query.slice(separatorIndex + 1);
  if (scope.length === 0) return { text };
  const tokenIndex: number = scope.indexOf(GAG_INLINE_TOKEN_SEPARATOR);
  if (tokenIndex === -1) return undefined;
  const rawId: string = scope.slice(0, tokenIndex);
  const token: string = scope.slice(tokenIndex + GAG_INLINE_TOKEN_SEPARATOR.length);
  const numericId: number = Number(rawId);
  if (
    !CHAT_ID_ARG_PATTERN.test(rawId) ||
    !Number.isSafeInteger(numericId) ||
    !GAG_INLINE_TOKEN_PATTERN.test(token)
  ) {
    return undefined;
  }
  return { targetChannelId: numericId, token, text };
}

/** 在 25% 替换分支内均匀抽取一个候选字符。 */
function randomGagReplacement(random: () => number): string {
  const roll: number = random();
  const index: number = Math.min(
    GAG_REPLACEMENT_CHARACTERS.length - 1,
    Math.max(0, Math.floor(roll * GAG_REPLACEMENT_CHARACTERS.length))
  );
  return GAG_REPLACEMENT_CHARACTERS[index]!;
}

/**
 * 把 inline 查询正文渲染成 gag 发言。按扩展字形簇而不是 UTF-16 码元遍历：
 * 75% 在原字形后紧邻追加省略号，剩余 25% 用随机候选字符替换整个原字形。
 * 两个分支都不追加空格，emoji/组合字符也不会被拆开。
 */
export function renderGagSpeech({
  text,
  tool,
  random = Math.random,
}: RenderGagSpeechOptions): string {
  const normalized: string = sanitizeInline(text);
  let rendered: string = gagSpeechPrefix(tool);
  if (normalized.length === 0) {
    return `${rendered}${GAG_ELLIPSIS_FILLER}`;
  }
  const graphemes: string[] = splitGraphemes(normalized);
  for (const grapheme of graphemes) {
    const roll: number = random();
    if (roll < GAG_ELLIPSIS_PROBABILITY) {
      rendered += grapheme + GAG_ELLIPSIS_FILLER;
    } else {
      rendered += randomGagReplacement(random);
    }
  }
  return rendered;
}

/** 群内公开状态文案；普通用户无按钮，频道入口直接附在这条消息上。 */
export function renderGagPublicNotice(session: GagSession): string {
  return `哼哼，${session.targetLabel} 这只爱乱说话的杂鱼已经戴上 ${session.tool} 啦♡ ` +
    `${session.durationMinutes} 分钟内文本消息和带文字说明的媒体消息都会被本天才删掉，` +
    "没有文字的媒体不受影响。" +
    (session.targetId < 0
      ? "频道马甲想说话就必须先乖乖点下面的「发言」按钮，直接 @ 本天才可不会给你选项哦，连入口都找不到的杂鱼就安静待着吧♡"
      : "");
}

/** 发言入口随目标身份选择公开频道文案或仅用户可见的短提示。 */
export function renderGagSpeakNotice(session: GagSession): string {
  return session.targetId < 0
    ? renderGagPublicNotice(session)
    : `${session.targetLabel}，只有你看得到这个发言入口；` +
      "想说话就乖乖点下面的「发言」按钮啦♡";
}

/** 只接受三个离散分钟值，不把其它时长猜成最近一档。 */
function parseGagDuration(token: string | undefined): GagDurationMinutes | undefined {
  if (token !== "5" && token !== "10" && token !== "15") return undefined;
  const duration: number = Number(token);
  return GAG_DURATION_MINUTES.includes(duration as GagDurationMinutes)
    ? duration as GagDurationMinutes
    : undefined;
}

/** 识别命令参数里明确写出的目标；用户名必须按对外语法携带 `@`。 */
function isExplicitGagTarget(token: string): boolean {
  return USER_ID_ARG_PATTERN.test(token) || CHAT_ID_ARG_PATTERN.test(token) ||
    (token.startsWith("@") && USERNAME_ARG_PATTERN.test(token));
}

/**
 * 把命令参数拆成目标、可选时长与任意自由文本用具。回复模式下首项直接作为
 * 时长/用具；非回复模式必须先给显式目标。省略时长固定取 5 分钟。
 */
export function parseGagCommand(
  raw: string,
  hasReplyTarget: boolean = false
): ParsedGagCommand | undefined {
  const normalized: string = sanitizeInline(raw);
  const tokens: string[] = normalized.length === 0 ? [] : normalized.split(" ");
  const firstToken: string | undefined = tokens[0];
  let rawTarget: string = "";
  let argumentIndex: number = 0;
  if (!hasReplyTarget) {
    if (firstToken === undefined || !isExplicitGagTarget(firstToken)) return undefined;
    rawTarget = firstToken;
    argumentIndex = 1;
  } else if (
    firstToken !== undefined &&
    firstToken.startsWith("@") &&
    isExplicitGagTarget(firstToken)
  ) {
    // 保留“回复某人又显式写同一 @username”的既有无害重复语义；裸数字在回复
    // 模式下一律属于时长位置，避免 `/gag 7` 被误解成第二个目标。
    rawTarget = firstToken;
    argumentIndex = 1;
  }
  const durationToken: string | undefined = tokens[argumentIndex];
  const explicitDuration: GagDurationMinutes | undefined =
    parseGagDuration(durationToken);
  const durationMinutes: GagDurationMinutes =
    explicitDuration ?? GAG_DEFAULT_DURATION_MINUTES;
  if (
    explicitDuration === undefined &&
    durationToken !== undefined &&
    GAG_DURATION_TOKEN_PATTERN.test(durationToken)
  ) {
    return undefined;
  }
  const toolIndex: number = explicitDuration === undefined
    ? argumentIndex
    : argumentIndex + 1;
  const rawTool: string = tokens.slice(toolIndex).join(" ");
  const sanitizedTool: string = sanitizeDisplayName(rawTool);
  return {
    durationMinutes,
    rawTarget,
    tool: sanitizedTool.length === 0 ? GAG_DEFAULT_TOOL : sanitizedTool,
  };
}

/**
 * 用 Telegram 的两个官方长度上限推导当前用具是否能容纳最坏 256 字符查询。
 * 这不是业务侧用具白名单/长度档位；只拒绝必然无法发出的载荷。
 */
export function canRenderMaximumInlineQuery(tool: string): boolean {
  const prefixLength: number = gagSpeechPrefix(tool).length;
  const perCharacterMax: number = 1 + GAG_ELLIPSIS_FILLER.length;
  return prefixLength + GAG_INLINE_QUERY_MAX_CHARS * perCharacterMax <=
    TELEGRAM_MESSAGE_MAX_CHARS;
}
