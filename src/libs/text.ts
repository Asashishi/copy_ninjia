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
