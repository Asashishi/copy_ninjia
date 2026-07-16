/** 缓存里的一条消息：发言人 id + 名字（拆开存，好让模型按 id 而非重名区分身份）+ 文本 + 记录时刻。 */
export interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  text: string;
  /** 记录时刻，东京时区的「2026/07/16 21:35:04」（见 libs/time.ts 的
   *  formatTokyoTime）——记录时格式化一次，落盘/转录行直接用，模型可直读，
   *  之后拼上下文零格式化开销。加此字段之前落盘的旧条目恢复时补空串
   *  （时间未知，转录行省略时间前缀）；短暂存在过的毫秒数形态在恢复时
   *  就地转成本格式（见 workers/diskIO/snapshotFiles.ts）。 */
  at: string;
}
