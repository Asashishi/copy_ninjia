/** AI 群聊逐字缓存与持久化记忆 schema。 */

export interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）；旧快照或无公开名时省略。 */
  username?: string;
  text: string;
  /** 已格式化的东京时间；旧快照未知时为空串。 */
  at: string;
}

/** memory/ai/<chatId>.json 的版本化落盘结构。 */
export interface AiMemorySnapshot {
  version: 1;
  buffer: BufferedMessage[];
  summaries: string[];
  pendingSummary: string | null;
  savedAt: number;
}
