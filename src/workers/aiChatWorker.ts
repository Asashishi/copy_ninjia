import { logger } from "../infra/logger";
import { readFileSync } from "node:fs";
import type { Content, FunctionDeclaration, GenerateContentResponse, Part, Tool } from "@google/genai";
import { LinkedQueue } from "../libs/linkedQueue";
import { formatTokyoTime, getCurrentTime } from "../libs/time";
import { sanitizeInline, truncateInline } from "../libs/text";
import {
  buildColdMemoryBlock,
  buildTieredVerbatimTranscript,
  displayBufferedMessageName,
  formatBufferedMessageLine,
} from "../ai/chatTranscript";
import { PERSONA_PATH } from "../consts/paths";
import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  AI_SNAPSHOT_INTERVAL_MS,
  ANIMATION_FALLBACK_PLACEHOLDER,
  ANIMATION_PENDING_PLACEHOLDER,
  CHAT_MEMORY_PRIORITY_INSTRUCTION,
  COMPACT_BATCH_SIZE,
  COMPACTION_MAX_PENDING_PER_CHAT,
  IMAGE_FALLBACK_PLACEHOLDER,
  IMAGE_PENDING_PLACEHOLDER,
  MAX_SUMMARY_ROUNDS,
  MAX_TOOL_ROUNDS,
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
  REPLY_ACTION_INSTRUCTION,
  REPLY_MAX_TOKENS,
  REPLY_TEMPERATURE,
  STICKER_PENDING_PLACEHOLDER,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TEMPERATURE,
  TIME_AWARENESS_INSTRUCTION,
  GEMINI_REPLY_MODEL,
  GEMINI_SUMMARY_MODEL,
  VERBATIM_CONTEXT_MAX,
  WEB_SEARCH_INSTRUCTION,
} from "../consts/aiChat";
import {
  activeReplyChats,
  botInfoState,
  chatBuffers,
  chatSummaries,
  compactionChains,
  compactionPendingCounts,
  dirtyMemoryChats,
  longTriggerTimes,
  pendingSummaries,
  rateLimitNoticeTimes,
} from "../cache/aiChatWorker";
import type { BufferedMessage, MediaKind, ToolDefinition } from "../types";
import { createReplyToolset } from "../ai/tools/replyToolset";
import { startChatActionHeartbeat } from "../ai/chatActionHeartbeat";
import { ensureStickerCatalogs, flushDirtyStickerCatalogs, getCatalogEntry, hydrateStickerCatalogs } from "../ai/stickerCatalog";
import { stickerConfig } from "../ai/stickerConfig";
import { describeMedia } from "../ai/imageDescription";
import { extractFunctionCalls, extractOutputText, isTruncatedByTokenLimit, requestGeminiResponse } from "../ai/gemini";
import { sendMessage } from "../infra/telegram";
import { TOOL_DEFINITIONS, callTool } from "../ai/tools";
import { SEND_MESSAGE_TOOL } from "../consts/tools";
import type {
  AiBotInfo,
  AiChatWorkerMessage,
  AiMemoryEvent,
  AiMemoryFlushedEvent,
  AiMemorySnapshot,
  AiRecordMediaMessage,
  AiSentMessage,
  AiStickerCatalogEvent,
  ExtractedFunctionCall,
  ReplyToolContext,
  ReplyToolset,
} from "../types";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（src/auto/message.ts → aiChat.ts 代理）
 * 只做事件投递，重活全在这里：滚动对话缓存、图片/贴纸/GIF 占位与异步描述
 * 回填、5 分钟滑动窗口限频、拼装上下文、调 Gemini（含 function calling 往返
 * 与内置 googleSearch）。发言/消息反应/应景贴纸全部工具化（send_message /
 * add_reaction / view_sticker_pack + send_sticker，见 ai/tools/replyToolset.ts）：
 * 模型在同一次对话里自主决定做哪几样、什么顺序，本文件只负责组装工具集、
 * 分发调用与最终正文的兜底发送。发往 Telegram 的调用不回
 * 主线程绕路——本线程 import telegram.ts 时会得到自己独立的 grammY Api
 * 客户端（那个 Bot 实例只用其 bot.api 发请求，从不 init/轮询；机器人自己
 * 的账号身份改由主线程在 bot.init() 后经 init 消息注入，见 cache/aiChatWorker.ts
 * 的 botInfoState）。error 日志经 logger.ts 的转发模式回传主线程统一落盘。
 *
 * AI 闲聊回复本体：把本群最近的对话记录喂给 Google 的 Gemini
 * （generateContent 接口，收发细节见 ai/gemini.ts），生成一条人设化回复；
 * 模型可自主使用内置的 googleSearch 服务端工具联网查证。人设文本存放在
 * 仓库根目录的 prompt/persona.md，修改人设不需要碰代码。
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
 * 「当前实际时间：...（东京时间 UTC+9）。」——callGemini 的系统提示词与
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
 * @param username 发言人的公开 username（不含 @，没有则为 undefined）。
 * @param text 消息文本。
 */
function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, username: string | undefined, text: string): void {
  const sanitized: string = sanitizeInline(text);
  if (!sanitized) return;
  const sanitizedUsername: string = sanitizeInline(username ?? "").replace(/^@+/, "");
  pushBufferedMessage(chatId, {
    id,
    firstName: sanitizeInline(firstName),
    lastName: sanitizeInline(lastName),
    ...(sanitizedUsername ? { username: sanitizedUsername } : {}),
    text: sanitized,
    at: formatTokyoTime(Date.now()),
  });
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
        ...(msg.username ? { username: sanitizeInline(msg.username).replace(/^@+/, "") } : {}),
        text: composeMediaText(resolvedTagFor("sticker", catalogEntry.description), sanitizedCaption),
        at: formatTokyoTime(Date.now()),
      };
      pushBufferedMessage(msg.chatId, entry);
      if (msg.commentOnResolve) {
        generateAndSendReply(msg.chatId, msg.messageId, undefined, false, { kind: "sticker", senderName: displayBufferedMessageName(entry), description: catalogEntry.description });
      }
      return;
    }
  }

  const entry: BufferedMessage = {
    id: msg.senderId,
    firstName: sanitizeInline(msg.firstName),
    lastName: sanitizeInline(msg.lastName),
    ...(msg.username ? { username: sanitizeInline(msg.username).replace(/^@+/, "") } : {}),
    text: composeMediaText(pendingPlaceholderFor(msg.kind), sanitizedCaption),
    at: formatTokyoTime(Date.now()),
  };
  pushBufferedMessage(msg.chatId, entry);
  // describeMedia 内部兜住一切异常只返回 null，这条异步链不会 reject；
  // 同一份媒体按 file_unique_id 去重，不同媒体则经过全局有界执行器，避免
  // 洪峰同时启动无界的下载、转码和视觉请求。
  void describeMedia(msg.kind, msg.fileId, msg.fileUniqueId).then((description: string | null) => {
    entry.text = composeMediaText(description ? resolvedTagFor(msg.kind, description) : fallbackTextFor(msg.kind, msg), sanitizedCaption);
    // 条目内容变了，重新标 dirty 让下一轮快照把回填后的文本落盘。
    dirtyMemoryChats.add(msg.chatId);
    if (msg.commentOnResolve && description) {
      generateAndSendReply(msg.chatId, msg.messageId, undefined, false, { kind: msg.kind, senderName: displayBufferedMessageName(entry), description });
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
  const pendingCount: number = compactionPendingCounts.get(chatId) ?? 0;
  if (pendingCount >= COMPACTION_MAX_PENDING_PER_CHAT) {
    logger.error(
      `AI compaction backlog reached ${COMPACTION_MAX_PENDING_PER_CHAT} tasks for chat ${chatId}; ` +
      `dropping one ${mirrorBatch.length}-message batch to keep memory bounded.`
    );
    return;
  }

  const prev: Promise<void> = compactionChains.get(chatId) ?? Promise.resolve();
  const next: Promise<void> = prev.then(() => rotateCompaction(chatId, mirrorBatch, promoteFirst));
  compactionPendingCounts.set(chatId, pendingCount + 1);
  compactionChains.set(chatId, next);
  void next.then(
    () => finishCompactionTask(chatId, next),
    () => finishCompactionTask(chatId, next)
  );
}

/** 完成任务后释放计数；只有当前链尾本人完成时才删除链，不能误删后继任务。 */
function finishCompactionTask(chatId: number, completed: Promise<void>): void {
  const remaining: number = Math.max(0, (compactionPendingCounts.get(chatId) ?? 1) - 1);
  if (remaining === 0) compactionPendingCounts.delete(chatId);
  else compactionPendingCounts.set(chatId, remaining);
  if (compactionChains.get(chatId) === completed) {
    compactionChains.delete(chatId);
  }
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

/** 把某群当前的滚动缓存 + 中期摘要 + 待晋升摘要序列化成一份可落盘的快照
 *  JSON 文本。stringify 只在这里做一次：此后「Worker -> 主线程 ->
 *  diskIOWorker」两跳 postMessage 克隆的都是字符串（近乎 memcpy，对象图
 *  则要走两次深克隆），落盘端原样写文件、不再重复序列化（见
 *  types/aiChat.ts 的 AiMemoryEvent.snapshot）。缩进固定 2 空格，与磁盘
 *  文件历史格式逐字节一致。 */
function buildMemorySnapshot(chatId: number): string {
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const snapshot: AiMemorySnapshot = {
    version: 1,
    buffer: buf ? buf.last(buf.size) : [],
    summaries: summaryQueue ? summaryQueue.last(summaryQueue.size) : [],
    pendingSummary: pendingSummaries.get(chatId) ?? null,
    savedAt: Date.now(),
  };
  return JSON.stringify(snapshot, null, 2);
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
function hydrateMemories(memories: Map<number, string>): void {
  for (const [chatId, snapshotJson] of memories) {
    if (chatBuffers.has(chatId)) continue;

    // 快照全程以序列化 JSON 文本流转（见 types/aiChat.ts），这里是整条
    // 管线唯一的解析点。文本只出自 buildMemorySnapshot 的 stringify 或
    // 启动恢复时逐字段重建后的重新 stringify，形状可信；解析失败按防御
    // 性丢弃处理，不让一份坏快照拦下其余群的恢复。
    let snapshot: AiMemorySnapshot;
    try {
      snapshot = JSON.parse(snapshotJson) as AiMemorySnapshot;
    } catch (error: unknown) {
      logger.error(`Failed to parse hydrated AI memory snapshot for chat ${chatId}, skipping it:`, error);
      continue;
    }

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
 * 调 Gemini 把一批冷消息压缩成一条摘要。走独立的中性总结提示词（不带
 * 人设、不带工具），产出压成单行并截断——摘要虽是模型生成的，但源头是
 * 用户文本，保持「一行一条」的转录结构，多行伪造向量在这里同样失效。
 */
async function summarizeBatch(batch: BufferedMessage[]): Promise<string | null> {
  const selfNote: string = botInfoState.current
    ? `注意：[id:${botInfoState.current.id}] 是群里的聊天机器人「${botInfoState.current.first_name}」本人的发言，摘要里请以「${botInfoState.current.first_name}」称呼它。\n\n`
    : "";
  const data: GenerateContentResponse | null = await requestGeminiResponse(
    {
      model: GEMINI_SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: selfNote + batch.map(formatBufferedMessageLine).join("\n") }] }],
      config: {
        systemInstruction: currentTimeSentence() + SUMMARY_SYSTEM_PROMPT,
        temperature: SUMMARY_TEMPERATURE,
        maxOutputTokens: SUMMARY_MAX_TOKENS,
      },
    },
    "Gemini summarize API"
  );
  if (!data) return null;
  const sanitized: string = sanitizeInline(extractOutputText(data));
  if (!sanitized) return null;
  return truncateInline(sanitized, SUMMARY_MAX_CHARS);
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
  /** 若本次是「用户回复了机器人」，被回复的那条机器人消息文本，作为上下文
   *  （机器人自己发的消息不会作为更新推送回来，不在缓存里）。 */
  repliedBotText?: string;
  /** 是否是随机插话触发（见 generateAndSendReply 的 isRandomTrigger）：
   *  没有人在叫机器人，模型自主决定接不接话、怎么接（挂不挂 reply_to_trigger、
   *  要不要称呼对方都由它判断），也允许什么都不做保持沉默。 */
  isRandomTrigger: boolean;
  /** 若本次是「解析完图片/贴纸/GIF 后评价它」触发（见 recordChatMedia），
   *  发送人与描述——回复指令改为针对这份媒体发表评价，替代默认的「接住
   *  最新消息」。 */
  mediaComment?: MediaCommentContext;
}

/**
 * 把某群的对话上下文拼装成给模型的用户消息内容：先声明记忆优先级，再放
 * 冷记忆摘要段（若有，最多 MAX_SUMMARY_ROUNDS 轮，从旧到新），最后把逐字
 * 缓存拆成「较早原文」与「最新 COMPACT_BATCH_SIZE 条最热记忆」两层；
 * 越热越靠近回复指令。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 cache/aiChatWorker.ts 的 botInfoState），用于转录里的自我认知。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
function buildUserContent(chatId: number, selfInfo: AiBotInfo, options: UserContentOptions): string | null {
  const { repliedBotText, isRandomTrigger, mediaComment } = options;
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  const transcript: string = buildTieredVerbatimTranscript(recent);
  const trailingContext: string[] = [];
  if (repliedBotText) {
    // 同样压成单行：这段文本虽是机器人自己说过的话，保持转录「一行一条」的
    // 结构不变即可杜绝任何多行伪造的可能。
    trailingContext.push(`（你刚才说过：${sanitizeInline(repliedBotText)}）`);
  }

  // 按触发类型给引导，行动说明（REPLY_ACTION_INSTRUCTION）统一拼在最后：
  // 发言/贴纸/反应全部工具化，做什么、什么顺序由模型自己决定（见
  // ai/tools/replyToolset.ts）。
  // - 媒体评价：针对刚解析完的那份图片/贴纸/GIF 发表评价，要求挂回复引用；
  //   实在无话可评也允许沉默。
  // - 随机插话：没有人在叫机器人，接不接、怎么接（挂不挂 reply_to_trigger、
  //   要不要称呼对方）全由模型自主判断——触发者是谁转录最后一行本来就写着，
  //   不再单独喂名字、不再强制点名。
  // - 回复/@ 触发：对方明确在跟机器人说话，别已读不回，建议第一条挂引用。
  const replyInstruction: string = mediaComment
    ? `刚才 ${mediaComment.senderName} 在群里发了${mediaNounFor(mediaComment.kind)}，内容是：「${mediaComment.description}」（聊天记录里对应「${mediaTagHintFor(mediaComment.kind)}」那行）。请以你的人设，针对这份内容本身发表一两句评价/吐槽/调侃——自然一点，不要机械复述描述，也不要提"描述"两个字。第一条消息请把 reply_to_trigger 设为 true，让评价以「回复」形式挂在那条消息上；实在觉得无话可评，也可以什么都不做。${REPLY_ACTION_INSTRUCTION}`
    : isRandomTrigger
    ? `群里最新这条消息并没有人在叫你——只是你自己刷到了，要不要插一嘴完全由你判断：值得接就以你的人设自然接住话题（要不要挂 reply_to_trigger、要不要在文字里称呼对方，都按怎么自然怎么来）；话题跟你无关、没什么好说的，就什么都不做直接结束，别硬聊。${REPLY_ACTION_INSTRUCTION}`
    : `请针对最新这条消息，以你的人设自然接住话题——通常一到两句话就够，想连发几条短句也随你。对方是在跟你说话，别已读不回；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。${REPLY_ACTION_INSTRUCTION}`;

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 cache/aiChatWorker.ts 的 botInfoState），不写死在代码里。
  const selfIdentity: string =
    `你在这个群里的 Telegram 账号是 @${selfInfo.username}（[id:${selfInfo.id}]）：` +
    `记录里标着这个 id 的行是你自己之前说过的话，别把它们当成别人的发言；` +
    `消息里 @ 这个用户名、或回复你的消息，都是在跟你说话。`;

  // 冷记忆段：更早的历史按每轮 COMPACT_BATCH_SIZE 条压缩成摘要（从旧到
  // 新），作为必须结合理解的长期背景，只在判断当前状态时低于较新的逐字
  // 记录；摘要行不会被误当成逐字聊天记录。摘要入队时已压成单行（见
  // summarizeBatch），「一行一条」的防伪造结构同样成立。
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string = buildColdMemoryBlock(summaries);
  const trailingBlock: string = trailingContext.length > 0
    ? "\n\n【回复引用补充】\n" + trailingContext.join("\n")
    : "";

  return (
    CHAT_MEMORY_PRIORITY_INSTRUCTION +
    "\n" +
    selfIdentity +
    "\n\n" +
    summaryBlock +
    transcript +
    trailingBlock +
    "\n\n" +
    replyInstruction
  );
}

/**
 * 调用 Gemini 的 generateContent 接口跑完一轮回复对话（收发与响应解析在
 * ai/gemini.ts）。tools 带三类：内置的 googleSearch（Google 服务器侧自动
 * 执行，模型自主决定要不要联网查证）+ src/ai/tools 里的静态自定义函数（目前
 * 是查东京天气）+ 按次回复现组装的行动工具集（发言/反应/两层贴纸，见
 * ai/tools/replyToolset.ts——发消息、发贴纸这些副作用动作都在工具执行时当场发生，
 * 不再等最终文本）。自定义函数由模型以 functionCall part 抛回来，执行后把
 * 上一轮模型的整个 content 原样接回 contents、附上 functionResponse 再续跑
 * （content 里的 thought signature 也要一并带回，缺了会丢思考上下文），
 * 直到模型不再要工具或达到轮数上限。查时间不走工具：当前时间默认拼进每次
 * 请求的系统提示词（见下方），转录行也自带每条消息的发送时间（见
 * ai/chatTranscript.ts 的 formatBufferedMessageLine）。
 * @param userContent buildUserContent 拼好的对话上下文。
 * @param toolset 本轮回复的行动工具集（见 createReplyToolset），工具的执行
 *   副作用（发消息/贴纸/反应）都发生在它内部。
 * @returns 模型最后一轮的正文文本（正常情况下模型已通过工具把话说完、正文
 *   为空）；请求失败、超时、被 token 上限腰斩或空输出时返回 null。调用方
 *   只在模型一条消息都没发出去时才把它当兜底回复用。
 */
async function callGemini(userContent: string, toolset: ReplyToolset): Promise<string | null> {
  // 每次请求现查当前时间拼进系统提示词（而非用模块加载时算好的值），worker
  // 线程常驻、一跑就是几天，缓存的时间会很快过期。
  const systemPrompt: string = `${SYSTEM_PROMPT}\n\n${currentTimeSentence()}${TIME_AWARENESS_INSTRUCTION}\n\n${WEB_SEARCH_INSTRUCTION}`;
  const contents: Content[] = [{ role: "user", parts: [{ text: userContent }] }];

  const functionDeclarations: ToolDefinition[] = [...TOOL_DEFINITIONS, ...toolset.definitions];
  const sdkDeclarations: FunctionDeclaration[] = functionDeclarations.map((definition: ToolDefinition) => ({
    name: definition.name,
    description: definition.description,
    parametersJsonSchema: definition.parameters,
  }));
  const tools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: sdkDeclarations }];

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data: GenerateContentResponse | null = await requestGeminiResponse(
      {
        model: GEMINI_REPLY_MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools,
          // 内置 googleSearch 与自定义函数混用同一次请求时 API 硬性要求开
          // 这个开关（不开直接 400）。开了之后服务端工具的执行记录会以
          // toolCall/toolResponse part 的形式混进 content——它们不是
          // functionCall part，extractFunctionCalls 不会误当成待执行的
          // 自定义函数；多轮往返时随整个 content 原样接回即可（实测确认）。
          toolConfig: { includeServerSideToolInvocations: true },
          temperature: REPLY_TEMPERATURE,
          maxOutputTokens: REPLY_MAX_TOKENS,
        },
      },
      "Gemini API"
    );
    if (!data) return null;

    const functionCalls: ExtractedFunctionCall[] = extractFunctionCalls(data);
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      // 模型这一轮的 content 原样接回（缺了 thought signature 会丢思考
      // 上下文），随后所有函数结果合并成一个 user turn 的 functionResponse
      // parts 喂回去。同一轮的多个调用按序执行——模型并行抛出「先发言后
      // 贴纸」时，落地顺序与它给出的顺序一致。
      const modelContent: Content | undefined = data.candidates?.[0]?.content;
      if (!modelContent) return null;
      contents.push(modelContent);
      const responseParts: Part[] = [];
      for (const call of functionCalls) {
        const result: string = toolset.has(call.name)
          ? await toolset.execute(call.name, JSON.stringify(call.args ?? {}))
          : await callTool(call.name);
        // 工具实现返回的都是 JSON 字符串（见 src/ai/tools），
        // functionResponse.response 要求对象，解析回来直接挂上。
        responseParts.push({ functionResponse: { id: call.id, name: call.name, response: JSON.parse(result) } });
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    // 写到一半被 maxOutputTokens 腰斩的半句话，宁可不要，也不把断掉的句子
    // 当兜底回复发到群里——真人不会发一半句子就没下文，见 ai/gemini.ts 的
    // isTruncatedByTokenLimit。googleSearch 命中时尤其容易撞进这种情况。
    if (isTruncatedByTokenLimit(data)) return null;

    return extractOutputText(data) || null;
  }

  return null;
}

/**
 * 限频黑洞的明确反馈：触发被滑动窗口丢弃时回一句「你们太快了」，而不是
 * 静默失踪让群友以为机器人坏了。提示自身带独立冷却（每群至多一分钟一条，
 * 见 RATE_LIMIT_NOTICE_COOLDOWN_MS），刷屏场景下不会跟着刷。同群已有一轮
 * 在途（activeReplyChats）的丢弃不提示——那只是同群串行闸，正常聊天就会
 * 碰到，提示反而吵。
 */
function notifyRateLimited(chatId: number, now: number): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  void sendMessage(chatId, RATE_LIMIT_NOTICE_TEXT).then((sentMessageId: number | undefined) => {
    if (sentMessageId === undefined) return;
    // 跟其他几处发送一样报回主线程登记自发消息（见 generateAndSendReply 的
    // sendMessage 调用、callGemini 的 onStickerSent 回调）：这条提示同样可能
    // 落在频道，漏报的话频道自回环会被当成新内容，触发一轮不必要的 AI
    // 回复/随机复读。
    self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
    // 也自录进对话缓存——这条提示同样是机器人在群里说的话，不留痕的话
    // 模型不知道自己刚说过「太快了接不过来」，被追问时接不上。
    if (botInfoState.current) {
      recordChatMessage(chatId, botInfoState.current.id, botInfoState.current.first_name, "", botInfoState.current.username, RATE_LIMIT_NOTICE_TEXT);
    }
  });
}

/**
 * 生成并执行一轮 AI 回复。整个过程 fire-and-forget，不阻塞本线程的消息分发
 * （限频判定是同步的，其余都在异步任务里跑）。
 * 发言/贴纸/反应全部工具化（见 ai/tools/replyToolset.ts）：回不回、发单条还是
 * 像真人那样连发几条短句、配不配贴纸、扣不扣反应、挂不挂回复引用，都由模型
 * 在工具对话里自主决定，副作用在工具执行时当场发生；这里只组装工具集与回调，
 * 外加对「对方明确在跟机器人说话」的直接触发保留一道正文兜底（见函数尾注释）。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID：add_reaction 的目标；模型给
 *   send_message 传 reply_to_trigger: true 时的回复引用目标。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机插话。
 *   这种情况完全交给模型自主：接不接话、怎么接（挂不挂引用、要不要称呼对方）
 *   都由它判断，允许什么都不做保持沉默——所以也不做正文兜底。
 * @param mediaComment 若是「解析完图片/贴纸/GIF 后评价它」触发（见
 *   recordChatMedia），发送人与描述——回复指令改为评价，回复引用挂在那条
 *   媒体消息上（replyToMessageId 即那条消息）；5 分钟窗口限频照常适用，
 *   评价触发同样占限频名额。
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
  if (!botInfoState.current) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  // 同一群只跑一轮工具对话。Gemini 请求可持续几十秒；并发跑的话后发请求
  // 可能先结束并先发消息，旧请求随后再按过时上下文补发，工具副作用也会
  // 倒序。这里同步占位，媒体评价/随机插话/回复触发统一受控；在途期间的
  // 并发触发直接丢弃、不入队。这道串行闸同时就是短时爆发的天然节流——
  // 曾经的 0.5 秒冷却和 1 分钟窗口因此几乎从不命中，已移除（见
  // consts/aiChat.ts 的 RATE_LIMIT_LONG_WINDOW_MS 注释）。
  if (activeReplyChats.has(chatId)) return;
  const selfInfo: AiBotInfo = botInfoState.current;

  // 本群 5 分钟滑动窗口限频：先把窗口外的旧触发挤掉，再看余量。占位闸和
  // 限频闸都过了才落账，避免被拒的触发白白占用配额。
  const now: number = Date.now();
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

  longTimes.push(now);
  activeReplyChats.add(chatId);

  void (async (): Promise<void> => {
    try {
      const userContent: string | null = buildUserContent(chatId, selfInfo, { repliedBotText, isRandomTrigger, mediaComment });
      if (!userContent) return;

    // 心跳的生命周期覆盖整轮工具对话（生成耗时不可控，发送也发生在工具
    // 执行里），但从 idle 挡起步：生成/思考期间不亮状态，「正在输入/选择
    // 贴纸…」只在具体动作临发前由工具执行路径拉起有界窗口（见
    // ai/tools/replyToolset.ts 与 stickers.ts）——模型整轮沉默（随机插话
    // 不接话/只扣反应）时全程无感，不会留下等不来消息的假输入状态。
    // try/finally 保证即使 createReplyToolset/callGemini 抛异常，心跳也
    // 一定会被停掉。
      const heartbeat = startChatActionHeartbeat(chatId);
      try {
    // 工具执行成功后的回调：发出去的每条消息/贴纸描述行都自录进对话缓存
    // （普通群聊天 Telegram 不会把自己发出去的消息作为更新推送回来，不自录
    // 的话转录里永远缺自己那半边对话；配合 buildUserContent 里的 selfIdentity
    // 说明，模型才能在上下文中认出自己说过什么），消息 ID 报回主线程登记
    // 自发消息（频道帖例外：channel_post 更新会原样推回来，登记后自动流水线
    // 才能识别出是自己刚发的、整体跳过，见 auto/message.ts 的 isBotOwnMessage）。
        const ctx: ReplyToolContext = {
          chatId,
          replyToMessageId,
          chatAction: heartbeat,
          onMessageSent: (text: string, messageId: number): void => {
            recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", selfInfo.username, text);
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
          },
          onStickerSent: (stickerDescription: string, messageId: number): void => {
            recordChatMessage(chatId, selfInfo.id, selfInfo.first_name, "", selfInfo.username, stickerDescription);
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
          },
        };
        const toolset: ReplyToolset = await createReplyToolset(ctx);
        const finalText: string | null = await callGemini(userContent, toolset);

        // 正文兜底只保留给「对方明确在跟机器人说话」的直接触发（回复/@）。
        // 放在心跳停止之前：兜底走同一条 send_message 工具路径，照样有临发
        // 前的「正在输入…」窗口，发出后挡位随之切回 idle。
        if (finalText && !isRandomTrigger && !mediaComment && toolset.messagesSent() === 0) {
          await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: finalText, reply_to_trigger: true }));
        }
      } finally {
        // 先停表再等本代所有在途状态请求落定，避免异常中断时仍有迟到请求
        // 在任务结束后重新显示「正在输入/选择贴纸…」。
        await heartbeat.stop();
      }
    } finally {
      activeReplyChats.delete(chatId);
    }
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}

self.onmessage = (event: MessageEvent<AiChatWorkerMessage>) => {
  const msg: AiChatWorkerMessage = event.data;
  switch (msg.type) {
    case "init":
      botInfoState.current = msg.botInfo;
      // 白名单贴纸包的目录生成后台启动，不阻塞后续 record/trigger 的处理，
      // 见 ai/stickerCatalog.ts 的 ensureStickerCatalogs；下一条 FIFO 消息
      // （若有）通常是 hydrateStickerCatalog，异步生成天然会先看到已恢复
      // 的条目再继续 diff（见该函数注释）。
      ensureStickerCatalogs(stickerConfig.packs);
      break;
    case "record":
      recordChatMessage(msg.chatId, msg.senderId, msg.firstName, msg.lastName, msg.username, msg.text);
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
  const now: number = Date.now();
  for (const [chatId, times] of longTriggerTimes) {
    while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) times.shift();
    if (times.size === 0) longTriggerTimes.delete(chatId);
  }
  for (const [chatId, at] of rateLimitNoticeTimes) {
    if (now - at >= RATE_LIMIT_NOTICE_COOLDOWN_MS) rateLimitNoticeTimes.delete(chatId);
  }
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent) => self.postMessage(event));
}, AI_SNAPSHOT_INTERVAL_MS);
