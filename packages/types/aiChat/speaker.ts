/**
 * AI 转录、回复引用和 Worker 协议共用的可见发送者身份。
 *
 * `username` 写成 `string | undefined` 而不是 `username?:`，是**故意**的形状约束，
 * 不是笔误：这一族对象由每条群消息构造、又被转录渲染每次读上百遍，缺省字段
 * 若「有时在、有时不在」，JSC 会为同一个类型分出多个隐藏类，转录里的属性读取
 * 随之退化成多态查找。必填之后编译器会逼着每个构造点都把字段写出来，形状因此
 * 恒定。落盘不受影响——`JSON.stringify` 本来就会丢掉值为 undefined 的键，
 * memory/ai/*.json 逐字节不变。整族约束见 docs/04-invariants.md。
 */
export interface AiSpeakerSnapshot {
  id: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）；没有时显式写 undefined，不得省略该键。 */
  username: string | undefined;
}
