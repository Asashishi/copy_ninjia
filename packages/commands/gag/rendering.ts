import { InlineKeyboard } from "grammy";
import {
  GAG_DEFAULT_DURATION_MINUTES,
  GAG_DEFAULT_TOOL,
  GAG_DURATION_MINUTES,
  GAG_DURATION_TOKEN_PATTERN,
  GAG_FILLER_SUFFIX,
  GAG_INLINE_QUERY_MAX_CHARS,
  GAG_INLINE_QUERY_PREFIX,
  GAG_INLINE_SPEAK_BUTTON_TEXT,
  GAG_PRIMARY_FILLER,
  GAG_PRIMARY_FILLER_PROBABILITY,
  GAG_SECONDARY_FILLERS,
} from "../../consts/gag";
import {
  CHAT_ID_ARG_PATTERN,
  USER_ID_ARG_PATTERN,
  USERNAME_ARG_PATTERN,
} from "../../consts/commands";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import type {
  GagDurationMinutes,
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
 * 构造开始提示的发言入口。频道必须直接携带频道 id 进入 inline，最终再核对
 * sender_chat；普通用户的提示本身已由 receiver_user_id 限定，使用无前缀入口。
 */
export function buildGagSpeakKeyboard(targetId: number): InlineKeyboard {
  if (targetId > 0) {
    return new InlineKeyboard().switchInlineCurrent(
      GAG_INLINE_SPEAK_BUTTON_TEXT,
      ""
    );
  }
  return new InlineKeyboard().switchInlineCurrent(
    GAG_INLINE_SPEAK_BUTTON_TEXT,
    `${GAG_INLINE_QUERY_PREFIX}${targetId} `
  );
}

/**
 * 解析频道按钮预填的查询。频道 id 必须是规范负数；缺失或伪造的保留前缀
 * 由 gag inline 入口静默认领为空结果，不能退回其它 inline 领域。
 */
export function parseGagInlineQuery(
  query: string
): ParsedGagInlineQuery | undefined {
  if (!query.startsWith(GAG_INLINE_QUERY_PREFIX)) return undefined;
  const idStart: number = GAG_INLINE_QUERY_PREFIX.length;
  const separatorIndex: number = query.indexOf(" ", idStart);
  const idEnd: number = separatorIndex === -1 ? query.length : separatorIndex;
  const rawId: string = query.slice(idStart, idEnd);
  const numericId: number = Number(rawId);
  if (!CHAT_ID_ARG_PATTERN.test(rawId) || !Number.isSafeInteger(numericId)) {
    return undefined;
  }
  return {
    targetChannelId: numericId,
    text: separatorIndex === -1 ? "" : query.slice(separatorIndex + 1),
  };
}

/**
 * 按约定抽一个填充词：`...` 占 50%，其余五项各占 10%；半角空格不参与
 * 抽样，而是在每次抽样结果后固定追加。
 */
function randomGagFiller(random: () => number): string {
  const roll: number = random();
  if (roll < GAG_PRIMARY_FILLER_PROBABILITY) return GAG_PRIMARY_FILLER;
  const secondaryRange: number = 1 - GAG_PRIMARY_FILLER_PROBABILITY;
  const scaled: number = (roll - GAG_PRIMARY_FILLER_PROBABILITY) /
    secondaryRange;
  const index: number = Math.min(
    GAG_SECONDARY_FILLERS.length - 1,
    // 0.7 等十进制边界用二进制浮点表示时可能略小于整数分界；只把数值
    // 误差抬回边界，不改变任何非边界区间的概率。
    Math.max(0, Math.floor(
      scaled * GAG_SECONDARY_FILLERS.length + Number.EPSILON * 8
    ))
  );
  return GAG_SECONDARY_FILLERS[index]!;
}

/**
 * 把 inline 查询正文渲染成 gag 发言。按扩展字形簇而不是 UTF-16 码元遍历，
 * emoji/组合字符不会被拆开；每个原文字形后都固定跟「随机填充词 + 半角空格」。
 */
export function renderGagSpeech({
  text,
  tool,
  random = Math.random,
}: RenderGagSpeechOptions): string {
  const normalized: string = sanitizeInline(text);
  let rendered: string = gagSpeechPrefix(tool);
  if (normalized.length === 0) {
    return `${rendered}${GAG_PRIMARY_FILLER}${GAG_FILLER_SUFFIX}`;
  }
  const graphemes: string[] = splitGraphemes(normalized);
  for (const grapheme of graphemes) {
    rendered += grapheme + randomGagFiller(random) + GAG_FILLER_SUFFIX;
  }
  return rendered;
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
  const perCharacterMax: number = 1 + GAG_PRIMARY_FILLER.length +
    GAG_FILLER_SUFFIX.length;
  return prefixLength + GAG_INLINE_QUERY_MAX_CHARS * perCharacterMax <=
    TELEGRAM_MESSAGE_MAX_CHARS;
}
