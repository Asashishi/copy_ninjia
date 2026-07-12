/** 缓存里的一条消息：发言人 id + 名字（拆开存，好让模型按 id 而非重名区分身份）+ 文本。 */
export interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  text: string;
}
