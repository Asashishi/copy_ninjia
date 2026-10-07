import {
  BIDI_CONTROL_PATTERN,
  INLINE_SANITIZE_REQUIRED_PATTERN,
  INLINE_WHITESPACE_PATTERN,
  LEADING_AT_SIGNS_PATTERN,
} from "../consts/text";
/**
 * 拼进机器人自己文案的那些文本的共用处理：清洗（压成单行、剥双向控制符、
 * 中和可点击命令）、按字形簇切分，以及把 Telegram 的姓名字段拼成展示名。
 *
 * 消费方跨 AI 流水线（aiChat/ai/imageDescription.ts 等）、命令回执
 * （users/userLabel.ts）与消息转录（auto/message/facts.ts）；同一份规则只此一份。
 */

import { neutralizeRenderableCommands } from "./renderableCommand";

/**
 * 把要写进转录的文本压成单行：所有空白串（含换行）折叠为一个空格。
 * 转录按「一行 = 一条消息」拼装，折叠换行后一条消息只占一行；广告判定的提示词
 * （formatAdBundleText 按序号逐行拼装）依同一契约。
 *
 * 未命中 INLINE_SANITIZE_REQUIRED_PATTERN 的规范输入原样返回；命中时折叠空白并去掉首尾空白。
 * 本函数在每条进滚动记忆的消息上调用多次（见 workers/aiChat/bufferedMessage.ts）。
 */
export function sanitizeInline(raw: string): string {
  if (!INLINE_SANITIZE_REQUIRED_PATTERN.test(raw)) return raw;
  return raw.replace(INLINE_WHITESPACE_PATTERN, " ").trim();
}

/**
 * 显示名清洗：剥掉双向控制符、中和可点击命令，再压成单行。
 *
 * 昵称由用户设置，会被拼进机器人撰写的句子，并作为 text_link 的锚文本
 * （见 commands/cjkAction.ts）。所有拼进机器人文案的昵称、频道名、群标题都经由这一入口
 * 统一处理：双向控制符一律剥掉，形如命令的片段由 neutralizeRenderableCommands 中和。
 *
 * 空白折叠的规则与 sanitizeInline 共用。
 */
export function sanitizeDisplayName(raw: string): string {
  return sanitizeInline(neutralizeRenderableCommands(raw.replace(BIDI_CONTROL_PATTERN, "")));
}

/**
 * 去掉用户名前导的 `@`，供转录行、回复标注与逐字缓存条目共用同一份归一规则。
 *
 * Telegram 的 username 字段本身不含 `@`，剥离针对用户手打进来的 @名字与从 mention
 * 实体里切出来的片段。先看首码元，只有带 `@` 时才走正则。这条判定落在每条进滚动记忆的
 * 群消息（workers/aiChat/bufferedMessage.ts）和每次转录渲染的名册与回复标注
 * （aiChat/ai/utils/chatTranscript.ts）上。
 *
 * 空串的 `charCodeAt(0)` 是 NaN，比较为假，原样返回。
 */
export function stripLeadingAtSigns(username: string): string {
  // 0x40 是 `@`。
  return username.charCodeAt(0) === 0x40
    ? username.replace(LEADING_AT_SIGNS_PATTERN, "")
    : username;
}

/**
 * 把 Telegram 的 `first_name` / `last_name` 拼成一个展示名；两段都缺时返回空串。
 *
 * 缺席与空串一律当作「没有这一段」，两段都在时用一个空格分隔；首尾空白由调用方按需
 * `trim`。
 *
 * 直接分支拼接，不创建字面量数组、filter 结果数组或一次性闭包；转发来源标注
 * （auto/message/facts.ts 的 forwardOriginLabel）在每条带 forward_origin 的消息上调用。
 */
export function joinPersonName(
  firstName: string | undefined,
  lastName: string | undefined
): string {
  if (firstName) return lastName ? `${firstName} ${lastName}` : firstName;
  return lastName ?? "";
}

/** 字形簇 Segmenter：模块加载时构造一次，各线程复用自己加载的那份。 */
const GRAPHEME_SEGMENTER: Intl.Segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 按 Unicode 扩展字形簇切分。 */
export function splitGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment: Intl.SegmentData): string => segment.segment);
}

/**
 * 把文本截断到 maxChars 个 UTF-16 码元以内。slice 恰好切在代理对中间（emoji 等）时，
 * 去掉孤立的高位代理。
 */
export function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let truncated: string = text.slice(0, maxChars);
  const lastCode: number = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

/**
 * 句末标点「。！？…～♡」的码元；取值集合与 test/libs/text.test.ts 的对拍用例一致。
 */
function isSentenceEndCode(code: number): boolean {
  return code === 0x3002 || code === 0xff01 || code === 0xff1f ||
    code === 0x2026 || code === 0xff5e || code === 0x2661;
}

/** 子句分隔符「，、；：」的码元；语义同 isSentenceEndCode。 */
function isClauseBreakCode(code: number): boolean {
  return code === 0xff0c || code === 0x3001 || code === 0xff1b || code === 0xff1a;
}

/**
 * 截断到 maxChars 以内，但尽量收在子句边界上，不把句子从中间剁断；用于模型
 * 生成的描述与简介。
 * 规则：先硬切到 maxChars；若切点内能找到句末标点（。！？…～♡），收到
 * 最后一个句末标点为止（含标点）；否则找最后一个子句分隔符（，、；：）
 * 收到它之前（丢掉悬空的分隔符）。边界位置不足上限一半时放弃找边界，退回硬切。
 */
export function truncateAtClauseBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const hardCut: string = truncateInline(text, maxChars);
  const minKeep: number = Math.floor(maxChars / 2);

  let lastSentenceEnd: number = -1;
  let lastClauseBreak: number = -1;
  for (let i: number = 0; i < hardCut.length; i++) {
    // 按码元比对；取值集合由 isSentenceEndCode / isClauseBreakCode 表达，
    // 逐个标点的对拍用例在 test/libs/text.test.ts。
    const code: number = hardCut.charCodeAt(i);
    if (isSentenceEndCode(code)) lastSentenceEnd = i;
    else if (isClauseBreakCode(code)) lastClauseBreak = i;
  }
  // 两个 -1 哨兵值都显式判断是否找到过：minKeep<=0（maxChars<=1）时，
  // 未找到的 -1 也满足 `+1 >= minKeep`。
  if (lastSentenceEnd >= 0 && lastSentenceEnd + 1 >= minKeep) return hardCut.slice(0, lastSentenceEnd + 1);
  if (lastClauseBreak >= 0 && lastClauseBreak >= minKeep) return hardCut.slice(0, lastClauseBreak);
  return hardCut;
}

/**
 * 媒体转录行：描述或占位标签在前，媒体自带的 caption 以一个空格接在后面；
 * caption 为空串时直接返回标签本身。主线程的回复引用与兜底占位、AI Worker 的
 * 媒体转录共用这一处拼法。
 */
export function composeMediaText(tag: string, caption: string): string {
  return caption ? `${tag} ${caption}` : tag;
}
