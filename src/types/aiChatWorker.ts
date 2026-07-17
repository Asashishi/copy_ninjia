import type { Sticker } from "@grammyjs/types";
import type { ToolDefinition } from "./tools";

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

/** 缓存里的一条消息：发言人 id + 名字 + 可选公开 username（拆开存，好让
 * 模型按 id 区分重名，并把正文里的 @username 对回具体的人）+ 文本 + 记录时刻。 */
export interface BufferedMessage {
  id: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）。可选以兼容尚无此字段的旧快照，也
   * 因为用户/频道本来就可能没有公开 username。 */
  username?: string;
  text: string;
  /** 记录时刻，东京时区的「2026/07/16 21:35:04」（见 libs/time.ts 的
   *  formatTokyoTime）——记录时格式化一次，落盘/转录行直接用，模型可直读，
   *  之后拼上下文零格式化开销。加此字段之前落盘的旧条目恢复时补空串
   *  （时间未知，转录行省略时间前缀）；短暂存在过的毫秒数形态在恢复时
   *  就地转成本格式（见 workers/diskIO/snapshotFiles.ts）。 */
  at: string;
}

/** 一轮 AI 回复的行动工具集所需的外部上下文（见 ai/tools/replyToolset.ts 的
 *  createReplyToolset）。 */
export interface ReplyToolContext {
  chatId: number;
  /** 触发这次回复的消息 ID：add_reaction 的目标；send_message 带
   *  reply_to_trigger: true 时的回复引用目标。 */
  replyToMessageId: number;
  /** 本轮聊天状态心跳的挡位切换句柄（typing / choose_sticker / idle，见
   *  workers/aiChatWorker.ts 的 startChatActionHeartbeat）：消息/贴纸落地后
   *  切 idle 让状态随消息一起消失、连发停顿前切回 typing、翻贴纸包起切
   *  choose_sticker。 */
  chatAction: ChatActionControl;
  /** 每条消息发送成功后的回调（清洗后的文本 + 消息 ID），供调用方自录
   *  记忆/登记自发消息（防频道自回环，见 infra/selfSentTracker.ts）。 */
  onMessageSent: (text: string, messageId: number) => void;
  /** 贴纸发送成功后的回调，语义同 ai/tools/stickers.ts 的 sendStickerTool 的 onSent。 */
  onStickerSent: (stickerDescription: string, messageId: number) => void;
}

/** 一轮 AI 回复的行动工具集（发言/消息反应/两层应景贴纸），见
 *  ai/tools/replyToolset.ts 的 createReplyToolset。 */
export interface ReplyToolset {
  /** 本轮可用的行动工具定义，拼进请求的 functionDeclarations。 */
  definitions: ToolDefinition[];
  /** 这个名字是否属于本工具集（区别于 src/ai/tools/index.ts 的静态查询工具）。 */
  has(name: string): boolean;
  /** 执行一次工具调用，返回喂回模型的 JSON 字符串。 */
  execute(name: string, argumentsJson: string): Promise<string>;
  /** 本轮已成功发出的消息条数——调用方靠它判断模型是否「说过话」，
   *  决定要不要把最终正文兜底发出（见 workers/aiChatWorker.ts）。 */
  messagesSent(): number;
}

/** 一层候选贴纸：本体 + emoji 元数据 + AI 生成的画面描述，见
 *  ai/tools/stickers.ts 的 buildStickerPackMenu。 */
export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

/** 一个可选贴纸包：short name、展示标题、整包简介、包内已有描述的贴纸。 */
export interface StickerPackCandidate {
  pack: string;
  title: string;
  summary: string;
  stickers: StickerCandidate[];
}

/** 一轮回复内贴纸工具的限额状态，随 ReplyToolset 新建（见
 *  ai/tools/replyToolset.ts 的 createReplyToolset）。 */
export interface StickerRoundState {
  /** 本轮用 view_sticker_pack 查看各包清单时声明的表达意图，键是包编号
   *  （1-based）。重复查看同一个包时以最新意图为准。 */
  viewedPackIntents: Map<number, string>;
  /** 本轮已发出的贴纸 file_unique_id——既是限额计数，也在上限放宽到 1 枚
   *  以上时防止重复发同一枚。 */
  sentStickerUids: Set<string>;
}
