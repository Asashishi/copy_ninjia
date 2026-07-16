/** 缓存里的一条消息：发言人 id + 名字（拆开存，好让模型按 id 而非重名区分身份）+ 文本 + 记录时刻。 */
export interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  text: string;
  /** 记录时刻（毫秒时间戳），转录行会带上它让模型知道每句话说于何时。
   *  加此字段之前落盘的旧条目恢复时补 0（见 workers/diskIO/snapshotFiles.ts），
   *  0 表示「时间未知」，转录行省略时间前缀。 */
  at: number;
}
