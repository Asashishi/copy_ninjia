/**
 * AI 流水线共用的文本清洗工具。原是 workers/aiChatWorker.ts 的私有函数，
 * 图片描述（aiChat/ai/imageDescription.ts）也需要同一套清洗后抽到这里共用。
 */

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
 * 把要写进转录的文本压成单行：所有空白串（含换行）折叠为一个空格。
 * 这是防转录注入的关键——转录按「一行 = 一条消息」拼装，若用户消息或
 * 自己改的昵称里带换行，就能伪造出「[id:x] 某人：……」的假发言行，
 * 给别人栽赃。折叠换行后一条消息永远只占一行，该向量彻底失效。
 * 同一条契约也护着广告判定的提示词（formatAdBundleText 按序号逐行拼装）。
 */
export function sanitizeInline(raw: string): string {
  return raw.replace(INLINE_WHITESPACE_PATTERN, " ").trim();
}

/**
 * Unicode 双向格式控制符：ALM、LRM/RLM、LRE/RLE/PDF/LRO/RLO 与隔离符
 * LRI/RLI/FSI/PDI。刻意**不**包含同属 Cf 的 ZWJ(U+200D)/ZWNJ(U+200C)——它们是
 * 🏳️‍🌈 这类 emoji 组合序列和部分文字的正常组成部分，剥掉会把昵称里的 emoji 拆碎。
 */
const BIDI_CONTROL_PATTERN: RegExp = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * 显示名清洗：剥掉双向控制符后再压成单行。
 *
 * 昵称由用户自己设置，却会被拼进机器人撰写的句子、并作为 text_link 的锚文本
 * （见 commands/cjkAction.ts）。一个 RLO 就能让整句的其余部分反向渲染，使
 * 「发起人 X了 目标」在视觉上主宾颠倒、两个人名各自的主页链接看起来挂错人。
 * 空白折叠的规则与 sanitizeInline 共用，不另写一份。
 */
export function sanitizeDisplayName(raw: string): string {
  return sanitizeInline(raw.replace(BIDI_CONTROL_PATTERN, ""));
}

/**
 * 复用同一个 Segmenter：它的构造远贵于一次 segment 调用（理由同 libs/time.ts
 * 里几个 Intl.DateTimeFormat 提到模块级）。这里不能照搬 time.ts 在模块加载时
 * 直接构造——旧运行时没有 Intl.Segmenter，模块级构造抛错会让整个模块 import
 * 失败，而 splitGraphemes 的契约是「没有就退化为按码点切分」。
 * 不导出，也不跨模块共享，因此不属于 packages/cache/ 的范畴。
 */
const graphemeSegmenterHolder: { current: Intl.Segmenter | null } = { current: null };

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
 * 截断到 maxChars 以内，但尽量收在子句边界上，不把句子从中间剁断——
 * 模型生成的描述/简介超出字数限制时用这个（曾经用 truncateInline 硬切，
 * memory/stickers/ 里留下过大量「……以戏谑的口」式断在半句的条目）。
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
    const ch: string = hardCut[i]!;
    if ("。！？…～♡".includes(ch)) lastSentenceEnd = i;
    else if ("，、；：".includes(ch)) lastClauseBreak = i;
  }
  // 两个 -1 哨兵值都要显式判"确实找到过"：lastSentenceEnd 的判断是
  // `+1 >= minKeep`，当 minKeep<=0（maxChars<=1）时 -1+1=0 会碰巧满足
  // 这个条件，把"没找到"误判成"找到了、且在边界内"，slice(0,0) 会丢光
  // 本该保留的硬切内容。
  if (lastSentenceEnd >= 0 && lastSentenceEnd + 1 >= minKeep) return hardCut.slice(0, lastSentenceEnd + 1);
  if (lastClauseBreak >= 0 && lastClauseBreak >= minKeep) return hardCut.slice(0, lastClauseBreak);
  return hardCut;
}
