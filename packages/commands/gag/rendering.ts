import { InlineKeyboard } from "grammy";
import {
  GAG_DEFAULT_DURATION_MINUTES,
  GAG_DEFAULT_TOOL,
  GAG_DURATION_MINUTES,
  GAG_DURATION_TOKEN_PATTERN,
  GAG_FILLER_DOT,
  GAG_FILLER_GAP_SPACE_PROBABILITY,
  GAG_FILLER_MAX_CHARS,
  GAG_FILLER_MAX_DOTS,
  GAG_FILLER_MIN_DOTS,
  GAG_FILL_OPERATION_PROBABILITY,
  GAG_INLINE_QUERY_MAX_CHARS,
  GAG_INLINE_QUERY_PREFIX,
  GAG_INLINE_SPEAK_BUTTON_TEXT,
  GAG_MAX_CONSECUTIVE_SAME_OPERATIONS,
  GAG_MIN_OPERATION_TIERS,
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
 * 构造开始提示的发言入口。查询 scope 的唯一语法是 `gag:<目标 ID>`；用户与
 * 频道都不得追加摘要、随机 token、群 ID 或其它载荷。Telegram 不把当前具体群 ID
 * 放进 InlineQuery，任何追加值也无法证明实际输入群；群绑定必须留给隐藏 marker
 * 和落群后的 from.id/sender_chat.id、message.chat.id 校验。无前缀查询进入运势。
 */
export function buildGagSpeakKeyboard(session: GagSession): InlineKeyboard {
  return new InlineKeyboard().switchInlineCurrent(
    GAG_INLINE_SPEAK_BUTTON_TEXT,
    `${GAG_INLINE_QUERY_PREFIX}${session.targetId} `
  );
}

/**
 * 解析 gag 按钮预填查询。首个空格前只接受规范的安全整数 ID；ID 后的摘要、
 * token、群 ID 或任意其它 scope 后缀必须拒绝。形态错误的保留前缀由 gag
 * 静默认领为空结果，不能退回运势。
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
  const targetId: number = Number(scope);
  if (
    (!USER_ID_ARG_PATTERN.test(scope) && !CHAT_ID_ARG_PATTERN.test(scope)) ||
    !Number.isSafeInteger(targetId)
  ) return undefined;
  return { targetId, text };
}

/** 在 25% 替换候选内均匀抽取一个字符。 */
function randomGagReplacement(random: () => number): string {
  const roll: number = random();
  const index: number = Math.min(
    GAG_REPLACEMENT_CHARACTERS.length - 1,
    Math.max(0, Math.floor(roll * GAG_REPLACEMENT_CHARACTERS.length))
  );
  return GAG_REPLACEMENT_CHARACTERS[index]!;
}

/** 随机生成 3~6 个点，并对每个点间空隙独立抽取 1/3 的插空格概率。 */
function randomGagFiller(random: () => number): string {
  const range: number = GAG_FILLER_MAX_DOTS - GAG_FILLER_MIN_DOTS + 1;
  const offset: number = Math.min(
    range - 1,
    Math.max(0, Math.floor(random() * range))
  );
  const dotCount: number = GAG_FILLER_MIN_DOTS + offset;
  let filler: string = GAG_FILLER_DOT;
  for (let index: number = 1; index < dotCount; index += 1) {
    if (random() < GAG_FILLER_GAP_SPACE_PROBABILITY) filler += " ";
    filler += GAG_FILLER_DOT;
  }
  return filler;
}

/** 按扩展字形数返回短文本操作保底；单字操作一次，超过 64 个字形不设保底。 */
export function gagMinimumOperationCount(graphemeCount: number): number {
  if (graphemeCount <= 0) return 0;
  if (graphemeCount === 1) return 1;
  for (const [upperExclusive, minimumOperations] of GAG_MIN_OPERATION_TIERS) {
    if (graphemeCount < upperExclusive) return minimumOperations;
  }
  return 0;
}

type GagSpeechOperation = "fill" | "replace";

/**
 * 把 inline 查询正文渲染成 gag 发言。按扩展字形簇而不是 UTF-16 码元遍历。
 * 每个字形先按 75%/25% 抽取填充或替换；同类操作连续两次后，第三次候选会
 * 保留原字形并重置连续计数。只有跳过后无法达到短文本保底时才强制改走另一类。
 * 填充生成 3~6 个点，每个点间独立有 1/3 概率插入空格；组合字符不会被拆开。
 */
export function renderGagSpeech({
  text,
  tool,
  random = Math.random,
}: RenderGagSpeechOptions): string {
  const normalized: string = sanitizeInline(text);
  let rendered: string = gagSpeechPrefix(tool);
  if (normalized.length === 0) {
    return `${rendered}${randomGagFiller(random)}`;
  }
  const graphemes: string[] = splitGraphemes(normalized);
  const minimumOperations: number = gagMinimumOperationCount(graphemes.length);
  let previousOperation: GagSpeechOperation | undefined;
  let consecutiveOperations: number = 0;
  let operationCount: number = 0;
  for (let index: number = 0; index < graphemes.length; index += 1) {
    const grapheme: string = graphemes[index]!;
    const roll: number = random();
    const candidate: GagSpeechOperation =
      roll < GAG_FILL_OPERATION_PROBABILITY ? "fill" : "replace";
    let operation: GagSpeechOperation | undefined = candidate;
    if (
      candidate === previousOperation &&
      consecutiveOperations >= GAG_MAX_CONSECUTIVE_SAME_OPERATIONS
    ) {
      const remainingGraphemes: number = graphemes.length - index - 1;
      if (operationCount + remainingGraphemes >= minimumOperations) {
        operation = undefined;
      } else {
        operation = candidate === "fill" ? "replace" : "fill";
      }
    }
    if (operation === undefined) {
      rendered += grapheme;
      previousOperation = undefined;
      consecutiveOperations = 0;
      continue;
    }
    if (operation === previousOperation) {
      consecutiveOperations += 1;
    } else {
      previousOperation = operation;
      consecutiveOperations = 1;
    }
    operationCount += 1;
    if (operation === "fill") {
      rendered += grapheme + randomGagFiller(random);
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
  const perCharacterMax: number = 1 + GAG_FILLER_MAX_CHARS;
  return prefixLength + GAG_INLINE_QUERY_MAX_CHARS * perCharacterMax <=
    TELEGRAM_MESSAGE_MAX_CHARS;
}
