/**
 * AI 转录、回复引用和 Worker 协议共用的可见发送者身份。
 *
 * `username` 声明为 `string | undefined` 而非 `username?:`，每个构造点都必须写出该字段，
 * 对象形状恒定。落盘时 `JSON.stringify` 会丢掉值为 undefined 的键。整族约束见
 * docs/cn/04-invariants.md。
 */
export interface AiSpeakerSnapshot {
  id: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）；没有时显式写 undefined，不得省略该键。 */
  username: string | undefined;
}
