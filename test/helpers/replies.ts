/**
 * 命令测试读取机器人回复的共用读法。
 *
 * 命令层的 `sendMessage` 替身以一个带 `text` 的选项对象作为首个参数被调用；
 * 各用例文件自己持有那个 mock，这里只按调用记录取值。
 */

/** 任意把选项对象作为首个参数记录下来的 mock。 */
export interface RecordedSendMock {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** 最近一次发送的文本；没有调用记录时读取会抛出，让断言直接失败。 */
export function lastReplyText(send: RecordedSendMock): string {
  return (send.mock.calls.at(-1)?.[0] as { text: string }).text;
}
