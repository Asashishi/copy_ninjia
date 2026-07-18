import type { Tool } from "@google/genai";
import type { ToolDefinition } from "./tools";
import type { StickerSendLockControl } from "./stickers";

/** 聊天状态心跳的挡位（见 ai/chatActionHeartbeat.ts 的 startChatActionHeartbeat）：
 *  typing =「正在输入…」（每条消息临发前的有界窗口，见 replyToolset.ts）；
 *  choose_sticker =「正在选择贴纸…」（view_sticker_pack 起、到贴纸真正发出
 *  前）；idle = 不发状态——生成/思考期间的默认挡，也是消息/贴纸落地前的
 *  切换目标：发出的消息本身会把聊天状态清掉，模型若已说完，再盖回
 *  「正在输入…」只会让群友白等。 */
export type ChatActionPhase = "typing" | "choose_sticker" | "idle";

/** 心跳挡位的切换句柄，经 ReplyToolContext 传给行动工具集（见
 *  ai/tools/replyToolset.ts）：切到非 idle 挡会立即补发一次对应状态（切换
 *  当口就可见，不等下一个重发 tick；同一挡位在重发间隔内刚发过则节流跳过，
 *  状态本就还亮着），此后由心跳按间隔维持。非 idle 挡按轮记归属：切 idle
 *  只对本轮持有的挡位生效，不会掐灭并发轮还亮着的窗口；本轮心跳已停止后
 *  调用是无害的空操作。 */
export interface ChatActionControl {
  /** 本轮持有的挡位；本轮心跳已停止（或因连续失败被移除）、或挡位已被
   *  并发轮盖掉时恒为 "idle"。send_sticker 靠它判断选择状态是否被中途的
   *  消息或并发轮打断过，被打断则在发送前重新拉起一段「正在选择贴纸…」
   *  （见 ai/tools/stickers.ts）。 */
  current(): ChatActionPhase;
  set(phase: ChatActionPhase): void;
  /** 等本代所有已发出的聊天状态请求落定。发消息/贴纸前先 set("idle") 再
   *  await settle()：光切挡只是不再发新状态，拦不住已在网络在途的那一发——
   *  它若落在刚发出的消息之后，会把「正在输入/选择贴纸…」重新盖回去白挂
   *  5 秒（消息本该顺手清掉聊天状态）。即使本代已从全局 Map 移除也会等齐，
   *  防止失败清理路径跳过发送前屏障。 */
  settle(): Promise<void>;
}

/** 单个群当前共享的聊天状态心跳。inflight 必须保留全部尚未落定的请求，发送
 *  消息/贴纸之前才能一次等齐，避免旧请求晚到后重新盖回状态。 */
export interface ChatActionHeartbeatEntry {
  timer: ReturnType<typeof setInterval>;
  refCount: number;
  action: ChatActionPhase;
  /** 当前非 idle 挡位的持有轮标记（每个 startChatActionHeartbeat 句柄一份）：
   *  只有持有轮的 set("idle") 能收挡，持有轮 stop 时挡位随之收回——不然
   *  并发轮还在跑时，先结束那轮留下的「正在选择贴纸…」会被心跳一直重发
   *  维持到最后一轮结束。idle 挡时为 null。 */
  owner: object | null;
  /** 状态请求的串行链：所有发送（切挡补发 + 定时重发）按入队顺序逐个执行，
   *  执行时才重读当下挡位——并发切挡时排队的旧请求自动坍缩成最新挡位或
   *  直接跳过，请求逐个到达 Telegram，不会乱序把旧状态盖回新状态之上。 */
  sendChain: Promise<void>;
  /** 链上是否已有一发「排队未执行」的请求。排队那发执行时才重读挡位，
   *  天然代表它入队之后到来的所有请求：发送挂起期间的重复请求（连续几个
   *  tick）合并进它，不再排成一列、恢复后背靠背连发同一状态。 */
  pendingSend: boolean;
  /** 排队那发执行时是否允许重复状态节流：切挡补发可节流；tick 的强制刷新
   *  合并进来时降级为必发——节流掉 tick 会在状态过期边缘掐出闪断。 */
  pendingSendDeduplicate: boolean;
  /** 最近一次真正发出的状态挡位与时刻，切挡补发据此对重复状态节流（见
   *  ai/chatActionHeartbeat.ts 的 pumpChatAction）；挡位收回 idle 时重置为
   *  "idle"——上一条消息已把聊天状态清掉，下一段窗口的第一发不能被误判
   *  为重复而跳过。 */
  lastSentPhase: ChatActionPhase;
  lastSentAt: number;
  inflight: Set<Promise<unknown>>;
  consecutiveFailures: number;
}

/** 一轮聊天状态心跳的完整控制句柄。stop 会先阻止新请求，再等待本代已经
 *  发出的状态请求全部落定，调用方应在 finally 中 await。 */
export interface ChatActionHeartbeatControl extends ChatActionControl {
  stop(): Promise<void>;
}

/** 同群并发位占满期间排队等待补跑的直接触发（回复/@ 机器人，见
 *  workers/aiChat/replyPipeline.ts 的 generateAndSendReply）。随机插话与媒体评价
 *  不入队——没人在等那条回复，错过时机再补反而突兀——所以队列里恒为
 *  直接触发，不需要 isRandomTrigger/mediaComment 字段。 */
export interface QueuedReplyTrigger {
  /** 触发这次回复的消息 ID，出队补跑时仍用它挂回复引用。 */
  replyToMessageId: number;
  /** 若是「用户回复机器人」触发，被回复的机器人消息文本。 */
  repliedBotText?: string;
  /** 触发消息本身的发言人显示名 + 正文快照（截断），入队当口从缓存尾部
   *  取（主线程先 record 后 trigger，FIFO 保证尾部就是触发消息）。补跑时
   *  转录尾部早已被新消息和机器人自己的回复盖过，回复指令靠这份快照点名
   *  要回的具体消息，不能再说「最新这条」。 */
  senderName: string;
  text: string;
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

/** 心情系统的粗粒度天气分桶（见 ai/mood.ts 的 classifyWeatherCodeBucket），
 *  由 Open-Meteo 的 WMO 天气代码归类而来，覆盖范围与 consts/weather.ts 的
 *  WEATHER_CODE_DESCRIPTIONS 一致。 */
export type WeatherBucket = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";

/** 心情系统的粗粒度时段分桶（见 ai/mood.ts 的 classifyTimeBucket），按
 *  东京时区小时数归类。 */
export type TimeBucket = "lateNight" | "morning" | "daytime" | "evening" | "night";

/**
 * 一种可抽中的心情（见 ai/mood.ts、consts/aiChat/prompts/mood.ts）：
 * weight 是「没有天气/时段影响」时抽中概率的份额，全表之和须为 100；
 * instruction 是拼进系统提示词、描述这个心情下人设行为倾向的一段话。
 * weatherMultipliers/timeMultipliers 是可选的权重倍率表：抽取时按当前
 * 天气分桶/时段分桶各查一次，倍率相乘作用在 weight 上（见 ai/mood.ts 的
 * computeAdjustedWeight）；某个桶不在表里则该桶按 ×1（不受影响）处理，
 * 省略整个字段等价于所有桶都 ×1。倍率只影响运行时的实际抽取概率，跟
 * weight 之和必须为 100 这条校验无关（那条校验管的是「没有天气/时段
 * 影响」时的基准分布）。
 */
export interface MoodOption {
  name: string;
  weight: number;
  instruction: string;
  weatherMultipliers?: Partial<Record<WeatherBucket, number>>;
  timeMultipliers?: Partial<Record<TimeBucket, number>>;
}

/** 一轮 AI 回复的行动工具集所需的外部上下文（见 ai/tools/replyToolset.ts 的
 *  createReplyToolset）。 */
export interface ReplyToolContext {
  chatId: number;
  /** 触发这次回复的消息 ID：add_reaction 的目标；send_message 带
   *  reply_to_trigger: true 时的回复引用目标。 */
  replyToMessageId: number;
  /** 本轮聊天状态心跳的挡位切换句柄（typing / choose_sticker / idle，见
   *  ai/chatActionHeartbeat.ts 的 startChatActionHeartbeat）：每条消息临发前
   *  拉起有界的 typing 窗口、发送前切 idle 让状态随消息一起消失、翻贴纸包
   *  起切 choose_sticker 并维持到贴纸发出。 */
  chatAction: ChatActionControl;
  /** 同群「发贴纸」跨轮互斥锁的本轮句柄（见 ai/stickers/sendLock.ts）：
   *  send_sticker 校验通过后、真正发送前 tryAcquire，抢不到则拒绝发送。 */
  stickerLock: StickerSendLockControl;
  /** 本轮是否走「出错」分支：由 workers/aiChat/replyRound.ts 的 startReplyRound
   *  在请求模型之前掷一次骰子决定（见 consts/aiChat.ts 的
   *  AI_TEXT_TYPO_PROBABILITY），createReplyToolset 据此决定 send_message
   *  当轮的参数 schema 要不要暴露 typo_original_char/typo_replacement_char
   *  字段，execute 内部再据此把关，保证一轮最多只吃掉一次手滑错字。 */
  roundHasTypo: boolean;
  /** 本轮捕获的群状态代数仍有效时返回 true；禁用会让旧轮次立即失效。 */
  isActive: () => boolean;
  /** 每条消息发送成功后的回调（清洗后的文本 + 消息 ID），供调用方自录
   *  记忆/登记自发消息（防频道自回环，见 infra/selfSentTracker.ts）。 */
  onMessageSent: (text: string, messageId: number) => void;
  /** 贴纸发送成功后的回调，语义同 ai/tools/stickers.ts 的 sendStickerTool 的 onSent。 */
  onStickerSent: (stickerDescription: string, messageId: number) => void;
}

/** 一轮 AI 回复的行动工具集（发言/消息反应/两层应景贴纸），见
 *  ai/tools/replyToolset.ts 的 createReplyToolset。 */
export interface ReplyToolset {
  /** 本轮可用的行动工具定义（不含 src/ai/tools/index.ts 的静态查询工具清单
   *  与内置 googleSearch，仅供 has()/内部对照使用；拼给 SDK 的完整声明见
   *  下面的 tools）。 */
  definitions: ToolDefinition[];
  /** 拼给 SDK 的完整工具声明：真实注册的 googleSearch + 静态查询函数 +
   *  本轮行动工具。 */
  tools: Tool[];
  /** 这个名字是否属于本工具集（区别于 src/ai/tools/index.ts 的静态查询工具）。 */
  has(name: string): boolean;
  /** 执行一次工具调用，返回喂回模型的 JSON 字符串。 */
  execute(name: string, argumentsJson: string): Promise<string>;
  /** 本轮仍可见的文字消息条数（成功撤回的消息会扣回去）——调用方靠它判断
   *  模型是否真的「说过话」，决定要不要把最终正文兜底发出
   *  （见 workers/aiChatWorker.ts）。 */
  messagesSent(): number;
  /** 本轮已成功落地的动作总数（发消息 + 撤回 + 发贴纸 + 扣反应，口径同
   *  MAX_ACTIONS_PER_REPLY 的额度计数，被校验/限额拒绝或发送失败的不算）
   *  ——调用方靠它识别「整轮零动作」的静默轮并点名记日志
   *  （见 workers/aiChat/replyRound.ts）。 */
  actionsUsed(): number;
  /** 是否仍允许本轮继续请求模型或执行新的群内副作用。 */
  isActive(): boolean;
}
