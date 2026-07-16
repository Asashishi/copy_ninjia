import { logger } from "../infra/logger";
import { readFileSync } from "node:fs";
import { LinkedQueue } from "../libs/linkedQueue";
import { sleep } from "../libs/sleep";
import { formatTokyoTime } from "../libs/time";
import { sanitizeInline, truncateInline } from "../libs/text";
import { PERSONA_PATH } from "../consts/paths";
import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  AI_REPLY_COOLDOWN_MS,
  AI_SNAPSHOT_INTERVAL_MS,
  ANIMATION_FALLBACK_PLACEHOLDER,
  ANIMATION_PENDING_PLACEHOLDER,
  COMPACT_BATCH_SIZE,
  IMAGE_FALLBACK_PLACEHOLDER,
  IMAGE_PENDING_PLACEHOLDER,
  MAX_SUMMARY_ROUNDS,
  MAX_TOOL_ROUNDS,
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_MAX_TRIGGERS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
  RATE_LIMIT_WINDOW_MS,
  REPLY_MAX_TOKENS,
  REPLY_TEMPERATURE,
  SPLIT_REPLY_MAX_PARTS,
  SPLIT_REPLY_PROBABILITY,
  STICKER_PENDING_PLACEHOLDER,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TEMPERATURE,
  TIME_AWARENESS_INSTRUCTION,
  TYPING_ACTION_INTERVAL_MS,
  TYPING_DELAY_BASE_MS,
  TYPING_DELAY_JITTER_MS,
  TYPING_DELAY_MAX_MS,
  TYPING_DELAY_PER_CHAR_MS,
  VERBATIM_CONTEXT_MAX,
  WEB_SEARCH_INSTRUCTION,
  XAI_MODEL,
} from "../consts/aiChat";
import { FALLBACK_SPEAKER_NAME } from "../consts/auto";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import {
  chatBuffers,
  chatSummaries,
  compactionChains,
  dirtyMemoryChats,
  lastReplyTimes,
  longTriggerTimes,
  pendingSummaries,
  rateLimitNoticeTimes,
  triggerTimes,
  typingHeartbeats,
} from "../cache/aiChatWorker";
import type { BufferedMessage, MediaKind, XaiRequestTool } from "../types";
import { maybeAddReaction } from "../ai/reactions";
import { maybeSendStickerReply } from "../ai/stickers";
import { ensureStickerCatalogs, flushDirtyStickerCatalogs, getCatalogEntry, hydrateStickerCatalogs } from "../ai/stickerCatalog";
import { stickerConfig } from "../ai/stickerConfig";
import { describeMedia } from "../ai/imageDescription";
import { extractFunctionCalls, extractOutputText, requestXaiResponse } from "../ai/xai";
import { sendMessage, sendTypingAction } from "../infra/telegram";
import { TOOL_DEFINITIONS, callTool } from "../tools";
import { getCurrentTime } from "../tools/time";
import type {
  AiBotInfo,
  AiChatWorkerMessage,
  AiMemoryEvent,
  AiMemoryFlushedEvent,
  AiMemorySnapshot,
  AiRecordMediaMessage,
  AiSentMessage,
  AiStickerCatalogEvent,
} from "../types";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（src/auto/message.ts → aiChat.ts 代理）
 * 只做事件投递，重活全在这里：滚动对话缓存、图片/贴纸/GIF 占位与异步描述
 * 回填、冷却与双滑动窗口限频、拼装上下文、调 Grok（含 function calling 往返
 * 与内置 web_search）、连发消息、消息反应与贴纸跟发。发往 Telegram 的调用不回
 * 主线程绕路——本线程 import telegram.ts 时会得到自己独立的 grammY Api
 * 客户端（那个 Bot 实例只用其 bot.api 发请求，从不 init/轮询；机器人自己
 * 的账号身份改由主线程在 bot.init() 后经 init 消息注入，见下方 botInfo）。
 * error 日志经 logger.ts 的转发模式回传主线程统一落盘。
 *
 * AI 闲聊回复本体：把本群最近的对话记录喂给 xAI 的 grok（/v1/responses
 * 接口，收发细节见 ai/xai.ts），生成一条人设化回复；模型可自主使用内置的
 * web_search 服务端工具联网查证。人设文本存放在仓库根目录的
 * prompt/persona.md，修改人设不需要碰代码。
 *
 * 中期记忆：镜像/热块轮换机制见 consts/aiChat.ts 的 COMPACT_BATCH_SIZE 注释；
 * 轮换本身由 recordChatMessage/scheduleRotation/rotateCompaction 实现。
 *
 * 贴纸目录：白名单贴纸包（机器人自己要发的那些）的画面描述目录由
 * ai/stickerCatalog.ts 生成/持久化，init 消息到达时后台启动生成（见
 * ensureStickerCatalogs），与本文件的 dirty 记忆快照共用同一条上报/落盘
 * 节奏（见文件底部的 setInterval 与 flushMemory 分支）。
 */

declare var self: Worker;

const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/**
 * 机器人自己的账号身份，由主线程在 bot.init() 之后经 init 消息注入
 * （index.ts 在 runner 启动前注入，postMessage 按 FIFO 送达，保证先于
 * 一切 record/trigger 到达）。转录里的自我认知和自录都靠它。
 */
let botInfo: AiBotInfo | null = null;

/**
 * 「当前实际时间：...（东京时间 UTC+9）。」——callGrok 的系统提示词与
 * summarizeBatch 的摘要提示词共用同一句措辞，提成函数只为保证两处文案
 * 一致，不是抽成常量：时间本身必须现查，不能预先算好存成字面量（Worker
 * 线程常驻、一跑就是几天，缓存的时间会很快过期）。
 */
function currentTimeSentence(): string {
  return `当前实际时间：${getCurrentTime().formatted}（东京时间 UTC+9）。`;
}

/**
 * 把一条已清洗好的缓存条目压进该群的滚动缓存，并按块边界触发轮换。
 * recordChatMessage / recordChatMedia 共用——后者需要拿住条目对象的引用
 * 以便异步回填描述，所以入队和构造条目分开。
 */
function pushBufferedMessage(chatId: number, entry: BufferedMessage): void {
  let buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new LinkedQueue<BufferedMessage>();
    chatBuffers.set(chatId, buf);
  }
  buf.push(entry);
  dirtyMemoryChats.add(chatId);
  // 轮换机制见 COMPACT_BATCH_SIZE 注释。push 每次只 +1，且轮换把 size 收回
  // COMPACT_BATCH_SIZE 后 push 不会再撞上下面第二个判等，两个 === 各自恰好
  // 在块边界命中一次。
  if (buf.size === VERBATIM_CONTEXT_MAX) {
    for (let i: number = 0; i < COMPACT_BATCH_SIZE; i++) {
      buf.shift();
    }
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), true);
  } else if (buf.size === COMPACT_BATCH_SIZE) {
    // 本群的第一块刚攒满：成为首个镜像，只提交压缩，还没有可晋升的旧摘要。
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), false);
  }
}

/**
 * 记录一条群消息到该群的滚动缓存，供之后拼装成对话上下文喂给模型。
 * 文本与昵称都会被压成单行（见 sanitizeInline，防转录注入）。
 * @param chatId 群聊 ID。
 * @param id 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param text 消息文本。
 */
function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, text: string): void {
  const sanitized: string = sanitizeInline(text);
  if (!sanitized) return;
  pushBufferedMessage(chatId, { id, firstName: sanitizeInline(firstName), lastName: sanitizeInline(lastName), text: sanitized, at: formatTokyoTime(Date.now()) });
}

/** 媒体转录行：描述/占位标签在前，媒体自带的 caption（若有）跟在后面
 *  （贴纸没有 caption，恒为空串，等价于直接返回标签本身）。 */
function composeMediaText(tag: string, sanitizedCaption: string): string {
  return sanitizedCaption ? `${tag} ${sanitizedCaption}` : tag;
}

/** 媒体刚入缓存、描述还没解析出来时的占位文本，按类型区分措辞。 */
function pendingPlaceholderFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_PENDING_PLACEHOLDER;
    case "animation":
      return ANIMATION_PENDING_PLACEHOLDER;
    default:
      return IMAGE_PENDING_PLACEHOLDER;
  }
}

/** 解析成功后回填的描述标签，按类型区分措辞。 */
function resolvedTagFor(kind: MediaKind, description: string): string {
  switch (kind) {
    case "sticker":
      return `[贴纸：${description}]`;
    case "animation":
      return `[GIF：${description}]`;
    default:
      return `[图片：${description}]`;
  }
}

/** 解析失败时回填的兜底文本：贴纸退回原有的元数据行（不丢失 emoji/包名
 *  信息，见 ai/stickerSets.ts 的 describeStickerForContext），图片/GIF 用
 *  通用的失败说明。 */
function fallbackTextFor(kind: MediaKind, msg: AiRecordMediaMessage): string {
  if (kind === "sticker") return msg.stickerFallbackText ?? IMAGE_FALLBACK_PLACEHOLDER;
  if (kind === "animation") return ANIMATION_FALLBACK_PLACEHOLDER;
  return IMAGE_FALLBACK_PLACEHOLDER;
}

/**
 * 记录一条图片/贴纸/GIF 消息：先以占位文本立即入缓存（保住它在对话时序里
 * 的位置），再异步下载/解析媒体，解析完直接改写同一个条目对象的 text
 * 字段回填描述。改写对象而不是回队列里找：条目引用一直攥在手里，即便这
 * 期间缓存滚动、该条目已被 scheduleRotation 快照进镜像批次（快照数组存的
 * 也是同一批对象引用），只要压缩调用还没把它序列化出去，回填一样能生效；
 * 已经被压缩/滑出的极端情形，摘要里留下的就是占位文本，可接受。解析失败
 * 回填为兜底文本（见 fallbackTextFor），明确告诉模型这行没有可用内容
 * （贴纸例外，退回元数据行仍是可用信息）。
 *
 * 贴纸额外走一条捷径：若这枚贴纸恰好来自白名单包、目录里已经有现成描述
 * （见 ai/stickerCatalog.ts 的 getCatalogEntry），直接一步到位写入描述，
 * 跳过占位与异步解析——群友发的贴纸不少概率命中机器人自己也在用的白名单
 * 包，省一次视觉调用。
 *
 * 主线程掷中评价（msg.commentOnResolve，概率/quiet/冷却都在那边把过关）
 * 且描述解析成功时，紧接着以「回复那条消息」的形式发一条针对这份媒体
 * 内容的评价（见 generateAndSendReply 的 mediaComment）——回填先于触发，
 * 模型拼上下文时看到的已是描述而非占位。解析失败没内容可评，静默放弃。
 *
 * 相册（一次发多张图）在 Telegram 侧本来就是多条相邻消息、各带一张图，
 * 天然逐条走这里，互不影响；每条媒体消息各自占位、各自异步解析。
 */
function recordChatMedia(msg: AiRecordMediaMessage): void {
  const sanitizedCaption: string = sanitizeInline(msg.caption);

  if (msg.kind === "sticker") {
    const catalogEntry = getCatalogEntry(msg.fileUniqueId);
    if (catalogEntry) {
      const entry: BufferedMessage = {
        id: msg.senderId,
        firstName: sanitizeInline(msg.firstName),
        lastName: sanitizeInline(msg.lastName),
        text: composeMediaText(resolvedTagFor("sticker", catalogEntry.description), sanitizedCaption),
        at: formatTokyoTime(Date.now()),
      };
      pushBufferedMessage(msg.chatId, entry);
      if (msg.commentOnResolve) {
        generateAndSendReply(msg.chatId, msg.messageId, undefined, false, { kind: "sticker", senderName: displayName(entry), description: catalogEntry.description });
      }
      return;
    }
  }

  const entry: BufferedMessage = {
    id: msg.senderId,
    firstName: sanitizeInline(msg.firstName),
    lastName: sanitizeInline(msg.lastName),
    text: composeMediaText(pendingPlaceholderFor(msg.kind), sanitizedCaption),
    at: formatTokyoTime(Date.now()),
  };
  pushBufferedMessage(msg.chatId, entry);
  // describeMedia 内部兜住一切异常只返回 null，这条异步链不会 reject；
  // 同一份媒体重发/刷屏由它按 file_unique_id 去重，不重复下载解析。
  void describeMedia(msg.kind, msg.fileId, msg.fileUniqueId).then((description: string | null) => {
    entry.text = composeMediaText(description ? resolvedTagFor(msg.kind, description) : fallbackTextFor(msg.kind, msg), sanitizedCaption);
    // 条目内容变了，重新标 dirty 让下一轮快照把回填后的文本落盘。
    dirtyMemoryChats.add(msg.chatId);
    if (msg.commentOnResolve && description) {
      generateAndSendReply(msg.chatId, msg.messageId, undefined, false, { kind: msg.kind, senderName: displayName(entry), description });
    }
  });
}

/**
 * 把一轮「晋升旧摘要 + 压缩新镜像」挂到该群的轮换串行链上。链保证时序：
 * 洪峰下第 N+1 轮可能在第 N 轮的压缩调用返回前就到来，串行执行才能保证
 * 晋升到手的一定是上一轮的结果、摘要严格按时间顺序入队。rotateCompaction
 * 自身兜错，链永不 reject。
 * @param mirrorBatch 刚攒满、成为新镜像的一块消息（快照，之后缓存继续滚动不影响它）。
 * @param promoteFirst 本轮是否有旧镜像滑出（首轮没有），有则先晋升其摘要。
 */
function scheduleRotation(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): void {
  const prev: Promise<void> = compactionChains.get(chatId) ?? Promise.resolve();
  compactionChains.set(chatId, prev.then(() => rotateCompaction(chatId, mirrorBatch, promoteFirst)));
}

/** 执行一轮轮换：先晋升上一轮镜像的摘要（若有），再 AI 压缩新镜像存为待晋升。 */
async function rotateCompaction(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): Promise<void> {
  try {
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await summarizeBatch(mirrorBatch);
    if (summary) {
      pendingSummaries.set(chatId, summary);
      dirtyMemoryChats.add(chatId);
    } else {
      // 失败刻意不回灌不重试：镜像原文此刻还在逐字区，要到下一轮滑出时
      // 这段中期记忆才真正缺失。
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    logger.error("Error in chat compaction task:", error);
  }
}

/** 把上一轮镜像的摘要（其原文刚滑出逐字区）晋升进该群的中期记忆队列。 */
function promotePendingSummary(chatId: number): void {
  const pending: string | undefined = pendingSummaries.get(chatId);
  pendingSummaries.delete(chatId);
  if (!pending) return; // 上一轮压缩失败：无可晋升项，失败当时已记过日志。
  let queue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<string>();
    chatSummaries.set(chatId, queue);
  }
  queue.push(pending);
  while (queue.size > MAX_SUMMARY_ROUNDS) {
    queue.shift();
  }
  dirtyMemoryChats.add(chatId);
}

/** 把某群当前的滚动缓存 + 中期摘要 + 待晋升摘要序列化成一份可落盘的快照。 */
function buildMemorySnapshot(chatId: number): AiMemorySnapshot {
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  return {
    version: 1,
    buffer: buf ? buf.last(buf.size) : [],
    summaries: summaryQueue ? summaryQueue.last(summaryQueue.size) : [],
    pendingSummary: pendingSummaries.get(chatId) ?? null,
    savedAt: Date.now(),
  };
}

/**
 * 把所有 dirty 群的记忆快照 post 给主线程（进而转投 diskIOWorker 落盘），
 * 随后清空 dirty 标记。定时调用（见文件底部的 setInterval）以及
 * flushMemory（退出前最后一刷）共用。
 */
function flushDirtyMemories(): void {
  if (dirtyMemoryChats.size === 0) return;
  for (const chatId of dirtyMemoryChats) {
    self.postMessage({ type: "memory", chatId, snapshot: buildMemorySnapshot(chatId) } satisfies AiMemoryEvent);
  }
  dirtyMemoryChats.clear();
}

/**
 * 启动时（或本 Worker 崩溃重启后）灌入持久化的记忆快照。只对内存里还没有
 * 数据的群生效——重启后本来就全空，天然成立，不会覆盖掉刚收到的新消息。
 *
 * buffer 只恢复最新 AI_MEMORY_HYDRATE_BUFFER_MAX（= VERBATIM_CONTEXT_MAX - 1）
 * 条：recordChatMessage 靠严格等值 `size === VERBATIM_CONTEXT_MAX` 触发轮换，
 * 若恰好灌回整 100 条，下一次 push 后 size 变 101，会永远错过这个判等，
 * 缓存无界增长。`=== COMPACT_BATCH_SIZE` 分支对恢复后 size ≥ 50 的群不再
 * 触发，镜像语义由恢复的 pendingSummary 近似衔接——极端情况某块摘要粒度
 * 略有漂移，可接受，不为此复刻轮换状态机。
 */
function hydrateMemories(memories: Map<number, AiMemorySnapshot>): void {
  for (const [chatId, snapshot] of memories) {
    if (chatBuffers.has(chatId)) continue;

    const buf: LinkedQueue<BufferedMessage> = new LinkedQueue<BufferedMessage>();
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      buf.push(message);
    }
    if (buf.size > 0) chatBuffers.set(chatId, buf);

    if (snapshot.summaries.length > 0) {
      const queue: LinkedQueue<string> = new LinkedQueue<string>();
      for (const summary of snapshot.summaries.slice(-MAX_SUMMARY_ROUNDS)) {
        queue.push(summary);
      }
      chatSummaries.set(chatId, queue);
    }

    if (snapshot.pendingSummary) {
      pendingSummaries.set(chatId, snapshot.pendingSummary);
    }
  }
}

/**
 * 调 Grok 把一批冷消息压缩成一条摘要。走独立的中性总结提示词（不带
 * 人设、不带工具），产出压成单行并截断——摘要虽是模型生成的，但源头是
 * 用户文本，保持「一行一条」的转录结构，多行伪造向量在这里同样失效。
 */
async function summarizeBatch(batch: BufferedMessage[]): Promise<string | null> {
  const selfNote: string = botInfo
    ? `注意：[id:${botInfo.id}] 是群里的聊天机器人「${botInfo.first_name}」本人的发言，摘要里请以「${botInfo.first_name}」称呼它。\n\n`
    : "";
  const data: any = await requestXaiResponse(
    {
      model: XAI_MODEL,
      input: [
        {
          role: "system",
          content: currentTimeSentence() + SUMMARY_SYSTEM_PROMPT,
        },
        { role: "user", content: selfNote + batch.map(formatLine).join("\n") },
      ],
      temperature: SUMMARY_TEMPERATURE,
      max_output_tokens: SUMMARY_MAX_TOKENS,
    },
    "xAI summarize API"
  );
  if (!data) return null;
  const sanitized: string = sanitizeInline(extractOutputText(data));
  if (!sanitized) return null;
  return truncateInline(sanitized, SUMMARY_MAX_CHARS);
}

/** 发言人的显示名：first/last 拼接，都没有则给个占位。 */
function displayName(m: BufferedMessage): string {
  return [m.firstName, m.lastName].filter((p: string) => !!p).join(" ").trim() || FALLBACK_SPEAKER_NAME;
}

/** 把一条缓存消息格式化成喂给模型的一行：先是发送时间（记录时已格式化好
 *  的字符串，直接拼；at 为空串的旧条目时间未知，省略前缀），再标出 id
 *  避免重名混淆身份。 */
function formatLine(m: BufferedMessage): string {
  const timePrefix: string = m.at ? `[${m.at}] ` : "";
  return `${timePrefix}[id:${m.id}] ${displayName(m)}：${m.text}`;
}

/** 评价触发的附加上下文：发送人显示名 + 解析出的描述 + 媒体类型，见
 *  recordChatMedia。kind 决定拼进提示词的措辞（"一张图片"/"一枚贴纸"/
 *  "一个 GIF"）。 */
interface MediaCommentContext {
  kind: MediaKind;
  senderName: string;
  description: string;
}

/** 按媒体类型给出提示词里要用的名词短语与转录行标签，见 replyInstruction
 *  的拼装。 */
function mediaNounFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return "一枚贴纸";
    case "animation":
      return "一个 GIF（动图）";
    default:
      return "一张图片";
  }
}
function mediaTagHintFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return "[贴纸：…]";
    case "animation":
      return "[GIF：…]";
    default:
      return "[图片：…]";
  }
}

/** buildUserContent 的可选附加上下文，按需组合，见各字段说明。 */
interface UserContentOptions {
  /** 是否要求模型把回复拆成多条短消息（一行一条）连发。 */
  splitMode: boolean;
  /** 若本次是「用户回复了机器人」，被回复的那条机器人消息文本，作为上下文
   *  （机器人自己发的消息不会作为更新推送回来，不在缓存里）。 */
  repliedBotText?: string;
  /** 若本次是随机触发（见 generateAndSendReply 的 isRandomTrigger），触发者的
   *  显示名——这种情况下回复不会用 Telegram 的「回复」关联到原消息，要求模型
   *  改为在文字里点名称呼对方。 */
  addressee?: string;
  /** 若本次是「解析完图片/贴纸/GIF 后评价它」触发（见 recordChatMedia），
   *  发送人与描述——回复指令改为针对这份媒体发表评价，替代默认的「接住
   *  最新消息」。 */
  mediaComment?: MediaCommentContext;
}

/**
 * 把某群的对话上下文拼装成给模型的用户消息内容：先是中期记忆摘要段
 * （若有，最多 MAX_SUMMARY_ROUNDS 轮，从旧到新），再是逐字聊天记录
 * （整个缓存 = 镜像 + 热，50 ~ 100 条，见 COMPACT_BATCH_SIZE 的注释）。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 botInfo），用于转录里的自我认知。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, selfInfo: AiBotInfo, options: UserContentOptions): string | null {
  const { splitMode, repliedBotText, addressee, mediaComment } = options;
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  const lines: string[] = recent.map(formatLine);
  if (repliedBotText) {
    // 同样压成单行：这段文本虽是机器人自己说过的话，保持转录「一行一条」的
    // 结构不变即可杜绝任何多行伪造的可能。
    lines.push(`（你刚才说过：${sanitizeInline(repliedBotText)}）`);
  }

  // 随机触发时这条回复不会挂 Telegram 的回复引用，得让模型自己在文字里点名，
  // 别人才看得出是在接谁的话。全名太长（比如中间夹着 last name）念出来生硬，
  // 交给模型自己判断——名字短就整个用，长就挑其中自然的一部分当称呼。
  const addressInstruction: string = addressee
    ? `这条回复不会以「回复」形式关联到最新那条消息，所以开头要先点名称呼对方（TA 的名字是「${addressee}」，比如「${addressee}，……」；如果这个名字比较长念着别扭，可以自己判断截取其中简短自然的一部分来称呼，不必照抄全名），让人一眼看出你在接谁的话。`
    : "";

  // 评价触发：不是「接住最新消息」，而是针对刚解析完的那份图片/贴纸/GIF
  // 发表评价——这条回复会以 Telegram「回复」形式挂在那条消息上，谁都看得出
  // 在评哪一条。
  const replyInstruction: string = mediaComment
    ? `刚才 ${mediaComment.senderName} 在群里发了${mediaNounFor(mediaComment.kind)}，内容是：「${mediaComment.description}」（聊天记录里对应「${mediaTagHintFor(mediaComment.kind)}」那行）。你的这条回复会以「回复」形式挂在那条消息上。请以你的人设，针对这份内容本身发表一两句评价/吐槽/调侃——自然一点，不要机械复述描述，也不要提"描述"两个字。只输出你要发到群里的那句话本身，不要任何解释、前缀、引号、代码块或「[id:...]」这类标记。`
    : splitMode
    ? `请针对最新这条消息，以你的人设回复，并把回复拆成 2 到 ${SPLIT_REPLY_MAX_PARTS} 条连贯的短消息——就像真人打字时想到哪发到哪、一句接一句连发那样，每条一行、语义上前后衔接（比如先反应、再吐槽、再补一刀）。默认拆成 2~3 条就够了，只有真的意犹未尽、还有话要补时，才用到 4~${SPLIT_REPLY_MAX_PARTS} 条，不要为了凑数硬拆。${addressInstruction}只输出这几行消息本身，一行一条，不要编号、解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`
    : `请针对最新这条消息，以你的人设回复一到两句话，自然接住话题。${addressInstruction}只输出你要发到群里的那句话本身，不要任何解释、（称呼除外的）前缀、引号、代码块或「[id:...]」这类标记。`;

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 botInfo），不写死在代码里。
  const selfIdentity: string =
    `你在这个群里的 Telegram 账号是 @${selfInfo.username}（[id:${selfInfo.id}]）：` +
    `记录里标着这个 id 的行是你自己之前说过的话，别把它们当成别人的发言；` +
    `消息里 @ 这个用户名、或回复你的消息，都是在跟你说话。`;

  // 中期记忆段：更早的冷历史被压缩成的摘要（每轮 50 条，从旧到新），带着
  // 自己的声明句放在整段上下文最前面——转录的声明句则紧贴逐字记录，两段
  // 各自声明、界线分明，摘要行不会被误当成聊天记录的一部分。摘要入队时
  // 已压成单行（见 summarizeBatch），「一行一条」的防伪造结构同样成立。
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string =
    summaries.length > 0
      ? "在下方聊天记录之前，更早的对话已被压缩成如下摘要（按时间从旧到新），是你对这个群的中期记忆——延续话题、称呼和梗时可以参考；摘要与下方逐字记录冲突时，以逐字记录为准：\n" +
        summaries.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n") +
        "\n\n"
      : "";

  return (
    summaryBlock +
    "以下是本群最近的聊天记录，每行格式为「[年/月/日 时:分:秒] [id:用户ID] 名字：内容」，行首方括号里是那条消息的发送时间（东京时间 UTC+9，个别旧记录没有时间前缀），同名的人可能是不同的人，请以 id 区分身份，最后一条是最新消息，请正确识别情况（不要编造，不要张冠李戴），并作出符合人设的回应。" +
    selfIdentity +
    "\n\n" +
    lines.join("\n") +
    "\n\n" +
    replyInstruction
  );
}

/** 触发这次回复的最新一条缓存消息；缓存为空时返回 undefined。 */
function getLatestMessage(chatId: number): BufferedMessage | undefined {
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  return buf?.last(1)[0];
}

/**
 * 调用 xAI 的 /v1/responses 接口生成一条回复（收发与响应解析在 ai/xai.ts）。
 * tools 带两类：内置的 web_search（xAI 服务器侧自动执行，模型自主决定
 * 要不要联网查证，结果直接体现在最终文本里）+ src/tools 里的自定义函数
 * （目前是查东京天气）。自定义函数由模型以 function_call 抛回来，
 * 执行后把上一轮的全部 output 成员原样接回 input、附上 function_call_output
 * 再续跑（推理模型的 reasoning 成员也要一并带回，缺了会丢思考上下文），
 * 直到给出最终文本或达到轮数上限。
 * 查时间不走工具：当前时间默认拼进每次请求的系统提示词（见下方），转录行
 * 也自带每条消息的发送时间（见 formatLine），模型不需要判断要不要查。
 * @param userContent buildUserContent 拼好的对话上下文。
 * @returns 清洗后的回复文本；请求失败、超时或空输出时返回 null。
 */
async function callGrok(userContent: string): Promise<string | null> {
  // 每次请求现查当前时间拼进系统提示词（而非用模块加载时算好的值），worker
  // 线程常驻、一跑就是几天，缓存的时间会很快过期。
  const systemPrompt: string = `${SYSTEM_PROMPT}\n\n${currentTimeSentence()}${TIME_AWARENESS_INSTRUCTION}\n\n${WEB_SEARCH_INSTRUCTION}`;
  const input: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const tools: XaiRequestTool[] = [{ type: "web_search" }, ...TOOL_DEFINITIONS];

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data: any = await requestXaiResponse(
      {
        model: XAI_MODEL,
        input,
        tools,
        temperature: REPLY_TEMPERATURE,
        max_output_tokens: REPLY_MAX_TOKENS,
      },
      "xAI API"
    );
    if (!data) return null;

    const functionCalls: any[] = extractFunctionCalls(data);
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      input.push(...(Array.isArray(data.output) ? data.output : []));
      for (const call of functionCalls) {
        const result: string = await callTool(call?.name);
        input.push({ type: "function_call_output", call_id: call.call_id, output: result });
      }
      continue;
    }

    const content: string = extractOutputText(data);
    return content ? cleanReply(content) : null;
  }

  return null;
}

/**
 * 清洗模型的原始输出，得到可直接发送的纯回复文本：去掉 web_search 附带的
 * 行内引用标记（「[[1]](https://…)」，发到群里既丑又暴露机器人身份）、
 * 首尾空白、包裹的代码块围栏和成对引号，并截断到 Telegram 单条消息上限。
 * 空则返回 null。
 */
function cleanReply(raw: string): string | null {
  let text: string = raw.replace(/\[\[\d+\]\]\([^)\s]*\)/g, "").trim();
  if (!text) return null;

  const fenceMatch = text.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  if (text.length >= 2) {
    const first: string = text[0]!;
    const last: string = text[text.length - 1]!;
    if ((first === '"' && last === '"') || (first === "「" && last === "」") || (first === "“" && last === "”")) {
      text = text.slice(1, -1).trim();
    }
  }

  if (!text) return null;
  return truncateInline(text, TELEGRAM_MESSAGE_MAX_CHARS);
}

/**
 * 把连发模式下模型的输出按行拆成若干条待发送的短消息。
 * 空行丢弃，超出上限的行合并进最后一条，防止刷屏。
 */
function splitReplyParts(reply: string): string[] {
  const lines: string[] = reply
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => !!line);
  if (lines.length <= SPLIT_REPLY_MAX_PARTS) return lines;
  return [...lines.slice(0, SPLIT_REPLY_MAX_PARTS - 1), lines.slice(SPLIT_REPLY_MAX_PARTS - 1).join(" ")];
}

/** 模拟真人打字的间隔：按下一条消息的长度估一个停顿，并加上限。 */
function typingDelayMs(nextPart: string): number {
  const base: number = TYPING_DELAY_BASE_MS + nextPart.length * TYPING_DELAY_PER_CHAR_MS;
  const jitter: number = Math.random() * TYPING_DELAY_JITTER_MS;
  return Math.min(base + jitter, TYPING_DELAY_MAX_MS);
}

/**
 * 在 Grok 生成阶段（耗时不可控，最长可达 REQUEST_TIMEOUT_MS）持续显示
 * 「正在输入…」：立即发一次，此后每隔 TYPING_ACTION_INTERVAL_MS 重发防止过期。
 * 只覆盖生成阶段——连发多条消息之间的停顿单次封顶不超过 Telegram 状态的
 * 过期时间，改由发送循环每次发送后显式补一次 sendTypingAction（见
 * generateAndSendReply），不需要为此另开定时器。
 *
 * 同一 chatId 的并发调用（每群冷却仅 AI_REPLY_COOLDOWN_MS，并不保证互斥，
 * 见 generateAndSendReply 的限频注释）共享同一个定时器，用引用计数管理，
 * 避免各自开一个定时器把「正在输入…」的调用量成倍放大。
 *
 * 一旦某次重发失败（多半是被踢出群、无权限或该操作单独被限流），当场停掉
 * 这个 chatId 的定时器并清除条目，不再对着大概率会持续失败的目标每隔几秒
 * 重试一次。
 * @returns 停止函数：调用后本次占用的引用计数减一，归零时才真正清定时器。
 */
function startTypingHeartbeat(chatId: number): () => void {
  let entry = typingHeartbeats.get(chatId);
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void sendTypingAction(chatId).then((ok: boolean) => {
        if (ok) return;
        // 按 timer 身份核对而非只按 chatId 查表：这次失败可能来自已经停止的
        // 上一代心跳（该 tick 发出时它还活着，回包却晚到了），此时表里
        // 早被换成同一 chatId 的新一代心跳，绝不能把新的也带着清掉。
        const current = typingHeartbeats.get(chatId);
        if (current && current.timer === timer) {
          clearInterval(current.timer);
          typingHeartbeats.delete(chatId);
        }
      });
    }, TYPING_ACTION_INTERVAL_MS);
    entry = { timer, refCount: 0 };
    typingHeartbeats.set(chatId, entry);
    void sendTypingAction(chatId);
  }
  entry.refCount++;

  // 闭包捕获本次拿到的 entry 本体：停止时若表里已换成同一 chatId 的新一代
  // 心跳（本代先因重发失败被清、随后又有新调用开了新的），绝不能把新一代的
  // 引用计数减掉/定时器清掉——和上面重发失败路径按 timer 身份核对是同一个
  // 道理。
  const acquired = entry;
  let released: boolean = false;
  return () => {
    if (released) return;
    released = true;
    const current = typingHeartbeats.get(chatId);
    if (current !== acquired) return; // 本代已因重发失败被提前清掉（表里为空或已是新一代）
    if (--current.refCount <= 0) {
      clearInterval(current.timer);
      typingHeartbeats.delete(chatId);
    }
  };
}

/**
 * 限频黑洞的明确反馈：触发被滑动窗口丢弃时回一句「你们太快了」，而不是
 * 静默失踪让群友以为机器人坏了。提示自身带独立冷却（每群至多一分钟一条，
 * 见 RATE_LIMIT_NOTICE_COOLDOWN_MS），刷屏场景下不会跟着刷。0.5 秒冷却的
 * 丢弃不提示——那只是相邻两次触发的间隔闸，正常聊天就会碰到，提示反而吵。
 */
function notifyRateLimited(chatId: number, now: number): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  void sendMessage(chatId, RATE_LIMIT_NOTICE_TEXT).then((sentMessageId: number | undefined) => {
    if (sentMessageId === undefined) return;
    // 跟其他三处发送一样报回主线程登记自发消息（见 generateAndSendReply 的
    // sendMessage/maybeSendStickerReply 调用）：这条提示同样可能落在频道，
    // 漏报的话频道自回环会被当成新内容，触发一轮不必要的 AI 回复/随机复读。
    self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
    // 也自录进对话缓存——这条提示同样是机器人在群里说的话，不留痕的话
    // 模型不知道自己刚说过「太快了接不过来」，被追问时接不上。
    if (botInfo) {
      recordChatMessage(chatId, botInfo.id, botInfo.first_name, "", RATE_LIMIT_NOTICE_TEXT);
    }
  });
}

/**
 * 生成并发送 AI 回复。整个过程 fire-and-forget，不阻塞本线程的消息分发
 * （限频判定是同步的，其余都在异步任务里跑）。
 * 以 SPLIT_REPLY_PROBABILITY 概率采用「连发多条短消息」形式：让模型按行输出
 * 几条前后衔接的短句，逐条带打字间隔发出（仅第一条引用触发消息）；
 * 其余情况仍是普通的单条回复。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复/@ 触发时用它引用原消息。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机搭话。
 *   这种情况不使用 Telegram 的回复引用（不去 @ 或挂起原消息），改为让模型
 *   在文字里直接点名称呼触发者，更像真人「指名道姓」地插句嘴而非正式回帖。
 * @param mediaComment 若是「解析完图片/贴纸/GIF 后评价它」触发（见
 *   recordChatMedia），发送人与描述——回复指令改为评价，回复引用挂在那条
 *   媒体消息上（replyToMessageId 即那条消息）；冷却/双滑动窗口限频照常
 *   适用，评价触发同样占限频名额。
 */
function generateAndSendReply(
  chatId: number,
  replyToMessageId: number,
  repliedBotText: string | undefined,
  isRandomTrigger: boolean,
  mediaComment?: MediaCommentContext
): void {
  // init 消息在 index.ts 里先于 runner 启动送出，FIFO 保证它先到；走到这里
  // 说明编排被改坏了，丢弃触发并留痕，别让流水线在缺身份的情况下硬跑。
  if (!botInfo) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  const selfInfo: AiBotInfo = botInfo;

  // 每群冷却：在发起任何异步工作之前同步判定并占位，这样冷却窗口内的
  // 并发触发（包括 100% 命中的回复/@ 触发）都会在烧到 API 之前被丢弃。
  const now: number = Date.now();
  if (now - (lastReplyTimes.get(chatId) ?? 0) < AI_REPLY_COOLDOWN_MS) {
    return;
  }

  // 本群 1 分钟 / 5 分钟双重限频：先把各自窗口外的旧触发挤掉，再看余量。
  // 三道闸（冷却 + 两个滑动窗口）都过了才一起落账，避免被拒的触发白白
  // 占用冷却/配额。
  let times: LinkedQueue<number> | undefined = triggerTimes.get(chatId);
  if (!times) {
    times = new LinkedQueue<number>();
    triggerTimes.set(chatId, times);
  }
  while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_WINDOW_MS) {
    times.shift();
  }
  if (times.size >= RATE_LIMIT_MAX_TRIGGERS) {
    notifyRateLimited(chatId, now);
    return;
  }

  let longTimes: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new LinkedQueue<number>();
    longTriggerTimes.set(chatId, longTimes);
  }
  while (longTimes.size > 0 && now - longTimes.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) {
    longTimes.shift();
  }
  if (longTimes.size >= RATE_LIMIT_LONG_MAX_TRIGGERS) {
    notifyRateLimited(chatId, now);
    return;
  }

  lastReplyTimes.set(chatId, now);
  times.push(now);
  longTimes.push(now);

  // 评价回复固定单条：它是对一份媒体的一句点评，拆成连发既不自然也没必要。
  const splitMode: boolean = mediaComment ? false : Math.random() < SPLIT_REPLY_PROBABILITY;

  void (async (): Promise<void> => {
    const latestMessage: BufferedMessage | undefined = getLatestMessage(chatId);
    const addressee: string | undefined = isRandomTrigger && latestMessage ? displayName(latestMessage) : undefined;

    const userContent: string | null = buildUserContent(chatId, selfInfo, { splitMode, repliedBotText, addressee, mediaComment });
    if (!userContent) return;

    // 生成阶段（耗时不可控）用持续重发的心跳显示「正在输入…」，见
    // startTypingHeartbeat；try/finally 保证即使 callGrok 抛异常，
    // 心跳也一定会被停掉。生成结束后（无论成败）就不再需要它——发送阶段
    // 各段之间的停顿改由下面的发送循环逐次显式补一次，见那里的注释。
    const stopTyping: () => void = startTypingHeartbeat(chatId);
    let reply: string | null;
    try {
      reply = await callGrok(userContent);
    } finally {
      stopTyping();
    }
    if (!reply) return;

    // 回复刚生成就先按配置概率给触发消息扣一个应景的标准 emoji 反应（见
    // src/ai/reactions.ts）——放在发送循环之前，连发模式的打字间隔（可能累计
    // 十来秒）才不会把反应也拖到最后，更像真人「先点个反应再慢慢打字」。
    maybeAddReaction(chatId, replyToMessageId, reply);

    // 单条模式下模型偶尔也会换行，此时不该按行拆——原样整条发出。
    const parts: string[] = splitMode ? splitReplyParts(reply) : [reply];
    for (let i: number = 0; i < parts.length; i++) {
      const part: string = parts[i]!;
      // 随机触发不挂 Telegram 回复引用，靠模型在文字里点名（见 addressee）；
      // 回复/@ 触发照旧引用第一条。
      const quoteId: number | undefined = !isRandomTrigger && i === 0 ? replyToMessageId : undefined;
      const sentMessageId: number | undefined = await sendMessage(chatId, part, quoteId);
      // 普通群聊天 Telegram 不会把自己发出去的消息作为更新推送回来，不自录
      // 的话转录里永远缺自己那半边对话。录入后配合 buildUserContent 里的
      // selfIdentity 说明，模型才能在上下文中认出自己说过什么。发送失败的不录。
      if (sentMessageId !== undefined) {
        recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", part);
        // 频道帖是例外：Telegram 会把 channel_post 更新原样推回来，不分是
        // 谁发的。报回主线程登记进自发消息表，供自动流水线识别出这是自己
        // 刚发的、整体跳过，不然会被自己的随机回复再触发一轮（见
        // auto/message.ts 的 isBotOwnMessage）。
        self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
      }
      if (i < parts.length - 1) {
        // sendMessage 刚发出的那条会让 Telegram 清掉「正在输入…」状态（见
        // sendTypingAction 的注释），这里补发一次让下一段开始前重新显示。
        // 单次调用即可覆盖整个停顿——typingDelayMs 封顶在 Telegram 状态的
        // 过期时间内，不需要像生成阶段那样定时重发。
        void sendTypingAction(chatId);
        await sleep(typingDelayMs(parts[i + 1]!));
      }
    }

    // 每次 AI 回复（含随机搭话）后，按配置概率附带发一枚应景的白名单贴纸，
    // 见 src/ai/stickers.ts；发成功的贴纸同样以描述行自录进对话缓存，让模型
    // 知道自己刚发过什么贴纸。
    maybeSendStickerReply(chatId, reply, (stickerDescription: string, stickerMessageId: number) => {
      recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", stickerDescription);
      self.postMessage({ type: "sent", chatId, messageId: stickerMessageId } satisfies AiSentMessage);
    });
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}

self.onmessage = (event: MessageEvent<AiChatWorkerMessage>) => {
  const msg: AiChatWorkerMessage = event.data;
  switch (msg.type) {
    case "init":
      botInfo = msg.botInfo;
      // 白名单贴纸包的目录生成后台启动，不阻塞后续 record/trigger 的处理，
      // 见 ai/stickerCatalog.ts 的 ensureStickerCatalogs；下一条 FIFO 消息
      // （若有）通常是 hydrateStickerCatalog，异步生成天然会先看到已恢复
      // 的条目再继续 diff（见该函数注释）。
      ensureStickerCatalogs(stickerConfig.packs);
      break;
    case "record":
      recordChatMessage(msg.chatId, msg.senderId, msg.firstName, msg.lastName, msg.text);
      break;
    case "recordMedia":
      recordChatMedia(msg);
      break;
    case "trigger":
      generateAndSendReply(msg.chatId, msg.replyToMessageId, msg.repliedBotText, msg.isRandomTrigger);
      break;
    case "hydrate":
      hydrateMemories(msg.memories);
      break;
    case "hydrateStickerCatalog":
      hydrateStickerCatalogs(msg.catalogs);
      break;
    case "flushMemory":
      flushDirtyMemories();
      flushDirtyStickerCatalogs((event: AiStickerCatalogEvent) => self.postMessage(event));
      self.postMessage({ type: "memoryFlushed", flushId: msg.flushId } satisfies AiMemoryFlushedEvent);
      break;
  }
};

// dirty 群的记忆快照 + dirty 的贴纸目录定时上报给主线程（进而落盘），见
// consts/aiChat.ts 的 AI_SNAPSHOT_INTERVAL_MS 注释。Worker 线程活到进程
// 退出为止，不需要引用计数/按需启停，无条目时两个 flush 都直接空转返回。
setInterval(() => {
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent) => self.postMessage(event));
}, AI_SNAPSHOT_INTERVAL_MS);
