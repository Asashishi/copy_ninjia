/** AI 转录、回复引用和 Worker 协议共用的可见发送者身份。 */
export interface AiSpeakerSnapshot {
  id: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）。 */
  username?: string;
}
