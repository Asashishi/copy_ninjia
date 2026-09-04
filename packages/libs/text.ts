/**
 * 拼进机器人自己文案的那些文本的共用处理：清洗（压成单行、剥双向控制符、
 * 中和可点击命令）、按字形簇切分，以及把 Telegram 的姓名字段拼成展示名。
 *
 * 消费方跨 AI 流水线（aiChat/ai/imageDescription.ts 等）、命令回执
 * （users/userLabel.ts）与消息转录（auto/message/facts.ts）；同一份规则只此一份，
 * 各处不再自己抄。
 */

import { graphemeSegmenterHolder } from "../cache/perThread/text";
import { neutralizeRenderableCommands } from "./renderableCommand";

/**
 * 折叠为一个空格的「空白」集合：JS 的 `\s`，外加 U+0085 (NEL)。
 *
 * `\s` 是 ECMAScript 自己的定义，**不含 U+0085**，而 Unicode 把 NEL 列为强制
 * 换行符（UAX #14 的 BK 类）。也就是说光靠 `\s` 折叠，NEL 会原样活到下游：
 * 转录与广告判定的提示词都按 `\n` 拼行，模型侧的规范化又把 NEL 当换行读，
 * 于是一条消息还是能撑成两行。补进来才对得上 sanitizeInline 的契约。
 */
const INLINE_WHITESPACE_PATTERN: RegExp = /[\s\u0085]+/g;

/**
 * 单个码元是否属于 `INLINE_WHITESPACE_PATTERN` 的字符类。
 *
 * 取值集合就是 ECMAScript 的 `\s`（WhiteSpace、LineTerminator 与 Zs 的并集）
 * 外加 NEL，与上面那个正则的字符类**必须逐字相同**：这里说「不用改」而 `replace`
 * 其实会改的话，未折叠的换行就原样活到转录里，下面 sanitizeInline 的防注入契约
 * 当场失效。这份等价性由 test/libs/text.test.ts 对全 BMP 逐码元与正则对拍锁住。
 *
 * 先判普通空格，再判 ASCII 控制段，最后才进 0x85 之上那批稀疏取值：正常文本里
 * 出现的空白几乎全是普通空格，而绝大多数码元在第二个比较处就走开。
 */
function isInlineWhitespaceCode(code: number): boolean {
  if (code === 0x20) return true;
  if (code >= 0x09 && code <= 0x0d) return true;
  if (code < 0x85) return false;
  return code === 0x85 || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/**
 * 「这串还需要规范化吗」的前置判定，命中任一条即说明 sanitizeInline 会改动它：
 * 首空白、尾空白、连续空白、非普通空格的空白（换行/制表等）、NEL。
 *
 * 前置判定用于省掉规范文本的整串重建：`INLINE_WHITESPACE_PATTERN`
 * 连单个空格也匹配，因此任何含空格的正常文本都会被 `replace` 整串重建一遍，
 * 哪怕把空格换成空格是个空操作。规范输入原样返回，不分配新字符串。
 * 这个函数在每条消息上要跑 4~5 次（见 workers/aiChat/bufferedMessage.ts）。
 *
 * 四条判据合在同一趟码元扫描里收口：
 * - 空白且不是普通空格（换行、制表、NEL 等）一命中就返回，这一支同时兜住 NEL；
 * - 普通空格落在首位或末位，即首空白与尾空白；
 * - 普通空格紧跟另一个空白，即连续空白（此时两者必然都是普通空格，只要有一个
 *   不是，上一支已经先命中了）。
 */
function needsInlineSanitize(raw: string): boolean {
  const length: number = raw.length;
  let previousWasWhitespace: boolean = false;
  for (let index: number = 0; index < length; index += 1) {
    const code: number = raw.charCodeAt(index);
    if (!isInlineWhitespaceCode(code)) {
      previousWasWhitespace = false;
      continue;
    }
    if (code !== 0x20) return true;
    if (index === 0 || index === length - 1) return true;
    if (previousWasWhitespace) return true;
    previousWasWhitespace = true;
  }
  return false;
}

/**
 * 把要写进转录的文本压成单行：所有空白串（含换行）折叠为一个空格。
 * 这是防转录注入的关键——转录按「一行 = 一条消息」拼装，若用户消息或
 * 自己改的昵称里带换行，就能伪造出「[id:x] 某人：……」的假发言行，
 * 给别人栽赃。折叠换行后一条消息永远只占一行，该向量彻底失效。
 * 同一条契约也护着广告判定的提示词（formatAdBundleText 按序号逐行拼装）。
 *
 * 已经是规范形态的串原样返回（同一个字符串对象，不重建），见上方前置判定。
 */
export function sanitizeInline(raw: string): string {
  if (!needsInlineSanitize(raw)) return raw;
  return raw.replace(INLINE_WHITESPACE_PATTERN, " ").trim();
}

/**
 * Unicode 双向格式控制符：ALM、LRM/RLM、LRE/RLE/PDF/LRO/RLO 与隔离符
 * LRI/RLI/FSI/PDI。刻意**不**包含同属 Cf 的 ZWJ(U+200D)/ZWNJ(U+200C)——它们是
 * 🏳️‍🌈 这类 emoji 组合序列和部分文字的正常组成部分，剥掉会把昵称里的 emoji 拆碎。
 */
const BIDI_CONTROL_PATTERN: RegExp = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * 显示名清洗：剥掉双向控制符、中和可点击命令，再压成单行。
 *
 * 昵称由用户自己设置，却会被拼进机器人撰写的句子、并作为 text_link 的锚文本
 * （见 commands/cjkAction.ts）。两类注入都出在这里：
 *
 * 1. 一个 RLO 就能让整句的其余部分反向渲染，使「发起人 X了 目标」在视觉上主宾
 *    颠倒、两个人名各自的主页链接看起来挂错人。
 * 2. 一个叫 `/batch_kick 1d` 的昵称会让机器人自己印出一条可点击命令——`/咬` 的
 *    成功回执是用户明确授权长期保留的（见 infra/telegram/commandMessages.ts），
 *    那条一键入口就会一直挂在群里等超级管理员误触。所有拼进机器人文案的昵称、
 *    频道名、群标题都经由这一入口统一中和。
 *
 * 空白折叠的规则与 sanitizeInline 共用，不另写一份。
 */
export function sanitizeDisplayName(raw: string): string {
  return sanitizeInline(neutralizeRenderableCommands(raw.replace(BIDI_CONTROL_PATTERN, "")));
}

/** 前导 `@` 串；只服务下方 stripLeadingAtSigns，提到模块级不在调用点重建。 */
const LEADING_AT_SIGNS_PATTERN: RegExp = /^@+/;

/**
 * 去掉用户名前导的 `@`，供转录行、回复标注与逐字缓存条目共用同一份归一规则。
 *
 * Telegram 的 username 字段本身不含 `@`，剥离是给「用户手打进来的 @名字」和
 * 「从 mention 实体里切出来的片段」兜底，正常路径一个字符都不用改。因此先看
 * 首码元、只有真的带 `@` 时才走正则：`String.prototype.replace` 不匹配时虽然
 * 返回同一个字符串对象，仍要完整跑一遍匹配。这条判定落在每条进滚动记忆的
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
 * 缺席与空串一律当作「没有这一段」，与「两段都在时用一个空格分隔」共同构成
 * 本函数的全部语义；首尾空白由调用方按各自兜底需要决定是否 `trim`。
 *
 * 直接分支拼接，不创建字面量数组、filter 结果数组或一次性闭包；转发来源标注
 * （auto/message/facts.ts 的 forwardOriginLabel）会在每条带 forward_origin 的消息上调用。
 */
export function joinPersonName(
  firstName: string | undefined,
  lastName: string | undefined
): string {
  if (firstName) return lastName ? `${firstName} ${lastName}` : firstName;
  return lastName ?? "";
}

/**
 * 复用同一个 Segmenter：它的构造远贵于一次 segment 调用（理由同 libs/time.ts
 * 里几个 Intl.DateTimeFormat 提到模块级）。这里不能照搬 time.ts 在模块加载时
 * 直接构造——旧运行时没有 Intl.Segmenter，模块级构造抛错会让整个模块 import
 * 失败，而 splitGraphemes 的契约是「没有就退化为按码点切分」。
 * holder 按 owner 约束放在 cache/perThread/text.ts；各线程只使用自己的副本。
 */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenterHolder.current !== null) return graphemeSegmenterHolder.current;
  try {
    graphemeSegmenterHolder.current = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    // 只缓存成功，失败不写进 holder。构造失败未必是「本运行时不支持」这种永久
    // 事实，也可能是 ICU 数据一时不可用、内存压力下分配失败这类瞬时故障；把它
    // 记下来就等于把一次性抖动固化成进程生命周期内的降级，此后每条 /r_copy 都
    // 按码点拆 ZWJ 序列、吐出坏掉的 emoji，直到重启为止。下次调用重试即可——
    // 真正不支持的运行时无非每次多付一次抛错，与提取 holder 之前的行为一致。
    return null;
  }
  return graphemeSegmenterHolder.current;
}

/** 清空已缓存的 Segmenter；仅供单测在替换 Intl.Segmenter 前后重置状态。 */
export function resetGraphemeSegmenterCache(): void {
  graphemeSegmenterHolder.current = null;
}

/** 按 Unicode 扩展字形簇切分；旧运行时不支持 Segmenter 时退化为按码点。 */
export function splitGraphemes(text: string): string[] {
  const segmenter: Intl.Segmenter | null = graphemeSegmenter();
  if (segmenter === null) return Array.from(text);
  try {
    return Array.from(segmenter.segment(text), (segment: Intl.SegmentData): string => segment.segment);
  } catch {
    // 构造之外的失败仍按原契约退化，保持与提取 holder 之前逐字一致的行为。
    return Array.from(text);
  }
}

/**
 * 把文本截断到 maxChars 个 UTF-16 码元以内。slice 可能恰好切在代理对中间
 * （emoji 等），此时去掉孤立的高位代理——孤立代理不是合法字符，混进消息
 * 可能被 Telegram 拒收，混进 prompt 则是每次请求都带着的乱码。
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
 * 句末标点「。！？…～♡」的码元。与 truncateAtClauseBoundary 的取值集合是同一份
 * 事实，改这里就要同步改那边的对拍用例。
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
 * 收到它之前（丢掉悬空的分隔符）。边界位置过于靠前（不足上限一半，收完
 * 只剩个开头）时放弃找边界，退回硬切——宁可断句也不丢大半内容。
 */
export function truncateAtClauseBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const hardCut: string = truncateInline(text, maxChars);
  const minKeep: number = Math.floor(maxChars / 2);

  let lastSentenceEnd: number = -1;
  let lastClauseBreak: number = -1;
  for (let i: number = 0; i < hardCut.length; i++) {
    // 按码元比对，避免为 CJK/全角字符物化单字符字符串并做子串查找。取值集合由
    // isSentenceEndCode / isClauseBreakCode 表达，逐个标点的对拍用例在
    // test/libs/text.test.ts——写错一个码点只会让那一个标点静默失效。
    const code: number = hardCut.charCodeAt(i);
    if (isSentenceEndCode(code)) lastSentenceEnd = i;
    else if (isClauseBreakCode(code)) lastClauseBreak = i;
  }
  // 两个 -1 哨兵值都要显式判"确实找到过"：lastSentenceEnd 的判断是
  // `+1 >= minKeep`，当 minKeep<=0（maxChars<=1）时 -1+1=0 会碰巧满足
  // 这个条件，把"没找到"误判成"找到了、且在边界内"，slice(0,0) 会丢光
  // 本该保留的硬切内容。
  if (lastSentenceEnd >= 0 && lastSentenceEnd + 1 >= minKeep) return hardCut.slice(0, lastSentenceEnd + 1);
  if (lastClauseBreak >= 0 && lastClauseBreak >= minKeep) return hardCut.slice(0, lastClauseBreak);
  return hardCut;
}
