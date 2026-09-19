/** 一次 `/h_image` 请求出队后要用到的会话坐标（commands/hImage/）。 */
export interface HImageRequest {
  readonly chatId: number;
  /** 触发命令的消息；结果与失败提示都回复它。 */
  readonly messageId: number | undefined;
  /** 论坛群里触发消息所在话题；General 与非论坛群为 undefined。 */
  readonly messageThreadId: number | undefined;
}
