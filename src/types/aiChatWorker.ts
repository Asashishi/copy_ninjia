/** 聊天状态心跳的挡位（见 workers/aiChatWorker.ts 的 startChatActionHeartbeat）：
 *  typing =「正在输入…」；choose_sticker =「正在选择贴纸…」（view_sticker_pack
 *  起、到贴纸真正发出前）；idle = 暂停重发——已有消息/贴纸落地，发出的消息
 *  本身已把聊天状态清掉，模型若已说完，再盖回「正在输入…」只会让群友白等。 */
export type ChatActionPhase = "typing" | "choose_sticker" | "idle";

/** 心跳挡位的切换句柄，经 ReplyToolContext 传给行动工具集（见
 *  ai/tools/replyToolset.ts）：切到非 idle 挡会立即补发一次对应状态（切换
 *  当口就可见，不等下一个重发 tick），此后由心跳按间隔维持；本轮心跳已
 *  停止后调用是无害的空操作。 */
export interface ChatActionControl {
  set(phase: ChatActionPhase): void;
  /** 等最近一次已发出的聊天状态请求落定。发消息/贴纸前先 set("idle") 再
   *  await settle()：光切挡只是不再发新状态，拦不住已在网络在途的那一发——
   *  它若落在刚发出的消息之后，会把「正在输入/选择贴纸…」重新盖回去白挂
   *  5 秒（消息本该顺手清掉聊天状态）。心跳已停止/换代时立即返回。 */
  settle(): Promise<void>;
}

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
