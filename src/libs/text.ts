/**
 * AI 流水线共用的文本清洗工具。原是 workers/aiChatWorker.ts 的私有函数，
 * 图片描述（ai/imageDescription.ts）也需要同一套清洗后抽到这里共用。
 */

/**
 * 把要写进转录的文本压成单行：所有空白串（含换行）折叠为一个空格。
 * 这是防转录注入的关键——转录按「一行 = 一条消息」拼装，若用户消息或
 * 自己改的昵称里带换行，就能伪造出「[id:x] 某人：……」的假发言行，
 * 给别人栽赃。折叠换行后一条消息永远只占一行，该向量彻底失效。
 */
export function sanitizeInline(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
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
  for (let i = 0; i < hardCut.length; i++) {
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
