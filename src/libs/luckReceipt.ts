/** 运势结果末行的隐藏签名回执格式。 */
export const LUCK_RECEIPT_PATTERN: RegExp = /^luck:([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

/** AI 记忆只保留用户可读正文，不把内部签名协议混进群聊转录。 */
export function stripLuckReceipt(text: string): string {
  const lastLineBreak: number = text.lastIndexOf("\n");
  if (lastLineBreak < 0) return text;
  return LUCK_RECEIPT_PATTERN.test(text.slice(lastLineBreak + 1)) ? text.slice(0, lastLineBreak) : text;
}
